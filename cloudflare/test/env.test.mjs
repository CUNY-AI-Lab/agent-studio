import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_REQUIRED_SESSION_SECRET_LENGTH,
  validateAgentStudioConfig,
} from '../src/env.ts';

test('required SESSION_SECRET configuration accepts a usable secret', () => {
  assert.deepEqual(
    validateAgentStudioConfig({ SESSION_SECRET: 'x'.repeat(MIN_REQUIRED_SESSION_SECRET_LENGTH) }),
    { ok: true }
  );
});

test('required SESSION_SECRET configuration rejects missing and short values', () => {
  assert.deepEqual(validateAgentStudioConfig({}), {
    ok: false,
    errorCode: 'session_secret_missing',
  });
  assert.deepEqual(validateAgentStudioConfig({ SESSION_SECRET: 'too-short' }), {
    ok: false,
    errorCode: 'session_secret_too_short',
  });
});
