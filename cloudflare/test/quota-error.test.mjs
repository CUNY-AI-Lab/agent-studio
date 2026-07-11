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
  assert.equal(parsed.type, 'quota_exceeded');
  assert.equal(parsed.message, QUOTA_MESSAGE);
  assert.equal(parsed.retryAfter, '1800');
});

test('quotaSignalFromError omits retryAfter when the envelope has none', () => {
  const signal = quotaSignalFromError(new CailError('quota_exceeded', QUOTA_MESSAGE, 429));
  const parsed = JSON.parse(signal);
  assert.equal(parsed.message, QUOTA_MESSAGE);
  assert.equal('retryAfter' in parsed, false);
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

// chatFetch (cail-client 2d51745) throws the parsed CailError on the first 429
// quota envelope, so the AI SDK never retries it and never wraps it in a
// RetryError. The old defensive shape-sniffing is gone on purpose: a bare 429
// shape or RetryError here is NOT a CAIL quota signal.
test('quotaSignalFromError no longer sniffs SDK error shapes', () => {
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
