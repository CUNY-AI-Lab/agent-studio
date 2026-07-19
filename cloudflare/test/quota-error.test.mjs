import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CailError } from '@cuny-ai-lab/cail-client';
import { quotaSignalFromError } from '../src/lib/quota-error.ts';

const QUOTA_MESSAGE =
  'You have reached your CAIL usage quota for this period. Try again in about 1800 seconds.';

test('quotaSignalFromError forwards a thrown quota CailError verbatim', () => {
  const signal = quotaSignalFromError(
    new CailError('quota_exceeded', QUOTA_MESSAGE, 429, { retry_after_seconds: 1800 }),
  );
  assert.equal(typeof signal, 'string');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});

test('quotaSignalFromError omits retryAfter when the envelope has none', () => {
  const signal = quotaSignalFromError(new CailError('quota_exceeded', QUOTA_MESSAGE, 429));
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal('retry_after_seconds' in parsed.error.cail, false);
});

test('quotaSignalFromError ignores non-quota CailErrors', () => {
  assert.equal(
    quotaSignalFromError(
      new CailError('authentication_required', 'Sign in to continue.', 401, { login_url: '/login' }),
    ),
    null,
  );
  assert.equal(quotaSignalFromError(new CailError('network_error', 'fetch failed', 0)), null);
});

// Extraction is delegated to cail-client's extractCailError, which digs a
// TYPED CAIL envelope out of SDK wrappers but never sniffs bare statuses or
// message text: a bare 429 shape or an envelope-free RetryError is NOT a
// CAIL quota signal.
test('quotaSignalFromError does not sniff envelope-free SDK error shapes', () => {
  assert.equal(quotaSignalFromError({ statusCode: 429 }), null);
  assert.equal(
    quotaSignalFromError({
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      lastError: { statusCode: 429 },
      errors: [{ statusCode: 429 }],
    }),
    null,
  );
  assert.equal(quotaSignalFromError(new Error('upstream returned quota_exceeded')), null);
  assert.equal(quotaSignalFromError(new Error('network failed')), null);
  assert.equal(quotaSignalFromError(null), null);
  assert.equal(quotaSignalFromError(undefined), null);
});

// Defense in depth via the shared extractor: if a quota CailError DOES end up
// buried inside an SDK wrapper, the typed envelope still surfaces.
test('quotaSignalFromError unwraps a quota CailError buried in a RetryError', () => {
  const signal = quotaSignalFromError({
    name: 'AI_RetryError',
    reason: 'maxRetriesExceeded',
    errors: [
      { statusCode: 500 },
      new CailError('quota_exceeded', QUOTA_MESSAGE, 429, { retry_after_seconds: 1800 }),
    ],
  });
  assert.equal(typeof signal, 'string');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});
