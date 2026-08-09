import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const { MigrationRegistry } = await import('../src/migration-registry.ts');

function makeRegistry(seed = []) {
  const values = new Map(seed);
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
  };
  return {
    registry: new MigrationRegistry({ storage }, {}),
    values,
  };
}

test('anonymous request lease prevents a claim and a sticky claim prevents later anonymous writes', async () => {
  const { registry } = makeRegistry();
  assert.equal(await registry.beginAnonymousRequest('request-1'), true);
  assert.equal(await registry.claim('subject-session-1'), 'anonymous-active');
  await registry.endAnonymousRequest('request-1');

  assert.equal(await registry.claim('subject-session-1'), 'run');
  assert.equal(await registry.beginAnonymousRequest('request-2'), false);
  assert.equal(await registry.claim('subject-session-2'), 'claimed-by-other');

  await registry.markFailed('subject-session-1');
  assert.equal(await registry.claim('subject-session-1'), 'run');
  await registry.markDone('subject-session-1');
  assert.equal(await registry.claim('subject-session-1'), 'already-done');
});

test('a stale request lease cannot permanently block a later login retry', async () => {
  const old = Date.now() - 11 * 60 * 1000;
  const { registry, values } = makeRegistry([
    ['active-anonymous-requests:v1', { abandoned: old }],
  ]);
  assert.equal(await registry.claim('subject-session-1'), 'run');
  assert.equal(values.has('active-anonymous-requests:v1'), false);
});
