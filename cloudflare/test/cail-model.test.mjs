import assert from 'node:assert/strict';
import test from 'node:test';

import { generateText } from 'ai';
import { CailError } from '@cuny-ai-lab/cail-client';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

test('nested gateway authentication errors preserve metadata and are not retried', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    return new Response(
      JSON.stringify({
        error: {
          message: 'Sign in to use CAIL models.',
          type: 'authentication_error',
          param: null,
          code: 'authentication_required',
          cail: { login_url: '/login' },
        },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-agent-auth-1',
          'x-should-retry': 'false',
        },
      },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'header.payload.signature',
  });
  const error = await generateText({ model, prompt: 'hello' }).catch((nextError) => nextError);

  assert.ok(error instanceof CailError);
  assert.equal(error.code, 'authentication_required');
  assert.equal(error.message, 'Sign in to use CAIL models.');
  assert.equal(error.extras.login_url, '/login');
  assert.equal(error.extras.request_id, 'req-agent-auth-1');
  assert.equal(error.extras.should_retry, false);
  assert.equal(wireCalls, 1);
});
