// Regression coverage for AS-0-1 (S0): agent/attacker-authored workspace files
// must never be served as ACTIVE same-origin documents.
//
// Full chain reproduced: an .html/.svg payload enters a workspace (via
// `PUT /files/*` when the type slips through, AND via the agent write_file tool
// path — simulated by writing straight through the FakeWorkspaceAgent double's
// `writeWorkspaceFileContent`, the exact method the tool invokes) → published to
// the PUBLIC gallery → GET both the workspace file URL and the gallery file URL.
//
// Assertions per §3¾: every file-serving response carries nosniff + the bare
// sandbox CSP (opaque origin, scripting disabled); active types additionally
// carry `Content-Disposition: attachment` while safe inline types (png/pdf) do
// not. And the untyped PUT route now rejects disallowed/active types at the door.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  importServer,
  makeEnv,
  openSession,
} from './helpers/env.mjs';

const app = await importServer();

const SANDBOX_CSP = "default-src 'none'; sandbox";
const JSON_HEADERS = { 'content-type': 'application/json' };

function jsonInit(method, body) {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function createWorkspace(session, name = 'Workspace') {
  const res = await session.request(app, '/api/workspaces', jsonInit('POST', { name }));
  assert.equal(res.status, 201);
  return (await res.json()).workspace;
}

function assertSandboxed(res, { attachment }) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), SANDBOX_CSP);
  if (attachment) {
    assert.equal(res.headers.get('content-disposition'), 'attachment');
  } else {
    assert.equal(res.headers.get('content-disposition'), null);
  }
}

// Active-document payload classes that must all come back sandboxed+attachment.
const ACTIVE_PAYLOADS = [
  { path: 'inline-script.html', type: 'text/html', body: '<script>document.cookie</script>' },
  { path: 'svg-onload.svg', type: 'image/svg+xml', body: '<svg onload="alert(document.cookie)"></svg>' },
  { path: 'img-onerror.html', type: 'text/html', body: '<img src=x onerror="alert(document.cookie)">' },
  { path: 'js-bait.html', type: 'text/html', body: '<a href="javascript:alert(1)">x</a><iframe src="data:text/html,<script>1</script>"></iframe>' },
  { path: 'xhtml.xhtml', type: 'application/xhtml+xml', body: '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>' },
  { path: 'doc.xml', type: 'application/xml', body: '<?xml version="1.0"?><root/>' },
];

// Safe inline types: must NOT be forced to download but MUST still carry the
// sandbox CSP + nosniff.
const SAFE_PAYLOADS = [
  { path: 'pic.png', type: 'image/png', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { path: 'doc.pdf', type: 'application/pdf', body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
];

test('active-type files written via the agent write_file tool path are sandboxed on both file routes', async () => {
  const { env, ensureAgent } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Attack');

  // Simulate the agent write_file tool: it calls writeWorkspaceFileContent
  // directly on the DO, bypassing the HTTP PUT allowlist entirely.
  const agent = ensureAgent(`${sessionId}-${workspace.id}`);
  for (const payload of [...ACTIVE_PAYLOADS, ...SAFE_PAYLOADS]) {
    await agent.writeWorkspaceFileContent(payload.path, payload.body, payload.type);
  }

  // Publish to the PUBLIC gallery.
  const publishRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'Pwned Gallery Item', description: 'attacker content' }),
  );
  assert.equal(publishRes.status, 201);
  const { item } = await publishRes.json();
  assert.ok(item?.id, 'expected a published gallery id');

  // Active payloads: sandboxed + attachment on BOTH routes.
  for (const payload of ACTIVE_PAYLOADS) {
    const wsRes = await session.request(app, `/api/workspaces/${workspace.id}/files/${payload.path}`);
    assert.equal(wsRes.status, 200, `workspace GET ${payload.path}`);
    assertSandboxed(wsRes, { attachment: true });

    const galRes = await session.request(app, `/api/gallery/${item.id}/files/${payload.path}`);
    assert.equal(galRes.status, 200, `gallery GET ${payload.path}`);
    assertSandboxed(galRes, { attachment: true });
  }

  // Regression guard: safe types stay inline (no attachment) but still sandboxed.
  for (const payload of SAFE_PAYLOADS) {
    const wsRes = await session.request(app, `/api/workspaces/${workspace.id}/files/${payload.path}`);
    assert.equal(wsRes.status, 200, `workspace GET ${payload.path}`);
    assertSandboxed(wsRes, { attachment: false });

    const galRes = await session.request(app, `/api/gallery/${item.id}/files/${payload.path}`);
    assert.equal(galRes.status, 200, `gallery GET ${payload.path}`);
    assertSandboxed(galRes, { attachment: false });
  }
});

test('PUT /files/* with an active type is rejected; a safe type still writes and is sandboxed on GET', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'PutGate');

  // .html via PUT with text/html -> 400 at the write door.
  const evil = await session.request(app, `/api/workspaces/${workspace.id}/files/evil.html`, {
    method: 'PUT',
    headers: { 'content-type': 'text/html' },
    body: '<script>document.cookie</script>',
  });
  assert.equal(evil.status, 400, 'PUT evil.html must be rejected');
  // And it must not have been written.
  const gone = await session.request(app, `/api/workspaces/${workspace.id}/files/evil.html`);
  assert.equal(gone.status, 404);

  // .svg via PUT -> 400 too.
  const evilSvg = await session.request(app, `/api/workspaces/${workspace.id}/files/evil.svg`, {
    method: 'PUT',
    headers: { 'content-type': 'image/svg+xml' },
    body: '<svg onload="alert(1)"></svg>',
  });
  assert.equal(evilSvg.status, 400, 'PUT evil.svg must be rejected');

  // Safe CSV still succeeds and its GET carries sandbox CSP + nosniff, no attachment.
  const csv = await session.request(app, `/api/workspaces/${workspace.id}/files/data.csv`, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: 'a,b\n1,2\n',
  });
  assert.equal(csv.status, 200, 'PUT data.csv must succeed');

  const getCsv = await session.request(app, `/api/workspaces/${workspace.id}/files/data.csv`);
  assert.equal(getCsv.status, 200);
  assertSandboxed(getCsv, { attachment: false });
});

test('an .html written via HTTP PUT (type slips as octet-stream ext-check aside) — belt: served sandboxed+attachment', async () => {
  // Even if a future caller manages to land active bytes through some path, the
  // serving headers are the containment. Prove it independently of the PUT gate
  // by writing through the agent double, then asserting the workspace GET.
  const { env, ensureAgent } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Belt');

  const agent = ensureAgent(`${sessionId}-${workspace.id}`);
  await agent.writeWorkspaceFileContent('report.html', '<script>steal()</script>', 'text/html; charset=utf-8');

  const res = await session.request(app, `/api/workspaces/${workspace.id}/files/report.html`);
  assert.equal(res.status, 200);
  // charset parameter must not defeat the active-type match.
  assertSandboxed(res, { attachment: true });
});
