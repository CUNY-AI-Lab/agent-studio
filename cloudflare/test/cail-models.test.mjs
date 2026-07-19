import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCailModels,
  ModelCatalogAuthError,
  ModelCatalogQuotaError,
  ModelCatalogUnavailableError,
} from '../src/lib/cail-models.ts';
import { CAIL_APP_SLUG } from '../src/lib/cail-identity.ts';

const BASE = 'https://models.example/v1';
const JWT = 'header.payload.signature';

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

function listResponse(data) {
  return () => Response.json({ object: 'list', data });
}

function errorResponse(status, type, message) {
  return () => Response.json({
    error: { message, type, param: null, code: String(status) },
  }, { status });
}

test('reads the authenticated standard model list with bearer identity', async () => {
  const { fetchImpl, calls } = makeFetch([
    listResponse([
      { id: 'cail/default', object: 'model' },
      { id: 'cail/nova-lite', object: 'model' },
      { id: 'cail/workers-llama-3.1-8b', object: 'model' },
    ]),
  ]);
  const result = await fetchCailModels({
    env: { CAIL_OPENAI_BASE_URL: BASE },
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

  assert.equal(result.source, 'gateway');
  assert.deepEqual(
    result.models.map(({ id, recommended, tier }) => ({ id, recommended, tier })),
    [
      { id: 'cail/default', recommended: true, tier: 'recommended' },
      { id: 'cail/nova-lite', recommended: false, tier: 'advanced' },
      { id: 'cail/workers-llama-3.1-8b', recommended: false, tier: 'advanced' },
    ],
  );

  const request = new Request(calls[0].url, calls[0].init);
  assert.equal(request.url, `${BASE}/models`);
  assert.equal(request.headers.get('authorization'), `Bearer ${JWT}`);
  assert.equal(request.headers.get('x-cail-identity-jwt'), null);
  assert.equal(request.headers.get('x-cail-app'), CAIL_APP_SLUG);
  assert.equal(request.headers.get('traceparent'), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`);
  assert.equal(request.headers.get('tracestate'), 'cail=catalog');
  assert.equal(request.headers.get('x-cail-request-id'), '11111111-1111-4111-8111-111111111111');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('requires both gateway configuration and identity', async () => {
  await assert.rejects(
    fetchCailModels({ env: {}, identityJwt: JWT }),
    ModelCatalogUnavailableError,
  );
  await assert.rejects(
    fetchCailModels({
      env: { CAIL_OPENAI_BASE_URL: BASE },
      identityJwt: null,
    }),
    ModelCatalogAuthError,
  );
});

test('maps standard authentication and budget responses', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = makeFetch([
      errorResponse(status, 'authentication_error', `auth failed ${status}`),
    ]);
    await assert.rejects(
      fetchCailModels({
        env: { CAIL_OPENAI_BASE_URL: BASE },
        identityJwt: JWT,
        fetchImpl,
      }),
      (error) => error instanceof ModelCatalogAuthError
        && error.message === `auth failed ${status}`,
    );
  }

  const { fetchImpl } = makeFetch([
    errorResponse(429, 'budget_exceeded', 'budget exceeded'),
  ]);
  await assert.rejects(
    fetchCailModels({
      env: { CAIL_OPENAI_BASE_URL: BASE },
      identityJwt: JWT,
      fetchImpl,
    }),
    (error) => error instanceof ModelCatalogQuotaError
      && error.message === 'budget exceeded',
  );
});

test('fails clearly on network, server, and response-shape errors', async () => {
  for (const responder of [
    () => { throw new Error('network down'); },
    () => new Response('boom', { status: 500 }),
    () => Response.json({ object: 'list', data: [] }),
  ]) {
    const { fetchImpl } = makeFetch([responder]);
    await assert.rejects(
      fetchCailModels({
        env: { CAIL_OPENAI_BASE_URL: BASE },
        identityJwt: JWT,
        fetchImpl,
      }),
      ModelCatalogUnavailableError,
    );
  }
});

test('does not cache one user’s authenticated model list for another user', async () => {
  const { fetchImpl, calls } = makeFetch([
    listResponse([{ id: 'cail/default', object: 'model' }]),
    listResponse([{ id: 'cail/research', object: 'model' }]),
  ]);

  const first = await fetchCailModels({
    env: { CAIL_OPENAI_BASE_URL: BASE },
    identityJwt: JWT,
    fetchImpl,
  });
  const second = await fetchCailModels({
    env: { CAIL_OPENAI_BASE_URL: BASE },
    identityJwt: 'other.header.signature',
    fetchImpl,
  });

  assert.equal(first.models[0].id, 'cail/default');
  assert.equal(second.models[0].id, 'cail/research');
  assert.equal(calls.length, 2);
});

test('tolerates optional display metadata without making it authoritative', async () => {
  const { fetchImpl } = makeFetch([
    listResponse([{
      id: 'cail/default',
      object: 'model',
      name: 'CAIL Default',
      description: 'Current recommended model.',
      capabilities: ['text-generation', 'function-calling'],
      context_length: 131072,
      registry_url: 'https://models.example/catalog/default',
      status: 'retiring',
      sunset: '2027-01-01',
    }]),
  ]);
  const result = await fetchCailModels({
    env: { CAIL_OPENAI_BASE_URL: BASE },
    identityJwt: JWT,
    fetchImpl,
  });
  assert.deepEqual(result.models[0], {
    id: 'cail/default',
    recommended: true,
    tier: 'recommended',
    status: 'retiring',
    sunset: '2027-01-01',
    capabilities: ['text-generation', 'function-calling'],
    contextLength: 131072,
    registryUrl: 'https://models.example/catalog/default',
    name: 'CAIL Default',
    description: 'Current recommended model.',
  });
});
