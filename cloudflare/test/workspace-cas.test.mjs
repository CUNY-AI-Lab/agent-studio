import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWorkspaceWithEtag,
  putWorkspace,
  putWorkspaceIfMatch,
} from '../src/lib/workspaces.ts';
import { importServer, makeEnv, openSession } from './helpers/env.mjs';

const app = await importServer();

test('putWorkspaceIfMatch rejects a stale etag and accepts the current etag', async () => {
  const { env } = makeEnv();
  const sessionId = 'a'.repeat(32);
  const workspace = {
    id: 'b'.repeat(32),
    name: 'Original',
    description: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await putWorkspace(env, sessionId, workspace);
  const stale = await getWorkspaceWithEtag(env, sessionId, workspace.id);
  assert.ok(stale);

  await putWorkspace(env, sessionId, { ...workspace, description: 'concurrent update' });
  assert.equal(
    await putWorkspaceIfMatch(env, sessionId, { ...workspace, name: 'stale write' }, stale.etag),
    false,
  );

  const current = await getWorkspaceWithEtag(env, sessionId, workspace.id);
  assert.ok(current);
  assert.equal(
    await putWorkspaceIfMatch(env, sessionId, { ...current.workspace, name: 'fresh write' }, current.etag),
    true,
  );
});

test('workspace PATCH still returns the patched fields through the CAS path', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const created = await session.request(app, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Before' }),
  });
  const workspace = (await created.json()).workspace;

  const patched = await session.request(app, `/api/workspaces/${workspace.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'After', description: 'CAS worked' }),
  });

  assert.equal(patched.status, 200);
  const body = await patched.json();
  assert.equal(body.workspace.name, 'After');
  assert.equal(body.workspace.description, 'CAS worked');
});

test('opening a legacy selection migrates its exact variant once without a catalog dependency', async () => {
  const { env } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  env.GATEWAY = { fetch() { throw new Error('Catalog must not be used to open a workspace'); } };
  const created = await session.request(app, '/api/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Keep this title' }),
  });
  const workspace = (await created.json()).workspace;
  const legacy = { ...workspace, model: '@cf/deepseek-ai/deepseek-v4-flash-0731', description: 'Keep this description' };
  await putWorkspace(env, sessionId, legacy);
  const opened = await session.request(app, `/api/workspaces/${workspace.id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual((await opened.json()).workspace, { ...legacy, model: 'deepseek-v4-flash-0731' });
  const persisted = await getWorkspaceWithEtag(env, sessionId, workspace.id);
  assert.equal(persisted.workspace.model, 'deepseek-v4-flash-0731');
  await session.request(app, `/api/workspaces/${workspace.id}`);
  assert.equal((await getWorkspaceWithEtag(env, sessionId, workspace.id)).etag, persisted.etag);
});

test('opening an unknown legacy variant preserves the choice for explicit replacement', async () => {
  const { env } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const created = await session.request(app, '/api/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unknown variant' }),
  });
  const workspace = (await created.json()).workspace;
  const model = '@cf/deepseek-ai/deepseek-v4-flash-other-variant';
  await putWorkspace(env, sessionId, { ...workspace, model });
  const opened = await session.request(app, `/api/workspaces/${workspace.id}`);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).workspace.model, model);
  assert.equal((await getWorkspaceWithEtag(env, sessionId, workspace.id)).workspace.model, model);
});


test('model migration preserves a concurrent canonical selection and title after an etag conflict', async () => {
  const { migrateWorkspaceModel } = await import('../src/lib/model-migration.ts');
  const { env, r2 } = makeEnv();
  const sessionId = 'a'.repeat(32);
  const workspace = {
    id: 'migration-race', name: 'Original', description: 'Keep description',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    model: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  };
  await putWorkspace(env, sessionId, workspace);
  const concurrent = { ...workspace, model: 'glm-5.2', name: 'Concurrent title' };
  const originalPut = r2.put.bind(r2);
  let injected = false;
  r2.put = async (key, value, options) => {
    if (options?.onlyIf && !injected) {
      injected = true;
      await originalPut(key, JSON.stringify(concurrent));
    }
    return originalPut(key, value, options);
  };
  const migration = await migrateWorkspaceModel(env, sessionId, workspace.id);
  assert.equal(injected, true);
  assert.equal(migration.ok, true);
  assert.deepEqual(migration.workspace, concurrent);
  assert.deepEqual((await getWorkspaceWithEtag(env, sessionId, workspace.id)).workspace, concurrent);
});

for (const scenario of ['conflict', 'disappeared', 'deleting']) {
  test(`workspace migration ${scenario} stops before stale Durable Object sync`, async () => {
    const { env, r2, agents } = makeEnv();
    const { session, sessionId } = await openSession(app, env);
    const created = await session.request(app, '/api/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Migration race' }),
    });
    const workspace = { ...(await created.json()).workspace, model: '@cf/deepseek-ai/deepseek-v4-flash-0731' };
    await putWorkspace(env, sessionId, workspace);
    const agent = agents.get(`${sessionId}-${workspace.id}`);
    const initialSyncs = agent.syncCount;
    const originalPut = r2.put.bind(r2);
    let conditionalWrites = 0;
    r2.put = async (key, value, options) => {
      if (options?.onlyIf) {
        conditionalWrites += 1;
        if (scenario === 'disappeared') await r2.delete(key);
        else {
          const concurrent = { ...workspace, name: 'Concurrent title' };
          if (scenario === 'deleting') concurrent.deleting = true;
          await originalPut(key, JSON.stringify(concurrent));
        }
      }
      return originalPut(key, value, options);
    };
    const response = await session.request(app, `/api/workspaces/${workspace.id}`);
    assert.equal(response.status, scenario === 'conflict' ? 409 : 404);
    assert.equal((await response.json()).error.code, scenario === 'conflict' ? 'conflict' : 'not_found');
    assert.equal(conditionalWrites, scenario === 'conflict' ? 3 : 1);
    assert.equal(agent.syncCount, initialSyncs, 'a failed migration must not install its stale record');
  });
}
