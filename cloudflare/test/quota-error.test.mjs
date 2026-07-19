import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';

import {
  quotaSignalFromError,
  standardModelError,
} from '../src/lib/quota-error.ts';

const MESSAGE = 'LiteLLM End User exceeded budget.';

function apiError({
  status = 429,
  type = 'budget_exceeded',
  code = '429',
  retryAfter,
} = {}) {
  return new APICallError({
    message: MESSAGE,
    url: 'https://models.example/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: retryAfter ? { 'retry-after': String(retryAfter) } : {},
    data: {
      error: { message: MESSAGE, type, param: null, code },
    },
  });
}

test('reads the standard OpenAI error retained by the AI SDK', () => {
  assert.deepEqual(standardModelError(apiError({ retryAfter: 1800 })), {
    status: 429,
    type: 'budget_exceeded',
    code: '429',
    message: MESSAGE,
    retryAfterSeconds: 1800,
  });
});

test('translates a standard budget response into the existing chat UI signal', () => {
  const signal = quotaSignalFromError(apiError({ retryAfter: 1800 }));
  assert.equal(typeof signal, 'string');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});

test('does not treat unrelated API errors as budget exhaustion', () => {
  assert.equal(
    quotaSignalFromError(apiError({ status: 401, type: 'authentication_error' })),
    null,
  );
  assert.equal(
    quotaSignalFromError(apiError({ type: 'rate_limit_error', code: '429' })),
    null,
  );
  assert.equal(quotaSignalFromError(new Error('network failed')), null);
});
