// Regression coverage for AS-0-1 extension (S0): the two PREVIEW routes that
// serve an inline `type:'preview'` panel's `content` as ACTIVE HTML must force
// an OPAQUE origin so a top-level open can't reach same-origin state (the
// non-HttpOnly CSRF cookie) → no cross-tenant takeover.
//
// Full chain reproduced: POST /api/workspaces/:id/panels plants a content-only
// preview panel whose content is a `<script>` payload → POST /publish writes it
// verbatim into the PUBLIC gallery state → GET both the workspace preview URL
// and the gallery preview URL.
//
// Assertions per §3¾: the served CSP carries `sandbox allow-scripts` (opaque
// origin; scripts still run so the live-preview feature survives) and NEVER
// `allow-same-origin` (which would defeat the containment). Opaque-origin
// enforcement itself is the browser's guarantee from the sandbox directive; the
// test pins the header contract precisely. Also covers: a benign preview panel's
// content is served intact (feature preserved), and the POST /panels schema
// validation (malformed body → 400, valid preview panel → success).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  importServer,
  makeEnv,
  openSession,
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

// Assert the preview containment header contract: scripts allowed (feature
// works) but the origin is forced opaque (no allow-same-origin → takeover dead).
function assertOpaqueScriptSandbox(res) {
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /sandbox allow-scripts/, 'preview CSP must carry `sandbox allow-scripts`');
  assert.doesNotMatch(csp, /allow-same-origin/, 'preview CSP must NOT grant allow-same-origin');
  // Previews render, they must not download.
  assert.equal(res.headers.get('content-disposition'), null);
  // The in-app iframe still needs to embed it.
  assert.match(csp, /frame-ancestors 'self'/, 'preview CSP must keep frame-ancestors self');
}

const SCRIPT_PAYLOAD =
  "<script>fetch('/api/session').then(()=>document.cookie)</script>";

test('inline preview content is served opaque-origin on both preview routes (workspace + public gallery)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Attack');

  // Plant a content-only preview panel carrying a cookie-stealing <script>.
  const panelId = 'evil-preview';
  const addRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: panelId, type: 'preview', content: SCRIPT_PAYLOAD } }),
  );
  assert.equal(addRes.status, 200, 'valid preview panel POST must succeed');

  // Workspace preview route.
  const wsRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels/${panelId}/preview`,
  );
  assert.equal(wsRes.status, 200, 'workspace preview GET');
  assertOpaqueScriptSandbox(wsRes);
  assert.equal(await wsRes.text(), SCRIPT_PAYLOAD, 'workspace preview serves the panel content');

  // Publish to the PUBLIC gallery (unauthenticated cross-user surface).
  const publishRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'Pwned Preview', description: 'attacker content' }),
  );
  assert.equal(publishRes.status, 201);
  const { item } = await publishRes.json();
  assert.ok(item?.id, 'expected a published gallery id');

  // Gallery preview route is PUBLIC (no session) — a fresh session (victim).
  const { session: victim } = await openSession(app, env);
  const galRes = await victim.request(
    app,
    `/api/gallery/${item.id}/panels/${panelId}/preview`,
  );
  assert.equal(galRes.status, 200, 'gallery preview GET');
  assertOpaqueScriptSandbox(galRes);
  assert.equal(await galRes.text(), SCRIPT_PAYLOAD, 'gallery preview serves the panel content');
});

test('a benign preview panel renders (feature preserved end to end)', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Benign');

  const benign = '<h1>hello</h1><script>document.body.innerHTML="rendered"</script>';
  const panelId = 'good-preview';
  const addRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: panelId, type: 'preview', content: benign, title: 'Demo' } }),
  );
  assert.equal(addRes.status, 200);

  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels/${panelId}/preview`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  // Script source lists still permit inline + the CDN hosts within the sandbox.
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /cdn\.jsdelivr\.net/);
  assert.match(csp, /sandbox allow-scripts/);
  assert.equal(await res.text(), benign, 'benign preview content is served intact');
});

test('POST /panels rejects a malformed panel body (400) and accepts a valid one', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'SchemaGate');

  // Unknown discriminator type → 400.
  const badType = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: 'x', type: 'not-a-real-type' } }),
  );
  assert.equal(badType.status, 400, 'unknown panel type must be rejected');

  // Missing id → 400.
  const noId = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { type: 'preview', content: '<p>x</p>' } }),
  );
  assert.equal(noId.status, 400, 'panel without id must be rejected');

  // Unshaped extra field on a strict schema → 400.
  const extra = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: 'y', type: 'preview', content: '<p>x</p>', evil: '<script>1</script>' } }),
  );
  assert.equal(extra.status, 400, 'unexpected extra fields must be rejected');

  // Missing panel wrapper → 400.
  const empty = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', {}),
  );
  assert.equal(empty.status, 400, 'missing panel must be rejected');

  // A well-shaped chat panel → success.
  const good = await session.request(
    app,
    `/api/workspaces/${workspace.id}/panels`,
    jsonInit('POST', { panel: { id: 'chat-1', type: 'chat', title: 'Chat' } }),
  );
  assert.equal(good.status, 200, 'valid panel must succeed');
});
