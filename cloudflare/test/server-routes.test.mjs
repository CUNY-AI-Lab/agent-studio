// Route-level coverage for the Hono app exported by src/server.ts.
//
// These exercise the real app.fetch() pipeline (session middleware + route
// handlers) against in-memory R2 and WorkspaceAgent doubles — see
// helpers/env.mjs for the doubles and the cloudflare:* stub loader that lets
// server.ts import under the plain tsx test loader.
//
// Notes on observed behavior (asserted below):
//   * Routes that validate with `zod.parse()` rely on the app-level onError
//     handler to map ZodError to a 400. The invalid-body tests below cover
//     that mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  importServer,
  makeEnv,
  openSession,
  Session,
  makeImportBundle,
  seedGalleryItem,
} from './helpers/env.mjs';
import {
  CAIL_IDENTITY_AUDIENCE,
  CAIL_IDENTITY_HEADER,
} from '../src/lib/cail-identity.ts';
import { resetCailModelsCache } from '../src/lib/cail-models.ts';
import { galleryOwnerTag } from '../src/lib/gallery.ts';

const app = await importServer();

const JSON_HEADERS = { 'content-type': 'application/json' };

function jsonInit(method, body) {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function createWorkspace(session, name = 'Workspace') {
  const res = await session.request(app, '/api/workspaces', jsonInit('POST', { name }));
  assert.equal(res.status, 201);
  return (await res.json()).workspace;
}

async function makeRouteCredential(overrides = {}) {
  const kid = 'route-key';
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({
    sub: 'cail-route-test',
    aud: CAIL_IDENTITY_AUDIENCE,
    iss: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    exp: Math.floor(Date.now() / 1000) + 3600,
    entitlements: ['tools', 'agent-studio'],
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .sign(privateKey);
  return { token, jwks: JSON.stringify({ keys: [publicJwk] }) };
}

// ---------------------------------------------------------------------------
// Session / middleware at the route level
// ---------------------------------------------------------------------------

test('health check is public and needs no session', async () => {
  const { env } = makeEnv();
  const res = await app.fetch(new Request('https://studio.test/health'), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'agent-studio' });
});

test('health check reports unhealthy when SESSION_SECRET is missing', async () => {
  const { env } = makeEnv();
  delete env.SESSION_SECRET;
  const res = await app.fetch(new Request('https://studio.test/health'), env, {});
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    ok: false,
    service: 'agent-studio',
    error: 'configuration_invalid',
    errorCode: 'session_secret_missing',
  });
});

test('health check reports unhealthy when telemetry environment is unclassified', async () => {
  const { env } = makeEnv();
  delete env.CAIL_LOG_ENV;
  const res = await app.fetch(new Request('https://studio.test/health'), env, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errorCode, 'cail_log_environment_missing');
});

test('health check reports unhealthy when Worker version metadata is unavailable', async () => {
  const { env } = makeEnv();
  delete env.CF_VERSION_METADATA;
  const res = await app.fetch(new Request('https://studio.test/health'), env, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errorCode, 'worker_version_metadata_missing');
});

test('startup guard refuses application traffic when SESSION_SECRET is missing', async () => {
  const { env } = makeEnv();
  delete env.SESSION_SECRET;
  const res = await app.fetch(new Request('https://studio.test/api/session'), env, {});
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: 'Service unavailable: invalid configuration',
    errorCode: 'session_secret_missing',
  });
});

test('startup guard refuses enforced identity without migration-window configuration', async () => {
  const { env } = makeEnv();
  env.CAIL_REQUIRE_IDENTITY = 'true';
  const res = await app.fetch(new Request('https://studio.test/api/session'), env, {});
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: 'Service unavailable: invalid configuration',
    errorCode: 'cail_sso_switched_at_missing',
  });
});

test('no cookie -> a signed session cookie is issued and reused', async () => {
  const { env } = makeEnv();
  const session = new Session(env);

  const first = await session.request(app, '/api/session');
  assert.equal(first.status, 200);
  const { sessionId } = await first.json();
  assert.match(sessionId, /^[a-f0-9]{32}$/);
  assert.ok(session.cookie, 'cookie issued on first request');

  // The carried cookie yields the same session id (stable identity).
  const second = await session.request(app, '/api/session');
  assert.equal((await second.json()).sessionId, sessionId);
});

test('garbage cookie -> fresh session, never a 500', async () => {
  const { env } = makeEnv();
  const session = new Session(env);
  session.cookie = 'agent-studio-session=not.a-valid-signed-value';

  const res = await session.request(app, '/api/session');
  assert.equal(res.status, 200);
  const { sessionId } = await res.json();
  assert.match(sessionId, /^[a-f0-9]{32}$/);
  // A new signed cookie was minted to replace the garbage one.
  assert.ok(session.cookie);
  assert.notEqual(session.cookie, 'agent-studio-session=not.a-valid-signed-value');
});

test('verified canonical token is stored and forwarded to the workspace agent', async () => {
  const { env, agents } = makeEnv();
  const { token, jwks } = await makeRouteCredential();
  env.CAIL_IDENTITY_JWKS = jwks;
  env.CAIL_REQUIRE_IDENTITY = 'true';
  env.CAIL_SSO_SWITCHED_AT = new Date(Date.now() - 60_000).toISOString();
  env.CAIL_ACCOUNT_IMPORT_UNTIL = new Date(Date.now() + 60_000).toISOString();
  const headers = { [CAIL_IDENTITY_HEADER]: token };
  const session = new Session(env);

  const sessionRes = await session.request(app, '/api/session', { headers });
  assert.equal(sessionRes.status, 200);
  const createRes = await session.request(
    app,
    '/api/workspaces',
    { ...jsonInit('POST', { name: 'Authenticated workspace' }), headers },
  );
  assert.equal(createRes.status, 201);

  const agent = [...agents.values()][0];
  assert.ok(agent);
  assert.equal(agent.credential, token);
});

test('required identity rejects an invalid canonical credential', async () => {
  const { env } = makeEnv();
  env.CAIL_IDENTITY_JWKS = JSON.stringify({ keys: [] });
  env.CAIL_REQUIRE_IDENTITY = 'true';
  env.CAIL_SSO_SWITCHED_AT = new Date(Date.now() - 60_000).toISOString();
  env.CAIL_ACCOUNT_IMPORT_UNTIL = new Date(Date.now() + 60_000).toISOString();
  const session = new Session(env);
  const res = await session.request(app, '/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: 'invalid-token' },
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'authentication_required');
});

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

test('workspace lifecycle: create -> list -> get -> patch -> delete', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);

  // create
  const created = await createWorkspace(session, 'First');
  assert.match(created.id, /\S/);
  assert.equal(created.name, 'First');
  // record persisted to R2 under the session namespace
  assert.equal(
    r2.keysWithPrefix(`agent-studio/sessions/${sessionId}/workspaces/${created.id}/workspace.json`).length,
    1,
  );

  // list
  const listRes = await session.request(app, '/api/workspaces');
  assert.equal(listRes.status, 200);
  const { workspaces } = await listRes.json();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].id, created.id);

  // get (full snapshot bundle)
  const getRes = await session.request(app, `/api/workspaces/${created.id}`);
  assert.equal(getRes.status, 200);
  const detail = await getRes.json();
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['agent', 'downloads', 'files', 'messages', 'runtime', 'state', 'workspace'],
  );
  assert.equal(detail.workspace.id, created.id);
  assert.equal(detail.agent.name, `${sessionId}-${created.id}`);

  // patch title + description
  const patchRes = await session.request(
    app,
    `/api/workspaces/${created.id}`,
    jsonInit('PATCH', { name: 'Renamed', description: 'new desc' }),
  );
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).workspace;
  assert.equal(patched.name, 'Renamed');
  assert.equal(patched.description, 'new desc');
  assert.notEqual(patched.updatedAt, created.updatedAt);

  // delete
  const delRes = await session.request(app, `/api/workspaces/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { success: true });

  // gone
  const goneRes = await session.request(app, `/api/workspaces/${created.id}`);
  assert.equal(goneRes.status, 404);
  const emptyList = await (await session.request(app, '/api/workspaces')).json();
  assert.equal(emptyList.workspaces.length, 0);
});

test('DELETE workspace succeeds even if workspace sync would fail', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Broken Hydration');
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  const syncCountBeforeDelete = agent.syncCount;
  agent.syncWorkspace = async () => {
    throw new Error('simulated hydration failure');
  };

  const delRes = await session.request(app, `/api/workspaces/${workspace.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { success: true });
  assert.equal(agent.syncCount, syncCountBeforeDelete);

  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.deepEqual(list.workspaces, []);
});

test('DELETE workspace removes its separate runtime R2 prefix', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Runtime Cleanup');
  const runtimeKey = `agent-studio/runtime/${sessionId}-${workspace.id}/foo.txt`;
  await r2.put(runtimeKey, 'orphan candidate');
  assert.ok(await r2.get(runtimeKey));

  const res = await session.request(app, `/api/workspaces/${workspace.id}`, { method: 'DELETE' });

  assert.equal(res.status, 200);
  assert.equal(await r2.get(runtimeKey), null);
});

test('GET missing workspace id -> 404', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const res = await session.request(app, '/api/workspaces/deadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Workspace not found' });
});

test('GET malformed workspace id -> 400 (AS-3-6 boundary check)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  // Too short, wrong charset, and a traversal-ish string are all off-shape.
  for (const bad of ['nope', '../secret', 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', 'deadbeef']) {
    const res = await session.request(app, `/api/workspaces/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `expected 400 for id "${bad}"`);
    assert.deepEqual(await res.json(), { error: 'Invalid workspace id' });
  }
});

test('non-POST /api/workspaces/import is treated as a missing workspace', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Existing');

  const getRes = await session.request(app, '/api/workspaces/import');
  assert.equal(getRes.status, 404);
  assert.deepEqual(await getRes.json(), { error: 'Workspace not found' });

  const patchRes = await session.request(
    app,
    '/api/workspaces/import',
    jsonInit('PATCH', { name: 'x' }),
  );
  assert.equal(patchRes.status, 404);
  assert.deepEqual(await patchRes.json(), { error: 'Workspace not found' });

  const deleteRes = await session.request(app, '/api/workspaces/import', { method: 'DELETE' });
  assert.equal(deleteRes.status, 404);
  assert.deepEqual(await deleteRes.json(), { error: 'Workspace not found' });

  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.deepEqual(list.workspaces.map((entry) => entry.id), [workspace.id]);
  assert.deepEqual(
    r2.keysWithPrefix(`agent-studio/sessions/${sessionId}/workspaces/`)
      .filter((key) => key.includes('/undefined/') || key.includes('/import/')),
    [],
  );
});

test('cross-session isolation: session B cannot see session A workspace', async () => {
  const { env } = makeEnv();
  const a = new Session(env);
  const b = new Session(env);
  await a.request(app, '/api/session');
  await b.request(app, '/api/session');

  const workspace = await createWorkspace(a, 'A-only');

  const crossGet = await b.request(app, `/api/workspaces/${workspace.id}`);
  assert.equal(crossGet.status, 404, "B must not read A's workspace");

  const bList = await (await b.request(app, '/api/workspaces')).json();
  assert.equal(bList.workspaces.length, 0);

  // A still sees it.
  const aList = await (await a.request(app, '/api/workspaces')).json();
  assert.equal(aList.workspaces.length, 1);
});

test('create with invalid body returns 400 (ZodError mapped by onError)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  // name must be a non-empty trimmed string; empty string fails min(1).
  const res = await session.request(app, '/api/workspaces', jsonInit('POST', { name: '' }));
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test('files: PUT -> GET (content-type) -> list -> DELETE', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  // write
  const putRes = await session.request(app, `/api/workspaces/${workspace.id}/files/notes.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
    body: '# Hello',
  });
  assert.equal(putRes.status, 200);
  assert.equal((await putRes.json()).filePath, 'notes.md');

  // list
  const listRes = await session.request(app, `/api/workspaces/${workspace.id}/files`);
  assert.equal(listRes.status, 200);
  const { files } = await listRes.json();
  assert.deepEqual(files.map((f) => f.path), ['notes.md']);

  // fetch content with content-type preserved
  const getRes = await session.request(app, `/api/workspaces/${workspace.id}/files/notes.md`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await getRes.text(), '# Hello');

  // delete
  const delRes = await session.request(app, `/api/workspaces/${workspace.id}/files/notes.md`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 200);

  const goneRes = await session.request(app, `/api/workspaces/${workspace.id}/files/notes.md`);
  assert.equal(goneRes.status, 404);
});

test('files: GET content-type falls back to extension mime when the agent stores octet-stream', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  // Force the runtime into the same shape as a binary write with no known type:
  // an octet-stream entry. The GET route derives the mime from the extension
  // (getMimeType) only when the stored contentType is falsy, so seed it empty
  // directly on the agent double to exercise that fallback branch.
  // The create route already resolved and synced this agent.
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  agent.files.set('data.json', { bytes: new TextEncoder().encode('{"a":1}'), contentType: '' });

  const getRes = await session.request(app, `/api/workspaces/${workspace.id}/files/data.json`);
  assert.equal(getRes.status, 200);
  // Falsy stored type -> getMimeType('.json').
  assert.equal(getRes.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(await getRes.text(), '{"a":1}');
});

test('files on a missing workspace -> 404', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const res = await session.request(app, '/api/workspaces/deadbeefdeadbeefdeadbeefdeadbeef/files');
  assert.equal(res.status, 404);
});

test('observability: missing workspace 404s and created workspace returns snapshot shape', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const missing = await session.request(app, '/api/workspaces/deadbeefdeadbeefdeadbeefdeadbeef/observability');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Workspace not found' });

  const workspace = await createWorkspace(session);
  const res = await session.request(app, `/api/workspaces/${workspace.id}/observability`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    observability: {
      requests: [],
      events: [],
    },
  });
});

// ---------------------------------------------------------------------------
// Upload route
// ---------------------------------------------------------------------------

test('upload: happy path stores an allowed file', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const form = new FormData();
  form.append('files', new File(['col1,col2\n1,2'], 'table.csv', { type: 'text/csv' }));
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.files.map((f) => f.path), ['table.csv']);

  const agent = agents.get(`${sessionId}-${workspace.id}`);
  assert.ok(agent.files.has('table.csv'));
});

test('upload: disallowed extension (.exe) is rejected with 400', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const form = new FormData();
  form.append('files', new File(['MZ'], 'evil.exe', { type: 'application/octet-stream' }));
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /\.exe.*not allowed/);
  assert.equal(agents.get(`${sessionId}-${workspace.id}`).files.size, 0);
});

test('upload: one disallowed file prevents every file in the batch from being written', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const form = new FormData();
  form.append('files', new File(['safe'], 'notes.txt', { type: 'text/plain' }));
  form.append('files', new File(['MZ'], 'payload.exe', { type: 'application/octet-stream' }));
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });

  assert.equal(res.status, 400);
  assert.equal(agents.get(`${sessionId}-${workspace.id}`).files.size, 0);
  const listed = await session.request(app, `/api/workspaces/${workspace.id}/files`);
  assert.deepEqual((await listed.json()).files, []);
});

test('upload: a file over the 25 MB limit is rejected with 400', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  // 25 MB + a few bytes. Allocating this is cheap (~tens of ms) and is the
  // only faithful way to exercise the size gate through a real FormData/Request
  // boundary — a File.size getter override does not survive request serialization.
  const oversized = new Uint8Array(25 * 1024 * 1024 + 16);
  const form = new FormData();
  form.append('files', new File([oversized], 'big.txt', { type: 'text/plain' }));
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /25 MB/);
});

test('upload: more than 50 files is rejected with 400', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const form = new FormData();
  for (let i = 0; i < 51; i += 1) {
    form.append('files', new File(['x'], `file${i}.txt`, { type: 'text/plain' }));
  }
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /50 files/);
});

test('upload: no files provided -> 400', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No files/);
});

test('upload: a path-traversal filename is rejected (sanitizeRelativePath throws) with 400', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const form = new FormData();
  form.append('files', new File(['x'], '../escape.txt', { type: 'text/plain' }));
  const res = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invalid file path/);
  // Nothing escaped into the agent's file map.
  assert.equal(agents.get(`${sessionId}-${workspace.id}`).files.size, 0);
});

test('files GET: a literal ../ traversal in the URL never resolves to a stored file', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  // Seed a file a naive traversal might try to reach.
  await session.request(app, `/api/workspaces/${workspace.id}/files/secret.txt`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'top secret',
  });

  // URL normalization collapses the ../ segments before routing, so this does
  // not map onto the files/* route at all — it must not leak the file.
  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/files/../../../secret.txt`,
  );
  assert.notEqual(res.status, 200);
  // The stored file is exactly one, under its sanitized name.
  assert.deepEqual([...agents.get(`${sessionId}-${workspace.id}`).files.keys()], ['secret.txt']);
});

// ---------------------------------------------------------------------------
// Panels / layout
// ---------------------------------------------------------------------------

test('panels: add a panel, then patch layout', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const addRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: 'p1', type: 'markdown', content: 'hello' } }),
  );
  assert.equal(addRes.status, 200);
  const addState = (await addRes.json()).state;
  assert.equal(addState.panels.length, 1);
  assert.equal(addState.panels[0].id, 'p1');

  const layoutRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/layout`,
    jsonInit('PATCH', { panels: { p1: { x: 40, y: 60, width: 300 } } }),
  );
  assert.equal(layoutRes.status, 200);
  const layoutState = (await layoutRes.json()).state;
  assert.deepEqual(layoutState.panels[0].layout, { x: 40, y: 60, width: 300 });
});

test('panels: invalid panel payload -> 400 (hand-validated route)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { missing: 'type-and-id' } }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid panel payload' });
});

test('layout: invalid body returns 400 (ZodError mapped by onError)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  // viewport requires numeric x/y/zoom; a partial viewport fails the schema.
  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/layout`,
    jsonInit('PATCH', { viewport: { x: 'nope' } }),
  );
  assert.equal(res.status, 400);
});

test('panels: DELETE a panel', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: 'p1', type: 'markdown', content: 'x' } }),
  );

  const res = await session.request(app, `/api/workspaces/${workspace.id}/panels/p1`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state.panels.length, 0);
});

// ---------------------------------------------------------------------------
// Gallery / publish / clone / unpublish
// ---------------------------------------------------------------------------

test('gallery: list is empty by default and 404s for unknown items', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const listRes = await session.request(app, '/api/gallery');
  assert.equal(listRes.status, 200);
  assert.deepEqual((await listRes.json()).items, []);

  // A well-formed-but-nonexistent gallery id (8 hex + '-' + 1 hex) 404s.
  const missRes = await session.request(app, '/api/gallery/abcdef12-3');
  assert.equal(missRes.status, 404);

  // A malformed gallery id is rejected at the boundary with 400 (AS-3-6).
  const badRes = await session.request(app, '/api/gallery/nope');
  assert.equal(badRes.status, 400);
});

test('gallery: publish a workspace -> appears in list -> get by id', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Publishable');

  const pubRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'My Gallery Item', description: 'A description' }),
  );
  assert.equal(pubRes.status, 201);
  const pub = await pubRes.json();
  assert.equal(pub.item.title, 'My Gallery Item');
  assert.equal(pub.workspace.galleryId, pub.item.id);

  const listRes = await session.request(app, '/api/gallery');
  const { items } = await listRes.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, pub.item.id);

  const getRes = await session.request(app, `/api/gallery/${pub.item.id}`);
  assert.equal(getRes.status, 200);
  assert.equal((await getRes.json()).item.id, pub.item.id);
});

test('gallery: publish redacts DO naming fields and keeps ownership via an opaque tag', async () => {
  const { env, r2 } = makeEnv();
  const { session: author, sessionId } = await openSession(app, env);
  const { session: other } = await openSession(app, env);
  const workspace = await createWorkspace(author, 'Identity-safe publish');

  const pubRes = await author.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'Identity Safe', description: 'No DO name components' }),
  );
  assert.equal(pubRes.status, 201);
  const { item } = await pubRes.json();

  const prefix = `agent-studio/gallery/items/${item.id}/`;
  const manifest = await (await r2.get(`${prefix}manifest.json`)).json();
  const publishedState = await (await r2.get(`${prefix}state.json`)).json();
  assert.notEqual(manifest.authorId, sessionId);
  assert.equal(manifest.authorId, await galleryOwnerTag(sessionId, env.SESSION_SECRET));
  assert.equal(publishedState.sessionId, null);
  assert.equal(publishedState.workspace.id, '');

  const forbidden = await other.request(app, `/api/gallery/${item.id}`, { method: 'DELETE' });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'Not authorized to unpublish this item' });

  const removed = await author.request(app, `/api/gallery/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(await r2.get(`${prefix}manifest.json`), null);
});

test('gallery: publish cleans up when a listed file cannot be read', async () => {
  const { env, r2, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Broken Publish');

  await session.request(app, `/api/workspaces/${workspace.id}/files/missing.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: 'listed but unreadable',
  });
  await session.request(app, `/api/workspaces/${workspace.id}/files/keep.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: 'must not orphan',
  });
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  const originalRead = agent.readWorkspaceFileContent.bind(agent);
  agent.readWorkspaceFileContent = async (filePath) => (
    filePath === 'missing.md'
      ? null
      : originalRead(filePath)
  );

  const pubRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'Should Fail', description: 'missing file' }),
  );
  assert.equal(pubRes.status, 500);
  assert.deepEqual(r2.keysWithPrefix('agent-studio/gallery/items/'), []);

  const listRes = await session.request(app, '/api/gallery');
  assert.deepEqual((await listRes.json()).items, []);
});

test('gallery: clone (POST /api/gallery/:id) creates a workspace from a published item', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const source = await createWorkspace(session, 'Source');
  // Give the source a file so clone copies it.
  await session.request(app, `/api/workspaces/${source.id}/files/readme.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: 'clone me',
  });

  const pub = await (
    await session.request(
      app,
      `/api/workspaces/${source.id}/publish`,
      jsonInit('POST', { title: 'Cloneable', description: 'source desc' }),
    )
  ).json();

  const cloneRes = await session.request(app, `/api/gallery/${pub.item.id}`, { method: 'POST' });
  assert.equal(cloneRes.status, 201);
  const clone = await cloneRes.json();
  assert.match(clone.workspaceId, /\S/);
  assert.notEqual(clone.workspaceId, source.id);
  assert.equal(clone.workspace.name, 'Cloneable');

  // The clone shows up in the caller's workspace list.
  const list = await (await session.request(app, '/api/workspaces')).json();
  const ids = list.workspaces.map((w) => w.id);
  assert.ok(ids.includes(clone.workspaceId));
});

test('gallery: clone missing item returns 404', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const res = await session.request(app, '/api/gallery/abcdef12-3', { method: 'POST' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Gallery item not found' });
});

test('gallery: clone succeeds when a panel references a file that was never published', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const galleryId = 'abcdef12-3';
  seedGalleryItem(
    r2,
    galleryId,
    await galleryOwnerTag(sessionId, env.SESSION_SECRET),
    { title: 'Broken Clone' },
  );
  await r2.put(
    `agent-studio/gallery/items/${galleryId}/state.json`,
    JSON.stringify({
      sessionId: null,
      workspace: null,
      panels: [{ id: 'p-file', type: 'markdown', filePath: 'missing.md' }],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    }),
  );

  const cloneRes = await session.request(app, `/api/gallery/${galleryId}`, { method: 'POST' });
  assert.equal(cloneRes.status, 201);
  const clone = await cloneRes.json();

  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.deepEqual(list.workspaces.map((workspace) => workspace.id), [clone.workspaceId]);

  const detail = await (await session.request(app, `/api/workspaces/${clone.workspaceId}`)).json();
  assert.deepEqual(detail.state.panels, [{ id: 'p-file', type: 'markdown', filePath: 'missing.md' }]);
  const files = await (await session.request(app, `/api/workspaces/${clone.workspaceId}/files`)).json();
  assert.deepEqual(files.files, []);
});

test('gallery: clone fails loud and removes the workspace when a listed gallery file is unreadable', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const galleryId = 'abcdef12-3';
  const missingKey = `agent-studio/gallery/items/${galleryId}/files/missing.md`;
  seedGalleryItem(
    r2,
    galleryId,
    await galleryOwnerTag(sessionId, env.SESSION_SECRET),
    { title: 'Broken Clone' },
  );
  await r2.put(missingKey, 'gone');
  const originalGet = r2.get.bind(r2);
  r2.get = async (key) => (key === missingKey ? null : originalGet(key));

  const cloneRes = await session.request(app, `/api/gallery/${galleryId}`, { method: 'POST' });
  assert.equal(cloneRes.status, 500);

  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.deepEqual(list.workspaces, []);
});

test('gallery: unpublish (DELETE /api/gallery/:id) by the author removes the item', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'ToUnpublish');
  const pub = await (
    await session.request(
      app,
      `/api/workspaces/${workspace.id}/publish`,
      jsonInit('POST', { title: 'Temp', description: 'temp desc' }),
    )
  ).json();

  const delRes = await session.request(app, `/api/gallery/${pub.item.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { success: true });

  const listRes = await session.request(app, '/api/gallery');
  assert.deepEqual((await listRes.json()).items, []);

  // The workspace record no longer references the gallery id.
  const detail = await (await session.request(app, `/api/workspaces/${workspace.id}`)).json();
  assert.equal(detail.workspace.galleryId, undefined);
});

test('gallery: unpublish by a different session returns 403 and keeps the item', async () => {
  const { env } = makeEnv();
  const { session: author } = await openSession(app, env);
  const { session: other } = await openSession(app, env);
  const workspace = await createWorkspace(author, 'Protected Gallery Item');
  const pub = await (
    await author.request(
      app,
      `/api/workspaces/${workspace.id}/publish`,
      jsonInit('POST', { title: 'Protected', description: 'owned by author' }),
    )
  ).json();

  const delRes = await other.request(app, `/api/gallery/${pub.item.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 403);
  assert.deepEqual(await delRes.json(), { error: 'Not authorized to unpublish this item' });

  const getRes = await author.request(app, `/api/gallery/${pub.item.id}`);
  assert.equal(getRes.status, 200);
});

test('gallery: publish with invalid body returns 400 (ZodError mapped by onError)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'only title' }), // missing description
  );
  assert.equal(res.status, 400);
});

test('/api/models returns fallback catalog in anonymous no-proxy env', async () => {
  resetCailModelsCache();
  const { env } = makeEnv();
  const session = new Session(env);

  const res = await session.request(app, '/api/models');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['default', 'models', 'source']);
  assert.equal(body.source, 'fallback');
  assert.equal(body.models.length, 1);
  assert.equal(body.default, body.models[0].id);
  assert.equal(body.models[0].recommended, true);
  resetCailModelsCache();
});

test('/api/models surfaces proxy auth failure as 502', async () => {
  resetCailModelsCache();
  const { env } = makeEnv();
  env.CAIL_API_BASE = 'https://proxy.example';
  const { token, jwks } = await makeRouteCredential();
  env.CAIL_IDENTITY_JWKS = jwks;
  const session = new Session(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      error: {
        message: 'bad gateway auth',
        type: 'authentication_error',
        param: null,
        code: 'authentication_required',
        cail: { login_url: '/login' },
      },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const res = await session.request(app, '/api/models', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Model catalog authentication failed' });
  } finally {
    globalThis.fetch = originalFetch;
    resetCailModelsCache();
  }
});

test('/api/models surfaces proxy quota exhaustion as 429', async () => {
  resetCailModelsCache();
  const { env } = makeEnv();
  env.CAIL_API_BASE = 'https://proxy.example';
  const { token, jwks } = await makeRouteCredential();
  env.CAIL_IDENTITY_JWKS = jwks;
  const session = new Session(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      error: {
        message: 'quota exhausted',
        type: 'rate_limit_error',
        param: null,
        code: 'quota_exceeded',
        cail: { retry_after_seconds: 1800 },
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const res = await session.request(app, '/api/models', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      error: 'quota_exceeded',
      message: 'quota exhausted',
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetCailModelsCache();
  }
});

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

test('export: returns a v1 bundle with a download disposition', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Exportable');
  await session.request(app, `/api/workspaces/${workspace.id}/files/a.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
    body: '# A',
  });

  const res = await session.request(app, `/api/workspaces/${workspace.id}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="Exportable\.agent-studio\.json"/);
  const bundle = await res.json();
  assert.equal(bundle.version, 1);
  assert.equal(bundle.workspace.id, workspace.id);
  assert.deepEqual(bundle.files.map((f) => f.path), ['a.md']);
  assert.equal(bundle.files[0].content, '# A');
});

test('import: a valid bundle creates a workspace and its files (round-trip)', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);

  const bundle = makeImportBundle({
    workspace: {
      id: 'ignored',
      name: 'Roundtrip',
      description: 'imported desc',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    files: [
      { path: 'docs/hello.md', contentType: 'text/markdown; charset=utf-8', encoding: 'utf8', content: '# Imported' },
    ],
  });
  const form = new FormData();
  form.append('bundle', new File([JSON.stringify(bundle)], 'b.json', { type: 'application/json' }));

  const res = await session.request(app, '/api/workspaces/import', { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.workspace.name, 'Roundtrip');
  assert.match(body.workspaceId, /\S/);

  // File landed in the agent, and the workspace is listable.
  const agent = agents.get(`${sessionId}-${body.workspaceId}`);
  assert.equal(agent.files.get('docs/hello.md').contentType, 'text/markdown; charset=utf-8');
  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.ok(list.workspaces.some((w) => w.id === body.workspaceId));

  // Export of the imported workspace preserves the file content.
  const exported = await (
    await session.request(app, `/api/workspaces/${body.workspaceId}/export`)
  ).json();
  assert.equal(exported.files.find((f) => f.path === 'docs/hello.md').content, '# Imported');
});

test('import: no bundle part -> 400', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const res = await session.request(app, '/api/workspaces/import', {
    method: 'POST',
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No workspace bundle/);
});

test('import: a malformed bundle -> 400 and no orphan workspace', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const form = new FormData();
  form.append('bundle', new File(['{"not":"a bundle"}'], 'b.json', { type: 'application/json' }));
  const res = await session.request(app, '/api/workspaces/import', { method: 'POST', body: form });
  assert.equal(res.status, 400);

  // No workspace was left behind by the failed import.
  const list = await (await session.request(app, '/api/workspaces')).json();
  assert.equal(list.workspaces.length, 0);
});

// ---------------------------------------------------------------------------
// Downloads + runtime (secondary routes)
// ---------------------------------------------------------------------------

test('downloads: GET is empty, DELETE clears', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const getRes = await session.request(app, `/api/workspaces/${workspace.id}/downloads`);
  assert.equal(getRes.status, 200);
  assert.deepEqual((await getRes.json()).downloads, []);

  const delRes = await session.request(app, `/api/workspaces/${workspace.id}/downloads`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { success: true });
});

test('runtime: info and execute routes respond via the agent', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const infoRes = await session.request(app, `/api/workspaces/${workspace.id}/runtime`);
  assert.equal(infoRes.status, 200);
  assert.equal((await infoRes.json()).runtime.provider, 'dynamic-workers');

  const execRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/runtime/execute`,
    jsonInit('POST', { code: '1 + 1' }),
  );
  assert.equal(execRes.status, 200);
  assert.equal((await execRes.json()).execution.stdout, 'ran:1 + 1');
});

function malformedInit(method) {
  return { method, headers: { 'content-type': 'application/json' }, body: 'not json{{' };
}

test('malformed JSON is rejected consistently without creating a workspace', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const cases = [
    ['/api/workspaces', 'POST'],
    [`/api/workspaces/${workspace.id}`, 'PATCH'],
    [`/api/workspaces/${workspace.id}/layout`, 'PATCH'],
    [`/api/workspaces/${workspace.id}/runtime/execute`, 'POST'],
    [`/api/workspaces/${workspace.id}/publish`, 'POST'],
    [`/api/workspaces/${workspace.id}/panels`, 'POST'],
  ];

  for (const [path, method] of cases) {
    const response = await session.request(app, path, malformedInit(method));
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'Invalid request body' });
  }

  const list = await session.request(app, '/api/workspaces');
  assert.equal((await list.json()).workspaces.length, 1);
});
