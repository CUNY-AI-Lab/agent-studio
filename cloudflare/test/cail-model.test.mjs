import assert from 'node:assert/strict';
import test from 'node:test';

import { generateText, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

function completionResponse(body = {}) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: '@cf/zai-org/glm-5.2',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ...body,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function captureGateway(responseFactory = () => completionResponse()) {
  const calls = [];
  const gateway = {
    async fetch(input, init) {
      calls.push({ input: String(input), init, receiver: this });
      return responseFactory(calls.length, input, init);
    },
  };
  return { calls, gateway };
}

test('direct provider authentication errors keep the AI SDK shape and make one attempt', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway(() => new Response(JSON.stringify({
    error: {
      message: 'Sign in to use CAIL models.',
      type: 'authentication_error',
      param: null,
      code: 'authentication_required',
      cail: { login_url: '/agent-studio' },
    },
  }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'request-1',
      'x-should-retry': 'false',
    },
  }));
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'header.payload.signature',
  });
  const error = await generateText({ model, prompt: 'hello', maxRetries: 0 })
    .catch((nextError) => nextError);

  assert.equal(error.name, 'AI_APICallError');
  assert.equal(error.statusCode, 401);
  assert.equal(error.message, 'Sign in to use CAIL models.');
  assert.equal(error.responseHeaders['x-should-retry'], 'false');
  assert.equal(error.responseBody.includes('authentication_required'), true);
  assert.equal(capture.calls.length, 1);
});

test('model calls require the service binding and never use global fetch', async (t) => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    return completionResponse();
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.throws(() => createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test' },
    identityJwt: 'gateway-jwt',
  }), /GATEWAY service binding is required/);

  const capture = captureGateway();
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });
  await generateText({ model, prompt: 'hello', maxRetries: 0 });
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].receiver, capture.gateway);
  assert.equal(globalCalls, 0);
});

test('unsafe CAIL_API_BASE values fail before any request or credential exposure', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway();
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
        env: { CAIL_API_BASE, GATEWAY: capture.gateway },
        identityJwt: 'secret-gateway-jwt',
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `expected invalid CAIL_API_BASE to throw: ${CAIL_API_BASE}`);
    assert.match(error.message, /CAIL_API_BASE/);
    assert.equal(error.message.includes('secret-gateway-jwt'), false);
  }
  assert.equal(capture.calls.length, 0);
});

test('buffered calls use one Bearer credential and only safe server-owned headers', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway();
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test/gateway///', GATEWAY: capture.gateway },
    identityJwt: 'verified-gateway-jwt',
  });
  await generateText({
    model,
    prompt: 'hello',
    maxRetries: 0,
    headers: {
      authorization: 'Bearer attacker',
      cookie: 'session=attacker',
      'x-cail-app': 'attacker',
      'x-cail-identity-jwt': 'attacker',
      'cf-aig-provider': 'attacker',
      'x-openwebui-model': 'attacker',
      accept: 'text/plain',
      'content-type': 'text/plain',
    },
  });

  assert.equal(capture.calls.length, 1);
  const { input, init } = capture.calls[0];
  assert.equal(input, 'https://cail.test/gateway/v1/chat/completions');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer verified-gateway-jwt');
  assert.equal([...headers.keys()].filter((name) => name === 'authorization').length, 1);
  assert.equal(headers.get('x-cail-app'), 'agent-studio');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('accept'), 'text/plain');
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('x-cail-identity-jwt'), null);
  assert.equal(headers.get('cf-aig-provider'), null);
  assert.equal(headers.get('x-openwebui-model'), null);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  assert.equal(JSON.parse(init.body).model, '@cf/deepseek-ai/deepseek-v4-flash-0731');
});

test('provider forwards the caller abort signal to the Gateway Fetcher', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway();
  const controller = new AbortController();
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });

  await generateText({ model, prompt: 'hello', maxRetries: 0, abortSignal: controller.signal });

  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].init.signal, controller.signal);
});

test('chat service bindings accept manual redirects and fail closed on 3xx', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const calls = [];
  const gateway = {
    async fetch(input, init) {
      calls.push({ input: String(input), init });
      assert.equal(init.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://outside.example/chat' },
      });
    },
  };
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
    identityJwt: 'gateway-jwt',
  });
  const error = await generateText({ model, prompt: 'hello', maxRetries: 0 })
    .catch((nextError) => nextError);

  assert.equal(error.name, 'AI_APICallError');
  assert.equal(error.statusCode, 302);
  assert.equal(calls.length, 1);
});

test('streaming calls use the same direct endpoint and one attempt', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway(() => new Response(
    'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'
      + 'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ));
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });
  const result = streamText({ model, prompt: 'hello', maxRetries: 0 });
  const text = [];
  for await (const part of result.textStream) text.push(part);

  assert.equal(text.join(''), 'ok');
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].input, 'https://cail.test/v1/chat/completions');
  assert.equal(JSON.parse(capture.calls[0].init.body).stream, true);
});

test('streaming network failures make one upstream request with retries disabled', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway(() => { throw new Error('gateway unavailable'); });
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });
  let reported;
  const result = streamText({
    model,
    prompt: 'hello',
    maxRetries: 0,
    onError: ({ error }) => { reported = error; },
  });
  for await (const _part of result.textStream) {
    // Consume the stream.
  }
  assert.equal(reported?.message, 'gateway unavailable');
  assert.equal(capture.calls.length, 1);
});

test('tool continuation preserves the direct credential on every request', async () => {
  const { createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway((callNumber) => callNumber === 1
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
    : completionResponse());
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });
  const result = await generateText({
    model,
    prompt: 'look up x',
    tools: {
      lookup: tool({
        description: 'Look up a value.',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => `result:${value}`,
      }),
    },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  });

  assert.equal(result.text, 'ok');
  assert.equal(capture.calls.length, 2);
  for (const call of capture.calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer gateway-jwt');
    assert.equal(headers.get('x-cail-app'), 'agent-studio');
  }
  const continuation = JSON.parse(capture.calls[1].init.body);
  assert.equal(continuation.messages.at(-1).role, 'tool');
});

test('the default model keeps the first title turn on the ordinary automatic tool loop', async () => {
  const { DEFAULT_CAIL_MODEL, createCailModel } = await import('../src/lib/cail-model.ts');
  const capture = captureGateway((callNumber) => callNumber === 1
    ? completionResponse({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-title-1',
            type: 'function',
            function: { name: 'ui_workspace', arguments: '{"name":"Campus research dashboard"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    : completionResponse());
  const model = createCailModel({
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: capture.gateway },
    identityJwt: 'gateway-jwt',
  });
  const result = generateText({
    model,
    prompt: 'Build a campus research dashboard.',
    tools: {
      ui_workspace: tool({
        description: 'Set the workspace title.',
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => ({ name }),
      }),
      other_tool: tool({
        description: 'A tool unavailable during title assignment.',
        inputSchema: z.object({}),
        execute: async () => 'unused',
      }),
    },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  });
  await result;

  assert.equal(capture.calls.length, 2);
  for (const call of capture.calls) {
    const request = JSON.parse(call.init.body);
    assert.equal(request.model, DEFAULT_CAIL_MODEL);
    assert.equal(request.tool_choice, 'auto');
    assert.deepEqual(request.tools.map((entry) => entry.function.name), ['ui_workspace', 'other_tool']);
  }
});
