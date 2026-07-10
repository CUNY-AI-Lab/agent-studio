import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quotaSignalFromError } from '../src/lib/quota-error.ts';

function assertQuotaSignal(error) {
  const signal = quotaSignalFromError(error);
  assert.equal(typeof signal, 'string');
  assert.match(signal, /quota_exceeded/);
  assert.equal(JSON.parse(signal).type, 'quota_exceeded');
}

test('quotaSignalFromError detects HTTP 429', () => {
  assertQuotaSignal({ statusCode: 429 });
});

test('quotaSignalFromError detects quota envelopes', () => {
  assertQuotaSignal({ data: { error: 'quota_exceeded' } });
});

test('quotaSignalFromError detects quota codes in error messages', () => {
  assertQuotaSignal(new Error('upstream returned quota_exceeded'));
});

test('quotaSignalFromError ignores generic and non-quota server errors', () => {
  assert.equal(quotaSignalFromError(new Error('network failed')), null);
  assert.equal(quotaSignalFromError({ statusCode: 500 }), null);
});

test('quotaSignalFromError detects a 429 nested in an AI SDK RetryError', () => {
  const signal = quotaSignalFromError({
    name: 'AI_RetryError',
    reason: 'maxRetriesExceeded',
    message: 'Failed after 3 attempts.',
    lastError: {
      statusCode: 429,
      responseHeaders: { 'retry-after': '3600' },
    },
    errors: [{ statusCode: 429 }],
  });

  assert.equal(typeof signal, 'string');
  assert.equal(JSON.parse(signal).retryAfter, '3600');
});

test('quotaSignalFromError detects quota errors nested only in errors', () => {
  assertQuotaSignal({
    name: 'AI_RetryError',
    errors: [{ statusCode: 500 }, { data: { error: 'quota_exceeded' } }],
  });
});

test('quotaSignalFromError detects quota errors nested via cause', () => {
  assertQuotaSignal(new Error('wrapper', {
    cause: { data: { error: 'quota_exceeded' } },
  }));
});

test('quotaSignalFromError terminates on cyclic non-quota errors', () => {
  const error = new Error('wrapper');
  error.cause = error;
  assert.equal(quotaSignalFromError(error), null);
});

test('quotaSignalFromError ignores RetryErrors wrapping only server errors', () => {
  assert.equal(quotaSignalFromError({
    name: 'AI_RetryError',
    lastError: { statusCode: 500 },
    errors: [{ statusCode: 500 }, { statusCode: 503 }],
  }), null);
});
