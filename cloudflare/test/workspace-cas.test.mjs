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
