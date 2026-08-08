import assert from 'node:assert/strict';
import test from 'node:test';

import { generateText, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const CORRELATION = {
  trace_id: 'a'.repeat(32),
  span_id: 'b'.repeat(16),
  trace_flags: 1,
  request_id: '11111111-1111-4111-8111-111111111111',
  tracestate: 'cail=studio',
};

function completionResponse(body = {}) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: '@cf/zai-org/glm-5.2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      ...body,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function captureFetch(responseFactory = () => completionResponse()) {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return responseFactory(calls.length, input, init);
  };
  return { calls, fetch };
}

test('direct provider authentication errors preserve the AI SDK shape and make one attempt', async (t) => {
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
          'x-request-id': '11111111-1111-4111-8111-111111111111',
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
  const error = await generateText({ model, prompt: 'hello', maxRetries: 0 })
    .catch((nextError) => nextError);

  // Direct OpenAI-compatible providers surface APICallError. The bounded
  // CAIL extractor consumes responseBody later for quota/auth classification.
  assert.equal(error.name, 'AI_APICallError');
  assert.equal(error.statusCode, 401);
  assert.equal(error.message, 'Sign in to use CAIL models.');
  assert.equal(error.responseHeaders['x-should-retry'], 'false');
  assert.equal(error.responseBody.includes('authentication_required'), true);
  assert.equal(wireCalls, 1);
});

test('malformed correlation fails before the model request reaches the wire', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    return new Response('{}');
  };
  try {
    assert.throws(
      () => createCailModel({
        env: { CAIL_API_BASE: 'https://cail.test' },
        identityJwt: 'header.payload.signature',
        correlation: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          trace_flags: 2,
          request_id: 'not-a-uuid',
        },
      }),
      /request_id must be a lowercase UUID/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(wireCalls, 0);
});

test('unsafe CAIL_API_BASE values fail before any request or credential exposure', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    return completionResponse();
  };
  try {
    for (const CAIL_API_BASE of [
      'http://cail.test',
      'https://user:password@cail.test',
      'https://cail.test?token=secret',
      'https://cail.test#fragment',
      ' https://cail.test',
      'https://cail.test ',
      'https://cail.test/path with spaces',
      'https://cail.test/\u0000',
      'not-a-url',
    ]) {
      let error;
      try {
        createCailModel({
          env: { CAIL_API_BASE },
          identityJwt: 'secret-gateway-jwt',
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `expected invalid CAIL_API_BASE to throw: ${CAIL_API_BASE}`);
      assert.match(error.message, /CAIL_API_BASE/);
      assert.equal(error.message.includes('secret-gateway-jwt'), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(wireCalls, 0);
});

test('buffered model calls send one Bearer JWT and only server-owned CAIL headers', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  const capture = captureFetch();
  globalThis.fetch = capture.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test/gateway///' },
    identityJwt: 'gateway-jwt',
    correlation: CORRELATION,
  });
  await generateText({ model, prompt: 'hello', maxRetries: 0 });

  assert.equal(capture.calls.length, 1);
  const { input, init } = capture.calls[0];
  assert.equal(input, 'https://cail.test/gateway/v1/chat/completions');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer gateway-jwt');
  assert.equal([...headers.keys()].filter((name) => name === 'authorization').length, 1);
  assert.equal(headers.get('x-cail-identity-jwt'), null);
  assert.equal(headers.get('x-cail-app'), 'agent-studio');
  assert.equal(headers.get('traceparent'), `00-${CORRELATION.trace_id}-${CORRELATION.span_id}-01`);
  assert.equal(headers.get('tracestate'), CORRELATION.tracestate);
  assert.equal(headers.get('x-cail-request-id'), CORRELATION.request_id);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  const body = JSON.parse(init.body);
  assert.equal(body.model, '@cf/zai-org/glm-5.2');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

test('per-call headers cannot override model authority on buffered or streaming calls', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  const maliciousHeaders = {
    Authorization: 'Bearer attacker',
    Cookie: 'session=attacker',
    'X-CAIL-App': 'attacker-app',
    'X-CAIL-Identity-JWT': 'attacker-jwt',
    'X-CAIL-Request-Id': 'attacker-request',
    traceparent: '00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01',
    tracestate: 'attacker=1',
    'cf-aig-provider': 'attacker-provider',
    'x-openwebui-model': 'attacker-model',
    'x-provider-key': 'attacker-key',
    'Content-Type': 'text/plain',
    Accept: 'text/plain',
  };
  const capture = captureFetch((_callNumber, _input, init) => {
    const body = JSON.parse(init.body);
    return body.stream
      ? new Response(
        'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
          + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
      : completionResponse();
  });
  globalThis.fetch = capture.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'verified-gateway-jwt',
    correlation: CORRELATION,
  });
  await generateText({ model, prompt: 'hello', headers: maliciousHeaders, maxRetries: 0 });
  const streamed = streamText({ model, prompt: 'hello', headers: maliciousHeaders, maxRetries: 0 });
  for await (const _part of streamed.textStream) {
    // Consume the stream so the provider performs its real fetch.
  }

  assert.equal(capture.calls.length, 2);
  for (const { init } of capture.calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer verified-gateway-jwt');
    assert.equal([...headers.keys()].filter((name) => name === 'authorization').length, 1);
    assert.equal(headers.get('x-cail-app'), 'agent-studio');
    assert.equal(headers.get('traceparent'), `00-${CORRELATION.trace_id}-${CORRELATION.span_id}-01`);
    assert.equal(headers.get('tracestate'), CORRELATION.tracestate);
    assert.equal(headers.get('x-cail-request-id'), CORRELATION.request_id);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('accept'), 'text/plain');
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('x-cail-identity-jwt'), null);
    assert.equal(headers.get('cf-aig-provider'), null);
    assert.equal(headers.get('x-openwebui-model'), null);
    assert.equal(headers.get('x-provider-key'), null);
    assert.equal(headers.get('x-cail-request-id'), CORRELATION.request_id);
    for (const name of headers.keys()) {
      assert.equal(name.startsWith('x-cail-') && name !== 'x-cail-app' && name !== 'x-cail-request-id', false);
      assert.equal(name.startsWith('cf-aig-'), false);
      assert.equal(name.startsWith('x-openwebui-'), false);
    }
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  }
});

test('streaming model calls use the same direct endpoint and one attempt', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  const capture = captureFetch(() => new Response(
    'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'
      + 'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ));
  globalThis.fetch = capture.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'gateway-jwt',
  });
  const result = streamText({ model, prompt: 'hello', maxRetries: 0 });
  const text = [];
  for await (const part of result.textStream) text.push(part);

  assert.equal(text.join(''), 'ok');
  assert.equal(capture.calls.length, 1);
  const { input, init } = capture.calls[0];
  assert.equal(input, 'https://cail.test/v1/chat/completions');
  assert.equal(JSON.parse(init.body).stream, true);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer gateway-jwt');
  assert.equal(headers.get('x-cail-identity-jwt'), null);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
});

test('streaming network failures make one upstream request with retries disabled', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let wireCalls = 0;
  globalThis.fetch = async () => {
    wireCalls += 1;
    throw new Error('gateway unavailable');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'gateway-jwt',
  });
  let reported;
  const result = streamText({
    model,
    prompt: 'hello',
    maxRetries: 0,
    onError: ({ error }) => {
      reported = error;
    },
  });
  for await (const _part of result.textStream) {
    // A network failure should not produce a text chunk.
  }
  assert.equal(reported?.name, 'Error');
  assert.equal(reported?.message, 'gateway unavailable');
  assert.equal(wireCalls, 1);
});

test('tool-call continuation keeps the direct credential and app headers on each request', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  const capture = captureFetch((callNumber) => callNumber === 1
    ? completionResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"value":"x"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    : completionResponse(),
  );
  globalThis.fetch = capture.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'gateway-jwt',
  });
  const lookup = tool({
    description: 'Look up a value.',
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => `result:${value}`,
  });
  const result = await generateText({
    model,
    prompt: 'look up x',
    tools: { lookup },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  });

  assert.equal(result.text, 'ok');
  assert.equal(capture.calls.length, 2);
  for (const call of capture.calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer gateway-jwt');
    assert.equal(headers.get('x-cail-identity-jwt'), null);
    assert.equal(headers.get('x-cail-app'), 'agent-studio');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
  }
  const continuation = JSON.parse(capture.calls[1].init.body);
  assert.equal(continuation.messages.at(-1).role, 'tool');
  assert.equal(continuation.messages.at(-1).content, 'result:x');
});

test('configured GATEWAY service binding is selected instead of global fetch', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  const globalCalls = [];
  globalThis.fetch = async (...args) => {
    globalCalls.push(args);
    return completionResponse();
  };
  const serviceCalls = [];
  const gateway = {
    fetch(input, init) {
      serviceCalls.push({ input: String(input), init, receiver: this });
      return Promise.resolve(completionResponse());
    },
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
    identityJwt: 'gateway-jwt',
  });
  await generateText({ model, prompt: 'hello', maxRetries: 0 });

  assert.equal(serviceCalls.length, 1);
  assert.equal(globalCalls.length, 0);
  assert.equal(serviceCalls[0].receiver, gateway);
  assert.equal(serviceCalls[0].init.credentials, 'omit');
  assert.equal(serviceCalls[0].init.redirect, 'error');
});
