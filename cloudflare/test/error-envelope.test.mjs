import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalError } from '../src/lib/error-envelope.ts';

test('canonicalError emits the generic OpenAI-compatible envelope directly', () => {
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
});

test('canonicalError omits optional CAIL fields until explicitly supplied', () => {
  const envelope = canonicalError('quota_exceeded', 'Budget exhausted.', {
    type: 'rate_limit_error',
    cail: { retry_after_seconds: 60 },
  });
  assert.deepEqual(envelope.error.cail, {});
});
