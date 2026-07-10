// Route-level coverage for the rate-limit middleware wired in src/server.ts.
//
// Reuses the server-routes harness (helpers/env.mjs): the real app.fetch()
// pipeline runs sessionMiddleware -> rateLimitMiddleware -> route handlers
// against in-memory doubles. The rate-limit binding is a Cloudflare "ratelimit"
// binding exposing `limit({ key }) -> { success }`; here we inject a fake that
// records the keys it was consulted with and returns a scripted verdict.
//
// Covered:
//   * binding absent -> requests flow (fail open)
//   * fake binding returning success:false -> 429 + envelope + Retry-After
//   * heavy vs general namespace selection (runtime/execute vs a GET)
//   * keying by session id (two sessions get independent keys)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importServer, makeEnv, openSession, Session } from './helpers/env.mjs';
import { checkHeavyRpcLimit } from '../src/lib/rate-limit.ts';

const app = await importServer();

const JSON_HEADERS = { 'content-type': 'application/json' };

function jsonInit(method, body) {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * A fake Cloudflare RateLimit binding. Records every key it was consulted with
 * and returns `{ success }` per the scripted verdict (default allow).
 */
function makeFakeLimiter(success = true) {
  const keys = [];
  return {
    keys,
    binding: {
      async limit({ key }) {
        keys.push(key);
        return { success };
      },
    },
  };
}

async function createWorkspace(session) {
  const res = await session.request(app, '/api/workspaces', jsonInit('POST', { name: 'W' }));
  assert.equal(res.status, 201);
  return (await res.json()).workspace;
}

// ---------------------------------------------------------------------------
// Callable RPC helper
// ---------------------------------------------------------------------------

test('checkHeavyRpcLimit fails open and passes the supplied key to the limiter', async () => {
  assert.equal(await checkHeavyRpcLimit({}, 'absent-key'), true);

  for (const success of [true, false]) {
    const limiter = makeFakeLimiter(success);
    const allowed = await checkHeavyRpcLimit(
      { HEAVY_RATE_LIMIT: limiter.binding },
      `rpc-key-${success}`,
    );
    assert.equal(allowed, success);
    assert.deepEqual(limiter.keys, [`rpc-key-${success}`]);
  }
});

// ---------------------------------------------------------------------------
// Fail open
// ---------------------------------------------------------------------------

test('fail open: no rate-limit binding -> requests flow normally', async () => {
  // makeEnv() sets neither API_RATE_LIMIT nor HEAVY_RATE_LIMIT.
  const { env } = makeEnv();
  const { session } = await openSession(app, env);

  const res = await session.request(app, '/api/workspaces');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).workspaces));
});

// ---------------------------------------------------------------------------
// Over limit
// ---------------------------------------------------------------------------

test('over limit: binding returns success:false -> 429 + envelope + Retry-After', async () => {
  const { env } = makeEnv();
  // Bootstrap the first-party token before denying the protected GET; otherwise
  // the read CSRF gate correctly wins with 403 before rate limiting runs.
  const { session } = await openSession(app, env);
  const general = makeFakeLimiter(false);
  env.API_RATE_LIMIT = general.binding;

  const res = await session.request(app, '/api/workspaces');

  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.deepEqual(await res.json(), {
    error: 'rate_limited',
    message: 'Too many requests — try again shortly.',
  });
  // The general namespace was the one consulted for a GET.
  assert.equal(general.keys.length, 1);
});

test('over limit on a heavy op: HEAVY binding returning false -> 429', async () => {
  const { env } = makeEnv();
  // Allow general so workspace creation succeeds; deny heavy.
  const general = makeFakeLimiter(true);
  const heavy = makeFakeLimiter(false);
  env.API_RATE_LIMIT = general.binding;
  env.HEAVY_RATE_LIMIT = heavy.binding;

  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const res = await session.request(
    app,
    `/api/workspaces/${workspace.id}/runtime/execute`,
    jsonInit('POST', { code: '1 + 1' })
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(heavy.keys.length, 1, 'heavy binding was consulted for runtime/execute');
});

// ---------------------------------------------------------------------------
// Namespace selection
// ---------------------------------------------------------------------------

test('namespace selection: heavy POST hits HEAVY, GET hits API', async () => {
  const { env } = makeEnv();
  const general = makeFakeLimiter(true);
  const heavy = makeFakeLimiter(true);
  env.API_RATE_LIMIT = general.binding;
  env.HEAVY_RATE_LIMIT = heavy.binding;

  const { session } = await openSession(app, env);
  const generalBefore = general.keys.length;

  const workspace = await createWorkspace(session);

  // runtime/execute (heavy POST) consults the HEAVY namespace only.
  const heavyBefore = heavy.keys.length;
  const execRes = await session.request(
    app,
    `/api/workspaces/${workspace.id}/runtime/execute`,
    jsonInit('POST', { code: '1 + 1' })
  );
  assert.equal(execRes.status, 200);
  assert.equal(heavy.keys.length, heavyBefore + 1, 'runtime/execute -> HEAVY');

  // A plain GET consults the general namespace, never HEAVY.
  const heavyAfterExec = heavy.keys.length;
  const getRes = await session.request(app, '/api/workspaces');
  assert.equal(getRes.status, 200);
  assert.equal(heavy.keys.length, heavyAfterExec, 'GET does not touch HEAVY');
  assert.ok(general.keys.length > generalBefore, 'GET -> API namespace');
});

test('namespace selection: upload / import / publish are heavy', async () => {
  const { env } = makeEnv();
  const general = makeFakeLimiter(true);
  const heavy = makeFakeLimiter(true);
  env.API_RATE_LIMIT = general.binding;
  env.HEAVY_RATE_LIMIT = heavy.binding;

  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const heavyBefore = heavy.keys.length;

  // upload
  const form = new FormData();
  form.append('files', new File(['a,b\n1,2'], 't.csv', { type: 'text/csv' }));
  await session.request(app, `/api/workspaces/${workspace.id}/upload`, { method: 'POST', body: form });

  // import (malformed body is fine — the middleware runs before the handler)
  const importForm = new FormData();
  importForm.append('bundle', new File(['{"x":1}'], 'b.json', { type: 'application/json' }));
  await session.request(app, '/api/workspaces/import', { method: 'POST', body: importForm });

  // publish
  await session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', { title: 'T', description: 'D' })
  );

  assert.equal(heavy.keys.length, heavyBefore + 3, 'upload + import + publish each hit HEAVY');
});

// ---------------------------------------------------------------------------
// Keying by session id
// ---------------------------------------------------------------------------

test('keying: two sessions produce two independent keys, matching their session ids', async () => {
  const { env } = makeEnv();
  const general = makeFakeLimiter(true);
  env.API_RATE_LIMIT = general.binding;

  const a = new Session(env);
  const b = new Session(env);
  const aId = (await (await a.request(app, '/api/session')).json()).sessionId;
  const bId = (await (await b.request(app, '/api/session')).json()).sessionId;

  // Reset recorded keys, then make one general request from each session.
  general.keys.length = 0;
  await a.request(app, '/api/workspaces');
  await b.request(app, '/api/workspaces');

  assert.equal(general.keys.length, 2);
  assert.ok(general.keys.includes(aId), 'session A keyed by its session id');
  assert.ok(general.keys.includes(bId), 'session B keyed by its session id');
  assert.notEqual(aId, bId, 'the two sessions have distinct ids');
});
