// CSRF contract coverage (cail-gateway docs/INTEGRATION.md §3¾).
//
// Two layers: the pure helpers in src/lib/csrf.ts (origin classification, token
// derivation, WS origin gate), and the enforced behavior through the real Hono
// app in src/server.ts against the in-memory doubles (helpers/env.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOrigin,
  canonicalOrigin,
  deriveCsrfToken,
  timingSafeEqual,
  wsOriginAllowed,
  enforceCsrf,
  csrfCookiePath,
  CSRF_HEADER,
  CSRF_WS_QUERY_PARAM,
  CSRF_COOKIE_NAME,
} from '../src/lib/csrf.ts';

import { importServer, makeEnv, openSession, Session, csrfCookieFrom } from './helpers/env.mjs';

const app = await importServer();
const CANONICAL = 'https://studio.test';
const SECRET = 'ab'.repeat(32);

function jsonInit(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Rule 2 — origin classification (pure)
// ---------------------------------------------------------------------------

test('classifyOrigin: Sec-Fetch-Site same-origin accepts', () => {
  assert.equal(classifyOrigin('same-origin', null, CANONICAL), 'same-origin');
});

test('classifyOrigin: Sec-Fetch-Site same-site is rejected (same-site != same-origin)', () => {
  // The 2026-07-05 clarification: rejecting same-site is required, not extra.
  assert.equal(classifyOrigin('same-site', CANONICAL, CANONICAL), 'reject');
});

test('classifyOrigin: Sec-Fetch-Site cross-site / none are rejected', () => {
  assert.equal(classifyOrigin('cross-site', null, CANONICAL), 'reject');
  assert.equal(classifyOrigin('none', null, CANONICAL), 'reject');
});

test('classifyOrigin: exact Origin match accepts, mismatch rejects', () => {
  assert.equal(classifyOrigin(null, CANONICAL, CANONICAL), 'same-origin');
  assert.equal(classifyOrigin(null, 'https://evil.example', CANONICAL), 'reject');
});

test('classifyOrigin: both headers absent -> defer to token', () => {
  assert.equal(classifyOrigin(null, null, CANONICAL), 'absent');
});

test('classifyOrigin: Sec-Fetch-Site is preferred over a spoofable Origin', () => {
  // Sec-Fetch-Site present and same-origin wins even if Origin says otherwise.
  assert.equal(classifyOrigin('same-origin', 'https://evil.example', CANONICAL), 'same-origin');
  // And a same-site Sec-Fetch-Site rejects even when Origin equals canonical.
  assert.equal(classifyOrigin('same-site', CANONICAL, CANONICAL), 'reject');
});

// ---------------------------------------------------------------------------
// Rule 2 — canonical origin derivation
// ---------------------------------------------------------------------------

test('canonicalOrigin: derives the request origin when no override is set', () => {
  const c = { env: {}, req: { url: 'https://studio.test/api/workspaces' } };
  assert.equal(canonicalOrigin(c), 'https://studio.test');
});

test('canonicalOrigin: honors CAIL_CANONICAL_ORIGIN override (trailing slash trimmed)', () => {
  const c = {
    env: { CAIL_CANONICAL_ORIGIN: 'https://tools.ailab.gc.cuny.edu/' },
    req: { url: 'https://agent-studio.workers.dev/api/x' },
  };
  assert.equal(canonicalOrigin(c), 'https://tools.ailab.gc.cuny.edu');
});

// ---------------------------------------------------------------------------
// Rule 3 — token derivation
// ---------------------------------------------------------------------------

test('deriveCsrfToken: deterministic for the same session + secret', async () => {
  const a = await deriveCsrfToken('session-one', SECRET);
  const b = await deriveCsrfToken('session-one', SECRET);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/); // HMAC-SHA-256 hex
});

test('deriveCsrfToken: distinct across sessions', async () => {
  const a = await deriveCsrfToken('session-one', SECRET);
  const b = await deriveCsrfToken('session-two', SECRET);
  assert.notEqual(a, b);
});

test('deriveCsrfToken: distinct across secrets (secret binds the token)', async () => {
  const a = await deriveCsrfToken('session-one', SECRET);
  const b = await deriveCsrfToken('session-one', 'cd'.repeat(32));
  assert.notEqual(a, b);
});

test('timingSafeEqual: matches equal strings, rejects different/length-mismatched', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

// ---------------------------------------------------------------------------
// Rule 4 — WebSocket upgrade origin gate (pure)
// ---------------------------------------------------------------------------

function wsRequest(headers) {
  return new Request('https://studio.test/agents/workspace-agent/room', { headers });
}

test('wsOriginAllowed: same-origin handshake is allowed', () => {
  assert.equal(wsOriginAllowed(wsRequest({ 'Sec-Fetch-Site': 'same-origin' })), true);
});

test('wsOriginAllowed: cross-origin Origin handshake is blocked', () => {
  assert.equal(wsOriginAllowed(wsRequest({ Origin: 'https://evil.example' })), false);
});

test('wsOriginAllowed: same-site handshake is blocked', () => {
  assert.equal(wsOriginAllowed(wsRequest({ 'Sec-Fetch-Site': 'same-site' })), false);
});

test('wsOriginAllowed: header-less handshake defers to the token gate (allowed here)', () => {
  assert.equal(wsOriginAllowed(wsRequest({})), true);
});

test('wsOriginAllowed: override changes what counts as same-origin', () => {
  const req = new Request('https://agent-studio.workers.dev/agents/x/y', {
    headers: { Origin: 'https://tools.ailab.gc.cuny.edu' },
  });
  assert.equal(wsOriginAllowed(req, 'https://tools.ailab.gc.cuny.edu'), true);
  assert.equal(wsOriginAllowed(req), false); // without override, origin != request origin
});

// ---------------------------------------------------------------------------
// enforceCsrf (pure, with a minimal Hono-like context double)
// ---------------------------------------------------------------------------

function fakeContext({ method, headers = {}, sessionId = 'deadbeefdeadbeefdeadbeefdeadbeef', env = {} }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    env: { SESSION_SECRET: SECRET, ...env },
    req: {
      method,
      url: 'https://studio.test/api/workspaces',
      header: (name) => lower[name.toLowerCase()] ?? undefined,
    },
    get: (key) => (key === 'sessionId' ? sessionId : undefined),
    json: (body, status) => ({ __json: body, status }),
  };
}

test('enforceCsrf: GET passes untouched', async () => {
  const rejection = await enforceCsrf(fakeContext({ method: 'GET' }));
  assert.equal(rejection, null);
});

test('enforceCsrf: POST with Sec-Fetch-Site same-origin and no token is rejected 403', async () => {
  const rejection = await enforceCsrf(
    fakeContext({ method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } }),
  );
  assert.equal(rejection.status, 403);
  assert.deepEqual(rejection.__json, { error: 'csrf_token_missing' });
});

test('enforceCsrf: POST with Sec-Fetch-Site same-origin requires a valid token', async () => {
  const sessionId = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const token = await deriveCsrfToken(sessionId, SECRET);

  const good = await enforceCsrf(
    fakeContext({ method: 'POST', sessionId, headers: { 'Sec-Fetch-Site': 'same-origin', [CSRF_HEADER]: token } }),
  );
  assert.equal(good, null);

  const wrong = await enforceCsrf(
    fakeContext({ method: 'POST', sessionId, headers: { 'Sec-Fetch-Site': 'same-origin', [CSRF_HEADER]: 'nope' } }),
  );
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong.__json, { error: 'csrf_token_invalid' });
});

test('enforceCsrf: POST with Sec-Fetch-Site same-site is rejected 403', async () => {
  const rejection = await enforceCsrf(
    fakeContext({ method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } }),
  );
  assert.equal(rejection.status, 403);
});

test('enforceCsrf: POST with exact Origin still requires a valid token; wrong Origin 403', async () => {
  const sessionId = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const token = await deriveCsrfToken(sessionId, SECRET);
  const ok = await enforceCsrf(
    fakeContext({ method: 'POST', sessionId, headers: { Origin: 'https://studio.test', [CSRF_HEADER]: token } }),
  );
  assert.equal(ok, null);
  const bad = await enforceCsrf(
    fakeContext({ method: 'POST', headers: { Origin: 'https://evil.example' } }),
  );
  assert.equal(bad.status, 403);
});

test('enforceCsrf: no origin headers + valid token passes; wrong token 403; missing token 403', async () => {
  const sessionId = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const token = await deriveCsrfToken(sessionId, SECRET);

  const good = await enforceCsrf(
    fakeContext({ method: 'POST', sessionId, headers: { [CSRF_HEADER]: token } }),
  );
  assert.equal(good, null);

  const wrong = await enforceCsrf(
    fakeContext({ method: 'POST', sessionId, headers: { [CSRF_HEADER]: 'not-the-token' } }),
  );
  assert.equal(wrong.status, 403);

  const missing = await enforceCsrf(fakeContext({ method: 'POST', sessionId }));
  assert.equal(missing.status, 403);
});

// ---------------------------------------------------------------------------
// Route-level enforcement through the real app
// ---------------------------------------------------------------------------

test('route: /api/session delivers the CSRF token in a Set-Cookie matching the derivation', async () => {
  const { env } = makeEnv();
  const session = new Session(env);
  const res = await session.request(app, '/api/session');
  const body = await res.json();
  const cookieToken = csrfCookieFrom(res);
  assert.match(cookieToken, /^[a-f0-9]{64}$/);
  assert.equal(cookieToken, await deriveCsrfToken(body.sessionId, SECRET));
});

// Regression-pin the 2026-07-05 delivery amendment: the token must NEVER appear
// in the response body (a same-origin sibling / user-content script could read
// it there). It lives only in the path-scoped Set-Cookie.
test('route: /api/session response body contains NO csrfToken field (delivery amendment)', async () => {
  const { env } = makeEnv();
  const session = new Session(env);
  const res = await session.request(app, '/api/session');
  const body = await res.json();
  assert.equal('csrfToken' in body, false);
  assert.equal(body.sessionId != null, true);
  // Belt-and-suspenders: the raw body text must not contain the token either.
  const cookieToken = csrfCookieFrom(res);
  const res2 = await new Session(env).request(app, '/api/session');
  const rawText = await res2.text();
  assert.equal(rawText.includes(cookieToken), false);
});

test('route: /api/session CSRF cookie has the pinned attributes (name/path/samesite; not httponly; secure on https)', async () => {
  const { env } = makeEnv();
  const res = await new Session(env).request(app, '/api/session');
  // Locate the specific Set-Cookie line for our cookie, unmerged when possible.
  const lines =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
  const line = lines.find((l) => l.includes(`${CSRF_COOKIE_NAME}=`)) || '';
  assert.ok(line, 'CSRF Set-Cookie header is present');
  assert.match(line, new RegExp(`(^|,\\s*)${CSRF_COOKIE_NAME}=[a-f0-9]{64}`));
  // Path defaults to '/' (no CAIL_BASE_PATH in the test env).
  assert.match(line, /;\s*Path=\/(?:;|$|,)/i);
  assert.match(line, /;\s*SameSite=Lax/i);
  // Secure because the harness serves over https://studio.test.
  assert.match(line, /;\s*Secure/i);
  // NOT HttpOnly — the page JS must read it via document.cookie.
  assert.equal(/;\s*HttpOnly/i.test(line), false);
});

test('csrfCookiePath: defaults to / and honors CAIL_BASE_PATH (normalized)', () => {
  assert.equal(csrfCookiePath({}), '/');
  assert.equal(csrfCookiePath({ CAIL_BASE_PATH: '' }), '/');
  assert.equal(csrfCookiePath({ CAIL_BASE_PATH: '/' }), '/');
  assert.equal(csrfCookiePath({ CAIL_BASE_PATH: '/agent-studio' }), '/agent-studio');
  assert.equal(csrfCookiePath({ CAIL_BASE_PATH: '/agent-studio/' }), '/agent-studio');
  assert.equal(csrfCookiePath({ CAIL_BASE_PATH: 'agent-studio' }), '/agent-studio');
});

test('route: CSRF cookie Path follows CAIL_BASE_PATH when set', async () => {
  const { env } = makeEnv();
  env.CAIL_BASE_PATH = '/agent-studio';
  const res = await new Session(env).request(app, '/api/session');
  const lines =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
  const line = lines.find((l) => l.includes(`${CSRF_COOKIE_NAME}=`)) || '';
  assert.match(line, /;\s*Path=\/agent-studio(?:;|$|,)/i);
});

test('route: mutation with neither origin nor token -> 403', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  // Explicitly send no token and no origin (override the helper's auto-attach).
  const res = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Nope' }),
    csrfToken: '',
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'csrf_token_missing');
});

test('route: mutation with Sec-Fetch-Site same-origin and no token -> 403', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const res = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Same-origin' }),
    csrfToken: '',
    secFetchSite: 'same-origin',
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'csrf_token_missing');
});

test('route: mutation with Sec-Fetch-Site same-origin requires the session token', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const ok = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Same-origin valid token' }),
    secFetchSite: 'same-origin',
  });
  assert.equal(ok.status, 201);

  const wrong = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Same-origin wrong token' }),
    csrfToken: 'deadbeef'.repeat(8),
    secFetchSite: 'same-origin',
  });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'csrf_token_invalid');
});

test('route: mutation with Sec-Fetch-Site same-site -> 403', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const res = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Same-site' }),
    csrfToken: '',
    secFetchSite: 'same-site',
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'csrf_origin_mismatch');
});

test('route: mutation with exact Origin and valid token passes; foreign Origin 403', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const ok = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Exact origin' }),
    origin: 'https://studio.test',
  });
  assert.equal(ok.status, 201);

  const evil = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Evil' }),
    csrfToken: '',
    origin: 'https://evil.example',
  });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error, 'csrf_origin_mismatch');
});

test('route: mutation with no origin + valid token passes; wrong token 403', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  // openSession captured the real token; the default helper behavior attaches it.
  const ok = await session.request(app, '/api/workspaces', jsonInit('POST', { name: 'Token ok' }));
  assert.equal(ok.status, 201);

  const bad = await session.request(app, '/api/workspaces', {
    ...jsonInit('POST', { name: 'Token bad' }),
    csrfToken: 'deadbeef'.repeat(8),
  });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error, 'csrf_token_invalid');
});

test('route: GET routes are unaffected by CSRF enforcement', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  // A cross-site Origin on a GET must not be blocked (rule 1: GETs never mutate).
  const res = await session.request(app, '/api/workspaces', {
    origin: 'https://evil.example',
  });
  assert.equal(res.status, 200);
});

test('route: DELETE (state-changing) is also gated', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const created = await session.request(app, '/api/workspaces', jsonInit('POST', { name: 'ToDelete' }));
  const { workspace } = await created.json();

  const forged = await session.request(app, `/api/workspaces/${workspace.id}`, {
    method: 'DELETE',
    csrfToken: '',
    origin: 'https://evil.example',
  });
  assert.equal(forged.status, 403);

  const legit = await session.request(app, `/api/workspaces/${workspace.id}`, { method: 'DELETE' });
  assert.equal(legit.status, 200);
});

// A guard so the WS query-param field name stays in lockstep with the client.
test('CSRF_WS_QUERY_PARAM is the field the client sends', () => {
  assert.equal(CSRF_WS_QUERY_PARAM, 'csrfToken');
});
