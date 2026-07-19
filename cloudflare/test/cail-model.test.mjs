import assert from 'node:assert/strict';
import test from 'node:test';

import { APICallError, generateText } from 'ai';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

test('standard OpenAI authentication errors remain APICallError and are not retried', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    return Response.json({
      error: {
        message: 'Sign in to use CAIL models.',
        type: 'authentication_error',
        param: null,
        code: 'authentication_required',
      },
    }, { status: 401 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_OPENAI_BASE_URL: 'https://cail.test/v1' },
    identityJwt: 'header.payload.signature',
  });
  const error = await generateText({ model, prompt: 'hello' }).catch((value) => value);

  assert.equal(APICallError.isInstance(error), true);
  assert.equal(error.message, 'Sign in to use CAIL models.');
  assert.equal(error.statusCode, 401);
  assert.equal(error.data.error.code, 'authentication_required');
  assert.equal(wireCalls, 1);
});

test('malformed correlation fails before a model request reaches the wire', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    return new Response('{}');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.throws(() => createCailModel({
    env: { CAIL_OPENAI_BASE_URL: 'https://cail.test/v1' },
    identityJwt: 'header.payload.signature',
    correlation: {
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: 2,
      request_id: 'not-a-uuid',
    },
  }));
  assert.equal(wireCalls, 0);
});
