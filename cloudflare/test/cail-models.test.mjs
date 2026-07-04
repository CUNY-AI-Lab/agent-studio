// Unit tests for the CAIL model-catalog client (lib/cail-models.ts): proxy
// shape parsing + first-entry-recommended, fallback on missing base / JWT /
// upstream 500 / bad shape, no-retry-on-4xx, and the 5-minute proxy cache.
// Runs on node:test with tsx, no extra deps. A counting fetch double lets us
// assert refetch behavior; resetCailModelsCache clears module-global state.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCailModels,
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

beforeEach(() => {
  resetCailModelsCache();
});

test('parses the proxy list and marks the first entry recommended', async () => {
  const { fetchImpl, calls } = makeFetch([
    listResponse(['@cf/zai-org/glm-5.2', '@cf/openai/gpt-oss-120b', '@cf/meta/llama-3']),
  ]);

  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });

  assert.equal(result.source, 'proxy');
  assert.deepEqual(result.models, [
    { id: '@cf/zai-org/glm-5.2', recommended: true },
    { id: '@cf/openai/gpt-oss-120b', recommended: false },
    { id: '@cf/meta/llama-3', recommended: false },
  ]);

  // Sanity: it hit /models with the identity + app headers, no Bearer key.
  const req = new Request(calls[0].url, calls[0].init);
  assert.equal(new URL(req.url).pathname, '/models');
  assert.equal(req.headers.get(CAIL_IDENTITY_HEADER), JWT);
  assert.equal(req.headers.get('X-CAIL-App'), CAIL_APP_SLUG);
  assert.equal(req.headers.get('authorization'), null);
});

test('falls back to the configured default when CAIL_API_BASE is unset', async () => {
  const { fetchImpl, calls } = makeFetch([listResponse(['@cf/should-not-be-used'])]);
  const result = await fetchCailModels({
    env: { CAIL_MODEL: '@cf/openai/gpt-oss-120b' },
    identityJwt: JWT,
    fetchImpl,
  });
  assert.equal(result.source, 'fallback');
  assert.deepEqual(result.models, [{ id: '@cf/openai/gpt-oss-120b', recommended: true }]);
  assert.equal(calls.length, 0, 'no request without a base URL');
});

test('falls back to the default model when the JWT is null', async () => {
  const { fetchImpl, calls } = makeFetch([listResponse(['@cf/x'])]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: null, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.deepEqual(result.models, [{ id: DEFAULT_CAIL_MODEL, recommended: true }]);
  assert.equal(calls.length, 0);
});

test('falls back on a 500 after retrying once', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => new Response('boom', { status: 500 }),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length, 2, '5xx is retried once');
});

test('does not retry a 4xx and falls back immediately', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => new Response('nope', { status: 403 }),
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length, 1, '4xx is not retried');
});

test('retries once on a network error, then falls back', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => { throw new Error('network down'); },
  ]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl });
  assert.equal(result.source, 'fallback');
  assert.equal(calls.length, 2, 'network error is retried once');
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
  assert.deepEqual(result.models, [{ id: DEFAULT_CAIL_MODEL, recommended: true }]);
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
  // First call: base set but JWT null → fallback, no cache written.
  const failing = makeFetch([listResponse(['@cf/zai-org/glm-5.2'])]);
  const fb = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: null, fetchImpl: failing.fetchImpl });
  assert.equal(fb.source, 'fallback');

  // Second call with a JWT should still hit the proxy.
  const ok = makeFetch([listResponse(['@cf/zai-org/glm-5.2'])]);
  const result = await fetchCailModels({ env: { CAIL_API_BASE: BASE }, identityJwt: JWT, fetchImpl: ok.fetchImpl });
  assert.equal(result.source, 'proxy');
  assert.equal(ok.calls.length, 1);
});
