import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchCailModels,
  ModelCatalogAuthError,
  ModelCatalogCapabilityError,
  ModelCatalogQuotaError,
  requireFunctionCallingModel,
  supportsFunctionCalling,
} from '../src/lib/cail-models.ts';

const BASE = 'https://proxy.example';
const JWT = 'jwt-token-value';

function response(data) {
  return new Response(JSON.stringify({ object: 'list', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function captureGateway(responder) {
  const calls = [];
  const gateway = {
    async fetch(input, init) {
      calls.push({ input: String(input), init, receiver: this });
      return responder(calls.length);
    },
  };
  return { calls, gateway };
}

test('catalog makes one direct authenticated service-binding request', async (t) => {
  const capture = captureGateway(() => response([
    { id: '@cf/zai-org/glm-5.2', object: 'model' },
    { id: '@cf/openai/gpt-oss-120b', object: 'model' },
  ]));
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    return response([]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  });
  assert.equal(capture.calls.length, 1);
  assert.equal(globalCalls, 0);
  assert.equal(capture.calls[0].receiver, capture.gateway);
  assert.equal(capture.calls[0].input, `${BASE}/v1/models`);
  const headers = new Headers(capture.calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${JWT}`);
  assert.equal(headers.get('x-cail-app'), 'agent-studio');
  assert.equal(capture.calls[0].init.credentials, 'omit');
  assert.equal(capture.calls[0].init.redirect, 'manual');
  assert.deepEqual(result.models.map(({ id, recommended }) => ({ id, recommended })), [
    { id: '@cf/zai-org/glm-5.2', recommended: true },
    { id: '@cf/openai/gpt-oss-120b', recommended: false },
  ]);
});

test('catalog aborts a delayed service-binding request without retrying', async () => {
  const controller = new AbortController();
  let requestSignal;
  const fetchImpl = async (_input, init) => {
    requestSignal = init?.signal;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  const pending = fetchCailModels({
    env: { CAIL_API_BASE: BASE },
    identityJwt: JWT,
    fetchImpl,
    abortSignal: controller.signal,
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  controller.abort();

  let timeout;
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve('timed-out'), 100);
    }),
  ]);
  clearTimeout(timeout);
  assert.notEqual(outcome, 'timed-out', 'catalog fetch should settle on the caller signal');
  assert.equal(outcome, controller.signal.reason);
  assert.equal(requestSignal?.aborted, true);
});

test('catalog ignores unsupported Gateway provider entries without hiding Workers AI', async () => {
  const capture = captureGateway(() => response([
    { id: 'anthropic/claude-sonnet-4', provider: 'openrouter' },
    { id: '@cf/zai-org/glm-5.2', provider: 'workers-ai' },
    { id: 'google/gemini-2.5-pro', provider: 'openrouter' },
    { id: '@cf/openai/gpt-oss-120b', provider: 'workers-ai' },
  ]));

  const result = await fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  });

  assert.deepEqual(result.models.map(({ id, recommended }) => ({ id, recommended })), [
    { id: '@cf/zai-org/glm-5.2', recommended: true },
    { id: '@cf/openai/gpt-oss-120b', recommended: false },
  ]);
});

test('catalog fails closed when no supported Workers AI entries remain', async () => {
  const capture = captureGateway(() => response([
    { id: 'anthropic/claude-sonnet-4', provider: 'openrouter' },
  ]));

  await assert.rejects(fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  }), /CAIL schema/);
});

test('catalog fails closed when a supported Workers AI entry is malformed', async () => {
  const capture = captureGateway(() => response([
    { id: 'anthropic/claude-sonnet-4', provider: 'openrouter' },
    { id: '@cf/zai-org/glm-5.2', provider: 'workers-ai', context_length: 'unknown' },
  ]));

  await assert.rejects(fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  }), /CAIL schema/);
});

test('catalog service bindings accept manual redirects and fail closed on 3xx', async () => {
  const capture = captureGateway(() => new Response(null, {
    status: 302,
    headers: { location: 'https://outside.example/v1/models' },
  }));
  await assert.rejects(fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  }), /status 302/);
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].init.redirect, 'manual');
});

test('catalog requires verified authentication, base URL, and service binding', async () => {
  await assert.rejects(
    fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: null }),
    ModelCatalogAuthError,
  );
  await assert.rejects(
    fetchCailModels({ env: {}, identityJwt: JWT }),
    /CAIL_API_BASE/,
  );
  await assert.rejects(
    fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT }),
    /GATEWAY service binding is required/,
  );
});

test('catalog rejects control characters in CAIL_API_BASE before any request', async () => {
  for (const CAIL_API_BASE of [
    'https://proxy.example/\u0000',
    'https://proxy.example/\u001f',
    'https://proxy.example/\u007f',
  ]) {
    const capture = captureGateway(() => response([
      { id: '@cf/zai-org/glm-5.2', object: 'model' },
    ]));
    await assert.rejects(fetchCailModels({
      env: { CAIL_API_BASE, GATEWAY: capture.gateway },
      identityJwt: JWT,
    }), /CAIL_API_BASE/);
    assert.equal(capture.calls.length, 0);
  }
});

test('catalog reports auth and quota failures without retry or fallback', async () => {
  for (const [status, ErrorType] of [
    [401, ModelCatalogAuthError],
    [403, ModelCatalogAuthError],
    [429, ModelCatalogQuotaError],
  ]) {
    const capture = captureGateway(() => new Response('failure', { status }));
    await assert.rejects(
      fetchCailModels({
        env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
        identityJwt: JWT,
      }),
      ErrorType,
    );
    assert.equal(capture.calls.length, 1);
  }
});

test('catalog reports 5xx, network, and schema failures without retry or fallback', async () => {
  const failures = [
    () => new Response('failure', { status: 500 }),
    () => { throw new Error('network unavailable'); },
    () => response([]),
    () => response([{ id: 'outside-policy', object: 'model' }]),
  ];
  for (const responder of failures) {
    const capture = captureGateway(responder);
    await assert.rejects(fetchCailModels({
      env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
      identityJwt: JWT,
    }));
    assert.equal(capture.calls.length, 1);
  }
});

test('catalog preserves current fields and normalizes optional metadata', async () => {
  const capture = captureGateway(() => response([
    {
      id: '@cf/zai-org/glm-5.2',
      name: 'GLM 5.2',
      description: 'General model.',
      tier: 'recommended',
      status: 'active',
      capabilities: ['function-calling'],
      context_length: 131072,
      registry_url: 'https://registry.example/model',
    },
    { id: '@cf/old', tier: 'advanced', status: 'retiring', sunset: '2026-12-31' },
  ]));
  const result = await fetchCailModels({
    env: { CAIL_API_BASE: BASE },
    identityJwt: JWT,
    fetchImpl: capture.gateway.fetch.bind(capture.gateway),
  });
  assert.deepEqual(result.models[0], {
    id: '@cf/zai-org/glm-5.2',
    recommended: true,
    tier: 'recommended',
    status: 'active',
    sunset: null,
    capabilities: ['function-calling'],
    contextLength: 131072,
    registryUrl: 'https://registry.example/model',
    name: 'GLM 5.2',
    description: 'General model.',
  });
  assert.equal(result.models[1].status, 'retiring');
  assert.equal(result.models[1].sunset, '2026-12-31');
});

test('the DeepSeek V4 Flash 0731 Workers model advertises function calling', async () => {
  const capture = captureGateway(() => response([{
    id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    capabilities: ['text-generation', 'function-calling', 'reasoning'],
  }]));
  const result = await fetchCailModels({
    env: { CAIL_API_BASE: BASE, GATEWAY: capture.gateway },
    identityJwt: JWT,
  });

  assert.equal(supportsFunctionCalling(result.models[0]), true);
  assert.equal(result.models[0].id, '@cf/deepseek-ai/deepseek-v4-flash-0731');
  assert.doesNotThrow(() => requireFunctionCallingModel(
    result.models,
    '@cf/deepseek-ai/deepseek-v4-flash-0731',
  ));
});

test('function capability selection never falls back to another model', () => {
  const models = [{
    id: '@cf/no-tools/model',
    capabilities: [],
  }];
  assert.throws(
    () => requireFunctionCallingModel(models, '@cf/no-tools/model'),
    ModelCatalogCapabilityError,
  );
  assert.throws(
    () => requireFunctionCallingModel(models, '@cf/missing/model'),
    ModelCatalogCapabilityError,
  );
});
