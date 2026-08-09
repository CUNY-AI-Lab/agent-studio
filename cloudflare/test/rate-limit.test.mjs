import assert from 'node:assert/strict';
import test from 'node:test';

import { importServer, makeEnv, openSession } from './helpers/env.mjs';
import { checkHeavyRpcLimit } from '../src/lib/rate-limit.ts';

const app = await importServer();

function limiter(success = true) {
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
  const response = await session.request(app, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rate test' }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).workspace;
}

test('heavy RPC helper fails open locally and uses the verified session key when bound', async () => {
  assert.equal(await checkHeavyRpcLimit({}, 'local'), true);
  for (const success of [true, false]) {
    const current = limiter(success);
    assert.equal(
      await checkHeavyRpcLimit({ HEAVY_RATE_LIMIT: current.binding }, `session-${success}`),
      success,
    );
    assert.deepEqual(current.keys, [`session-${success}`]);
  }
});

test('ordinary API requests have no arbitrary application rate cap', async () => {
  const { env } = makeEnv();
  const current = limiter(false);
  env.HEAVY_RATE_LIMIT = current.binding;
  const { session } = await openSession(app, env);
  assert.equal((await session.request(app, '/api/workspaces')).status, 200);
  assert.equal((await session.request(app, '/api/gallery')).status, 200);
  assert.deepEqual(current.keys, []);
});

test('heavy HTTP denial uses the canonical retryable envelope', async () => {
  const { env } = makeEnv();
  const current = limiter(false);
  env.HEAVY_RATE_LIMIT = current.binding;
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const response = await session.request(
    app,
    `/api/workspaces/${workspace.id}/runtime/execute`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '1 + 1' }),
    },
  );
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.error.code, 'rate_limited');
  assert.equal(payload.error.type, 'rate_limit_error');
  assert.equal(payload.error.cail.retryable, true);
  assert.equal(response.headers.get('retry-after'), null);
  assert.equal(current.keys.length, 1);
});

test('upload, import, publish, and runtime execution share the one heavy boundary', async () => {
  const { env } = makeEnv();
  const current = limiter(true);
  env.HEAVY_RATE_LIMIT = current.binding;
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const upload = new FormData();
  upload.append('files', new File(['a,b'], 'table.csv', { type: 'text/csv' }));
  await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST', body: upload,
  });
  const bundle = new FormData();
  bundle.append('bundle', new File(['{}'], 'bundle.json', { type: 'application/json' }));
  await session.request(app, '/api/workspaces/import', { method: 'POST', body: bundle });
  await session.request(app, `/api/workspaces/${workspace.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Title', description: 'Description' }),
  });
  await session.request(app, `/api/workspaces/${workspace.id}/runtime/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '1 + 1' }),
  });

  assert.equal(current.keys.length, 4);
  assert.equal(new Set(current.keys).size, 1, 'all heavy operations use the same session key');
});
