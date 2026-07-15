import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { layoutPatchSchema, runtimeCodeSchema } from '../src/lib/workspace-validation.ts';

test('HTTP and callable runtime validation share the same bounded code contract', () => {
  assert.equal(runtimeCodeSchema.parse(' return 1 '), 'return 1');
  assert.throws(() => runtimeCodeSchema.parse(''));
  assert.throws(() => runtimeCodeSchema.parse('x'.repeat(100_001)));
  assert.throws(() => runtimeCodeSchema.parse({ code: 'return 1' }));
});

test('layout runtime validation includes explicit removeGroups and rejects non-finite values', () => {
  assert.deepEqual(layoutPatchSchema.parse({ removeGroups: ['group-1'] }), {
    removeGroups: ['group-1'],
  });
  assert.throws(() => layoutPatchSchema.parse({ viewport: { x: 0, y: 0, zoom: Infinity } }));
  assert.throws(() => layoutPatchSchema.parse({ removeGroups: [42] }));
  assert.throws(() => layoutPatchSchema.parse({ unknown: true }));
});

test('private read and credential RPCs are not browser-callable', async () => {
  const source = await readFile(new URL('../src/agent/workspace-agent.ts', import.meta.url), 'utf8');
  for (const method of [
    'setCailCredential',
    'getSnapshot',
    'getMessages',
    'getObservability',
    'getRuntimeInfo',
    'getWorkspaceFiles',
    'readWorkspaceFileContent',
    'writeWorkspaceFileContent',
    'deleteWorkspaceFileContent',
    'clearWorkspaceFiles',
    'freezeForMigration',
    'destroyWorkspaceState',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`@callable\\(\\)\\s+async ${method}\\(`),
      method,
    );
  }
});
