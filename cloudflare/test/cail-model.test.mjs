import assert from 'node:assert/strict';
import test from 'node:test';

import { generateText } from 'ai';

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

  assert.equal(error.name, 'AI_APICallError');
  assert.equal(error.message, 'Sign in to use CAIL models.');
  assert.equal(error.statusCode, 401);
  assert.equal(error.responseHeaders['x-request-id'], 'req-agent-auth-1');
  assert.equal(error.responseHeaders['x-should-retry'], 'false');
  assert.equal(wireCalls, 1);
});
