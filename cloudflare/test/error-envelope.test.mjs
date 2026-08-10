import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalError } from '../src/lib/error-envelope.ts';

test('canonicalError emits the nested CAIL envelope directly', () => {
  assert.deepEqual(canonicalError('authentication_required', 'Sign in to continue.', {
    type: 'authentication_error',
    retryable: false,
    loginUrl: '/agent-studio',
    requestId: 'req-1',
  }), {
    error: {
      message: 'Sign in to continue.',
      type: 'authentication_error',
      param: null,
      code: 'authentication_required',
      cail: { login_url: '/agent-studio', request_id: 'req-1', retryable: false },
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
