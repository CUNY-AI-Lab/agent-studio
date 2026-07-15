import assert from 'node:assert/strict';
import test from 'node:test';

import { nextR2Cursor } from '../src/lib/r2-pagination.ts';

test('R2 pagination continues only with an explicit cursor', () => {
  assert.equal(nextR2Cursor({ truncated: false }, 'list'), undefined);
  assert.equal(nextR2Cursor({ truncated: true, cursor: 'next' }, 'list'), 'next');
  assert.throws(
    () => nextR2Cursor({ truncated: true }, 'list'),
    /truncated without a continuation cursor/,
  );
});
