import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cailErrorEnvelope,
  cailErrorResponse,
} from '@cuny-ai-lab/cail-client/testing';

import { canonicalizeErrorResponse } from '../src/lib/error-envelope.ts';

test('legacy flat errors are normalized to the CAIL nested envelope', async () => {
  const response = await canonicalizeErrorResponse(Response.json({
    error: 'authentication_required',
    login_url: '/login',
  }, { status: 401 }), 'req-1');
  assert.deepEqual(await response.json(), {
    error: {
      message: 'authentication_required',
      type: 'authentication_error',
      param: null,
      code: 'authentication_required',
      cail: { request_id: 'req-1', login_url: '/login' },
    },
  });
});

test('normalization preserves status, headers, explicit retry posture, and nested data', async () => {
  const response = await canonicalizeErrorResponse(cailErrorResponse(
    429,
    cailErrorEnvelope({
      message: 'Budget exhausted',
      type: 'rate_limit_error',
      code: 'quota_exceeded',
      cail: {},
    }),
    { 'X-Should-Retry': 'false', 'Retry-After': '60' },
  ), 'req-2');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal((await response.json()).error.cail.retryable, false);
});
