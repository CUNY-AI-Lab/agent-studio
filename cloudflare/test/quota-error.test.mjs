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
