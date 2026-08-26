import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoutPatchSchema, runtimeCodeSchema } from '../src/lib/workspace-validation.ts';

test('HTTP and callable runtime validation share the same bounded code contract', () => {
  assert.equal(runtimeCodeSchema.parse(' return 1 '), 'return 1');
  assert.throws(() => runtimeCodeSchema.parse(''));
  assert.throws(() => runtimeCodeSchema.parse('x'.repeat(100_001)));
  assert.throws(() => runtimeCodeSchema.parse({ code: 'return 1' }));
});

test('layout runtime validation includes explicit removals and rejects non-finite values', () => {
  assert.deepEqual(layoutPatchSchema.parse({
    removeGroups: ['group-1'],
    removeConnections: ['connection-1'],
  }), {
    removeGroups: ['group-1'],
    removeConnections: ['connection-1'],
  });
  assert.throws(() => layoutPatchSchema.parse({ viewport: { x: 0, y: 0, zoom: Infinity } }));
  assert.throws(() => layoutPatchSchema.parse({ removeGroups: [42] }));
  assert.throws(() => layoutPatchSchema.parse({ removeConnections: [42] }));
  assert.throws(() => layoutPatchSchema.parse({ unknown: true }));
});
