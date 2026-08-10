import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCanonicalCailError,
  quotaSignalFromError,
} from '../src/lib/quota-error.ts';

const QUOTA_MESSAGE =
  'You have reached your CAIL usage quota for this period. Try again in about 1800 seconds.';

function quotaError(extra = {}) {
  return {
    error: {
      message: QUOTA_MESSAGE,
      type: 'rate_limit_error',
      code: 'quota_exceeded',
      cail: extra,
    },
  };
}

test('quotaSignalFromError forwards a thrown quota CailError verbatim', () => {
  const signal = quotaSignalFromError(
    quotaError({ retry_after_seconds: 1800 }),
  );
  assert.equal(typeof signal, 'string');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});

test('quotaSignalFromError omits retryAfter when the envelope has none', () => {
  const signal = quotaSignalFromError(quotaError());
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal('retry_after_seconds' in parsed.error.cail, false);
});

test('quotaSignalFromError ignores non-quota CailErrors', () => {
  assert.equal(
    quotaSignalFromError(
      { error: { code: 'authentication_required', message: 'Sign in to continue.', cail: { login_url: '/agent-studio' } } },
    ),
    null,
  );
  assert.equal(quotaSignalFromError({ error: { code: 'network_error', message: 'fetch failed' } }), null);
});

// Extraction digs a typed CAIL envelope out of SDK wrappers but never sniffs bare statuses or
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
      quotaError({ retry_after_seconds: 1800 }),
    ],
  });
  assert.equal(typeof signal, 'string');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});

test('quotaSignalFromError extracts the canonical envelope from an AI SDK APICallError shape', () => {
  const signal = quotaSignalFromError({
    name: 'AI_APICallError',
    statusCode: 429,
    responseHeaders: { 'x-should-retry': 'false' },
    responseBody: JSON.stringify({
      error: {
        message: QUOTA_MESSAGE,
        type: 'rate_limit_error',
        param: null,
        code: 'quota_exceeded',
        cail: { retry_after_seconds: 1800 },
      },
    }),
  });
  const parsed = JSON.parse(signal);
  assert.equal(parsed.error.code, 'quota_exceeded');
  assert.equal(parsed.error.message, QUOTA_MESSAGE);
  assert.equal(parsed.error.cail.retry_after_seconds, 1800);
});

test('extractCanonicalCailError preserves auth status from an AI SDK APICallError shape', () => {
  const cail = extractCanonicalCailError({
    name: 'AI_APICallError',
    statusCode: 401,
    responseBody: JSON.stringify({
      error: {
        message: 'Sign in to use CAIL models.',
        type: 'authentication_error',
        param: null,
        code: 'authentication_required',
        cail: { login_url: '/agent-studio' },
      },
    }),
  });
  assert.equal(cail?.code, 'authentication_required');
  assert.equal(cail?.status, 401);
  assert.equal(cail?.extras.login_url, '/agent-studio');
});

test('extractCanonicalCailError ignores unsafe wrapper status values', () => {
  const responseBody = JSON.stringify({
    error: {
      message: 'Sign in to use CAIL models.',
      code: 'authentication_required',
      cail: { login_url: '/agent-studio' },
    },
  });
  const throwingStatus = { responseBody };
  Object.defineProperty(throwingStatus, 'statusCode', {
    get() {
      throw new Error('untrusted status getter');
    },
  });

  assert.equal(extractCanonicalCailError(throwingStatus)?.status, undefined);
  for (const statusCode of [Number.NaN, Number.POSITIVE_INFINITY, 99, 600]) {
    assert.equal(
      extractCanonicalCailError({ statusCode, responseBody })?.status,
      undefined,
    );
  }
});

test('quotaSignalFromError ignores an ordinary provider quota-shaped error without CAIL evidence', () => {
  assert.equal(
    quotaSignalFromError({
      name: 'AI_APICallError',
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          message: 'Provider quota reached.',
          type: 'rate_limit_error',
          param: null,
          code: 'quota_exceeded',
        },
      }),
    }),
    null,
  );
});
