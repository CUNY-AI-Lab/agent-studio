// Unit tests for the CAIL model-catalog client (lib/cail-models.ts): proxy
// shape parsing + first-entry-recommended, fallback on missing base /
// upstream 500 / bad shape, no-retry-on-4xx, and the 5-minute proxy cache.
// Runs on node:test with tsx, no extra deps. A counting fetch double lets us
// assert refetch behavior; resetCailModelsCache clears module-global state.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cailErrorEnvelope,
  cailErrorResponse,
  quotaExceededResponse,
} from '@cuny-ai-lab/cail-client/testing';

import {
  fetchCailModels,
  ModelCatalogAuthError,
  ModelCatalogQuotaError,
  resetCailModelsCache,
} from '../src/lib/cail-models.ts';
import { DEFAULT_CAIL_MODEL } from '../src/lib/cail-model.ts';
import { CAIL_APP_SLUG, CAIL_IDENTITY_HEADER } from '../src/lib/cail-identity.ts';

const BASE = 'https://proxy.example';
const JWT = 'jwt-token-value';

/** A fetch double that records calls and replays a queue of responder fns. */
function makeFetch(responders) {
  const calls = [];
  const queue = [...responders];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const responder = queue.length > 1 ? queue.shift() : queue[0];
    return responder();
  };
  return { fetchImpl, calls };
}

function listResponse(ids) {
  return () =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model' })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}

/** Response builder for arbitrary (new-schema) data[] entries. */
function dataResponse(data) {
  return () =>
    new Response(JSON.stringify({ object: 'list', data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Responder thunk over the canonical envelope builders (a fresh Response per
 * call, since retrying tests replay the same responder).
 */
function cailErrorResponder(status, overrides) {
  return () => cailErrorResponse(status, cailErrorEnvelope(overrides));
}

beforeEach(() => {
  resetCailModelsCache();
});

test('parses the proxy list and marks the first entry recommended', async () => {
  const { fetchImpl, calls } = makeFetch([
    listResponse(['@cf/zai-org/glm-5.2', '@cf/openai/gpt-oss-120b', '@cf/meta/llama-3']),
  ]);

  const result = await fetchCailModels({
    env: { CAIL_API_BASE: BASE },
    identityJwt: JWT,
    fetchImpl,
    correlation: {
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: 0,
      request_id: '11111111-1111-4111-8111-111111111111',
      tracestate: 'cail=catalog',
    },
  });

  assert.equal(result.source, 'proxy');
  // data[0] is the fleet default: recommended + tier 'recommended'; the rest,
  // with no tier/recommended flags, fall to 'advanced'. All default to active.
  assert.deepEqual(
    result.models.map((m) => ({ id: m.id, recommended: m.recommended, tier: m.tier, status: m.status })),
    [
      { id: '@cf/zai-org/glm-5.2', recommended: true, tier: 'recommended', status: 'active' },
      { id: '@cf/openai/gpt-oss-120b', recommended: false, tier: 'advanced', status: 'active' },
      { id: '@cf/meta/llama-3', recommended: false, tier: 'advanced', status: 'active' },
    ]
  );

  // Sanity: it hit the canonical OpenAI-compatible model route with the
  // identity + app headers, no Bearer key.
  const req = new Request(calls[0].url, calls[0].init);
  assert.equal(new URL(req.url).pathname, '/v1/models');
  assert.equal(req.headers.get(CAIL_IDENTITY_HEADER), JWT);
  assert.equal(req.headers.get('X-CAIL-App'), CAIL_APP_SLUG);
  assert.equal(req.headers.get('authorization'), null);
  assert.equal(req.headers.get('traceparent'), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`);
  assert.equal(req.headers.get('tracestate'), 'cail=catalog');
  assert.equal(req.headers.get('x-cail-request-id'), '11111111-1111-4111-8111-111111111111');
  assert.equal(calls[0].init.credentials, 'omit');
});

test('falls back to the configured default when CAIL_API_BASE is unset', async () => {
  const { fetchImpl, calls } = makeFetch([listResponse(['@cf/should-not-be-used'])]);
  const result = await fetchCailModels({
    env: { CAIL_MODEL: '@cf/openai/gpt-oss-120b' },
    identityJwt: JWT,
    fetchImpl,
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, '@cf/openai/gpt-oss-120b');
  assert.equal(result.models[0].recommended, true);
  assert.equal(calls.length, 0, 'no request without a base URL');
});

test('fails authentication when the proxy is configured but the JWT is null', async () => {
  const { fetchImpl, calls } = makeFetch([listResponse(['@cf/x'])]);
  await assert.rejects(
    fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: null, fetchImpl }),
    ModelCatalogAuthError,
  );
  assert.equal(calls.length, 0);
});

test('falls back on a 500 after the shared client retries', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => new Response('boom', { status: 500 }),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length > 1, true, '5xx is retried by the shared client');
});

test('401 and 403 proxy responses fail loud as ModelCatalogAuthError', async () => {
  for (const status of [401, 403]) {
    resetCailModelsCache();
    const { fetchImpl } = makeFetch([
      cailErrorResponder(status, {
        code: 'authentication_required',
        message: `auth failed ${status}`,
        type: 'authentication_error',
      }),
    ]);
    await assert.rejects(
      () => fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl }),
      (error) => {
        assert.equal(error instanceof ModelCatalogAuthError, true);
        assert.equal(error.message, `auth failed ${status}`);
        return true;
      },
    );
  }
});

test('429 proxy responses fail loud as ModelCatalogQuotaError without retrying', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => quotaExceededResponse({ message: 'quota exceeded' }),
  ]);
  await assert.rejects(
    () => fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl }),
    (error) => {
      assert.equal(error instanceof ModelCatalogQuotaError, true);
      assert.equal(error.message, 'quota exceeded');
      return true;
    },
  );
  assert.equal(calls.length, 1, '4xx is not retried');
});

test('non-auth, non-quota 4xx falls back immediately', async () => {
  const { fetchImpl, calls } = makeFetch([
    cailErrorResponder(400, { code: 'bad_request', message: 'bad request' }),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length, 1, '4xx is not retried');
});

test('falls back on a network error after the shared client retries', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => { throw new Error('network down'); },
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length > 1, true, 'network error is retried by the shared client');
});

test('falls back when the response fails shape validation', async () => {
  const { fetchImpl } = makeFetch([
    () => new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, DEFAULT_CAIL_MODEL);
  assert.equal(result.models[0].recommended, true);
});

// Contract-drift surfacing: a schema-invalid 200 still falls back, but must
// emit the structured drift event so the masking is observable in the fleet
// dataset. An unreachable proxy (documented fallback) stays event-silent.
function makeLogEnv(points) {
  return {
    CAIL_API_BASE: BASE,
    CAIL_LOG_ENV: 'test',
    CF_VERSION_METADATA: { id: 'test-release' },
    CAIL_FLEET_EVENTS: { writeDataPoint: (point) => points.push(point) },
  };
}

test('a schema-invalid 200 surfaces a contract-drift event alongside the fallback', async () => {
  const { fetchImpl } = makeFetch([
    () => new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ]);
  const points = [];
  const result = await fetchCailModels({ env: makeLogEnv(points), identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(points.length, 1, 'contract drift emits exactly one structured event');
  const encoded = JSON.stringify(points[0]);
  assert.ok(encoded.includes('agent_studio.model_catalog.contract_drift'), encoded);
  assert.ok(encoded.includes('model_catalog_schema_invalid'), encoded);
});

test('the unreachable-proxy fallback stays event-silent (documented degradation)', async () => {
  const { fetchImpl } = makeFetch([
    () => { throw new Error('network down'); },
  ]);
  const points = [];
  const result = await fetchCailModels({ env: makeLogEnv(points), identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(points.length, 0, 'no drift event for a genuinely unreachable proxy');
});

test('caches the proxy list: a second call within TTL does not refetch', async () => {
  const { fetchImpl, calls } = makeFetch([listResponse(['@cf/zai-org/glm-5.2'])]);
  const first = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  const second = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(first.source, 'proxy');
  assert.equal(second.source, 'proxy');
  assert.deepEqual(second.models, first.models);
  assert.equal(calls.length, 1, 'second call served from cache');
});

test('does not cache fallbacks: a later success still fetches', async () => {
  // First call: proxy intentionally unconfigured -> fallback, no cache written.
  const failing = makeFetch([listResponse(['@cf/zai-org/glm-5.2'])]);
  const fb = await fetchCailModels({ env: {}, identityJwt: null, fetchImpl: failing.fetchImpl });
  assert.equal(fb.source, 'fallback');

  // Second call with a JWT should still hit the proxy.
  const ok = makeFetch([listResponse(['@cf/zai-org/glm-5.2'])]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl: ok.fetchImpl });
  assert.equal(result.source, 'proxy');
  assert.equal(ok.calls.length, 1);
});

test('surfaces all fields of a full new-schema entry', async () => {
  const { fetchImpl } = makeFetch([
    dataResponse([
      {
        id: '@cf/zai-org/glm-5.2',
        object: 'model',
        name: 'GLM 5.2',
        description: 'A capable general model.',
        task: 'text-generation',
        recommended: true,
        tier: 'recommended',
        order: 0,
        status: 'active',
        sunset: null,
        capabilities: ['text-generation', 'vision', 'function-calling'],
        context_length: 131072,
        registry_url: 'https://registry.example/glm-5.2',
      },
    ]),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'proxy');
  assert.deepEqual(result.models[0], {
    id: '@cf/zai-org/glm-5.2',
    recommended: true,
    tier: 'recommended',
    status: 'active',
    sunset: null,
    capabilities: ['text-generation', 'vision', 'function-calling'],
    contextLength: 131072,
    registryUrl: 'https://registry.example/glm-5.2',
    name: 'GLM 5.2',
    description: 'A capable general model.',
  });
});

test('parses a minimal legacy entry with normalized defaults', async () => {
  const { fetchImpl } = makeFetch([
    dataResponse([{ id: '@cf/zai-org/glm-5.2', object: 'model' }]),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'proxy');
  assert.deepEqual(result.models[0], {
    id: '@cf/zai-org/glm-5.2',
    recommended: true,
    tier: 'recommended',
    status: 'active',
    sunset: null,
    capabilities: [],
    contextLength: null,
    registryUrl: null,
    name: null,
    description: null,
  });
});

test('tier normalization precedence: explicit tier > recommended boolean > index-0', async () => {
  const { fetchImpl } = makeFetch([
    dataResponse([
      // data[0]: no flags → default (recommended:true), tier recommended by index.
      { id: '@cf/a', object: 'model' },
      // explicit tier wins even against a recommended:true flag.
      { id: '@cf/b', object: 'model', tier: 'advanced', recommended: true },
      // recommended:true (no tier) promotes a non-first entry to recommended tier.
      { id: '@cf/c', object: 'model', recommended: true },
      // nothing → advanced.
      { id: '@cf/d', object: 'model' },
      // unknown tier value falls through to the recommended/index logic (advanced here).
      { id: '@cf/e', object: 'model', tier: 'experimental' },
    ]),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.deepEqual(
    result.models.map((m) => ({ id: m.id, recommended: m.recommended, tier: m.tier })),
    [
      { id: '@cf/a', recommended: true, tier: 'recommended' },
      { id: '@cf/b', recommended: false, tier: 'advanced' },
      { id: '@cf/c', recommended: false, tier: 'recommended' },
      { id: '@cf/d', recommended: false, tier: 'advanced' },
      { id: '@cf/e', recommended: false, tier: 'advanced' },
    ]
  );
});

test('passes through retiring status and sunset date', async () => {
  const { fetchImpl } = makeFetch([
    dataResponse([
      { id: '@cf/a', object: 'model' },
      { id: '@cf/old', object: 'model', status: 'retiring', sunset: '2026-12-31' },
    ]),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  const retiring = result.models.find((m) => m.id === '@cf/old');
  assert.equal(retiring.status, 'retiring');
  assert.equal(retiring.sunset, '2026-12-31');
});

test('unknown status values normalize to active without failing the list', async () => {
  const { fetchImpl } = makeFetch([
    dataResponse([
      { id: '@cf/a', object: 'model', status: 'quarantined' },
      { id: '@cf/b', object: 'model' },
    ]),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'proxy');
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].status, 'active');
});
