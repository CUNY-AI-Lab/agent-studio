import assert from 'node:assert/strict';
import test from 'node:test';
import { CAIL_CANONICAL_ISSUER } from '../src/lib/cail-identity.ts';
import { createTestIdentityIssuer } from './helpers/identity.mjs';
import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();
const { AgentStudioReadiness } = await import('../src/lib/readiness.ts');

function baseEnv(overrides = {}) {
  return {
    SESSION_SECRET: 'a'.repeat(64),
    CAIL_REQUIRE_IDENTITY: 'false',
    CF_VERSION_METADATA: {
      id: 'version-id',
      tag: 'commit-sha',
      timestamp: '2026-08-23T00:00:00.000Z',
    },
    ...overrides,
  };
}

test('private readiness returns only bounded config and deployed version metadata', async () => {
  const readiness = new AgentStudioReadiness({}, baseEnv());

  assert.deepEqual(await readiness.getReadiness(), {
    ok: true,
    service: 'agent-studio',
    configuration: 'ready',
    version_id: 'version-id',
    tag: 'commit-sha',
  });
});

test('private readiness fails closed when version metadata is unavailable', async () => {
  const readiness = new AgentStudioReadiness({}, baseEnv({ CF_VERSION_METADATA: undefined }));
  const result = await readiness.getReadiness();

  assert.deepEqual(result, {
    ok: false,
    service: 'agent-studio',
    configuration: 'ready',
    version_id: null,
    tag: null,
  });
});

test('private readiness reports invalid production identity configuration without exposing its reason', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'readiness-key' });
  const readiness = new AgentStudioReadiness({}, baseEnv({
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_IDENTITY_JWKS: issuer.jwksJson,
    CAIL_API_BASE: 'https://tools.ailab.gc.cuny.edu',
    CAIL_CANONICAL_ORIGIN: 'https://tools.ailab.gc.cuny.edu',
    CAIL_BASE_PATH: '/agent-studio',
    GATEWAY: { fetch },
  }));

  assert.deepEqual(await readiness.getReadiness(), {
    ok: true,
    service: 'agent-studio',
    configuration: 'ready',
    version_id: 'version-id',
    tag: 'commit-sha',
  });

  const invalid = new AgentStudioReadiness({}, baseEnv({
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_IDENTITY_JWKS: '{invalid',
  }));
  assert.deepEqual(await invalid.getReadiness(), {
    ok: false,
    service: 'agent-studio',
    configuration: 'not_ready',
    version_id: 'version-id',
    tag: 'commit-sha',
  });
});
