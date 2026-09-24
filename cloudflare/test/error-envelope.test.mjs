import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalError } from '../src/lib/error-envelope.ts';

test('canonicalError emits the generic OpenAI-compatible envelope and omits unsupplied CAIL fields', () => {
  assert.deepEqual(canonicalError('invalid_request', 'That did not work.', {
    type: 'invalid_request_error',
    retryable: false,
    requestId: 'req-1',
  }), {
    error: {
      message: 'That did not work.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
      cail: { request_id: 'req-1', retryable: false },
    },
  });
  assert.deepEqual(canonicalError('invalid_request', 'That did not work.').error.cail, {});
});
