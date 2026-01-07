import assert from 'assert';
import { describe, it } from 'node:test';
import { getUserDataPath } from '../../src/lib/session';

// Node 18+ built-in test runner compatibility
// Run with: node --test tests/dist/tests/**/*.test.js

describe('session.getUserDataPath', () => {
  it('returns a path for valid 32-hex session id', () => {
    const id = 'a'.repeat(32);
    const p = getUserDataPath(id);
    assert.ok(p.includes('/data/users/'));
  });

  it('throws for invalid session id length', () => {
    assert.throws(() => getUserDataPath('abc'), /Invalid session ID/);
  });

  it('throws for non-hex session id', () => {
    assert.throws(() => getUserDataPath('z'.repeat(32)), /Invalid session ID/);
  });
});
