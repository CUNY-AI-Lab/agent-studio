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

import {
  importServer,
  makeEnv,
  openSession,
  Session,
  makeImportBundle,
} from './helpers/env.mjs';

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

// ---------------------------------------------------------------------------
// Session / middleware at the route level
// ---------------------------------------------------------------------------

test('health check is public and needs no session', async () => {
  const { env } = makeEnv();
  const res = await app.fetch(new Request('https://studio.test/health'), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'agent-studio' });
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
