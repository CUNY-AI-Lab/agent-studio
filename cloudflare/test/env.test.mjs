import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestIdentityIssuer } from './helpers/identity.mjs';
import {
  CAIL_CANONICAL_ISSUER,
} from '../src/lib/cail-identity.ts';
import {
  MIN_REQUIRED_SESSION_SECRET_LENGTH,
  validateAgentStudioConfig,
} from '../src/env.ts';

const SECRET = 's'.repeat(MIN_REQUIRED_SESSION_SECRET_LENGTH);
const identityIssuer = await createTestIdentityIssuer({ kid: 'config-key' });
const DEPLOYED = {
  SESSION_SECRET: SECRET,
  CAIL_REQUIRE_IDENTITY: 'true',
  CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  CAIL_IDENTITY_JWKS: identityIssuer.jwksJson,
  CAIL_API_BASE: 'https://model-api.example.edu',
  CAIL_MODEL: '@cf/zai-org/glm-5.2',
  GATEWAY: { fetch() {} },
  CAIL_CANONICAL_ORIGIN: 'https://tools.example.edu',
  CAIL_BASE_PATH: '/agent-studio',
};

test('anonymous local configuration needs only a usable session secret', async () => {
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET }), { ok: true });
  assert.deepEqual(await validateAgentStudioConfig({}), {
    ok: false,
    errorCode: 'session_secret_missing',
  });
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: 'short' }), {
    ok: false,
    errorCode: 'session_secret_too_short',
  });
});

test('malformed runtime configuration values fail closed without throwing', async () => {
  for (const SESSION_SECRET of [123, {}, true]) {
    assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET }), {
      ok: false,
      errorCode: 'session_secret_missing',
    });
  }
  for (const CAIL_IDENTITY_JWKS of [123, {}, true]) {
    assert.deepEqual(await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
      CAIL_IDENTITY_JWKS,
    }), {
      ok: false,
      errorCode: 'cail_identity_jwks_invalid',
    });
  }
});

test('model id and API base validation reject unsafe or placeholder values', async () => {
  for (const CAIL_MODEL of ['openai/gpt', 'cail/gpt-4.1', '@cf/']) {
    assert.deepEqual(
      await validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_MODEL }),
      { ok: false, errorCode: 'cail_model_invalid' },
    );
  }
  for (const CAIL_API_BASE of [
    'http://model-api.example.edu',
    'https://user:password@model-api.example.edu',
    'https://model-api.example.edu?token=x',
    'https://model-api.invalid',
    ' https://model-api.example.edu',
  ]) {
    assert.deepEqual(
      await validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_API_BASE }),
      { ok: false, errorCode: 'cail_api_base_invalid' },
    );
  }
});

test('identity configuration is exact and partial configuration fails closed', async () => {
  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_REQUIRE_IDENTITY: 'true',
  }), { ok: false, errorCode: 'cail_identity_issuer_missing' });

  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  }), { ok: false, errorCode: 'cail_identity_jwks_missing' });

  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_IDENTITY_ISSUER: 'https://untrusted.example.edu/sso',
    CAIL_IDENTITY_JWKS: identityIssuer.jwksJson,
  }), { ok: false, errorCode: 'cail_identity_issuer_invalid' });

  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_IDENTITY_JWKS: '{not json',
  }), { ok: false, errorCode: 'cail_identity_jwks_invalid' });
});

test('deployed identity profile requires the real route and gateway boundaries', async () => {
  assert.deepEqual(await validateAgentStudioConfig(DEPLOYED), { ok: true });
  const cases = [
    ['GATEWAY', undefined, 'production_gateway_binding_missing'],
    ['GATEWAY', { fetch: 'not-callable' }, 'production_gateway_binding_missing'],
    ['CAIL_API_BASE', undefined, 'cail_api_base_invalid'],
    ['CAIL_CANONICAL_ORIGIN', undefined, 'production_canonical_origin_invalid'],
    ['CAIL_CANONICAL_ORIGIN', 'https://tools.example.edu/path', 'production_canonical_origin_invalid'],
    ['CAIL_BASE_PATH', undefined, 'production_base_path_missing'],
    ['CAIL_BASE_PATH', '/', 'production_base_path_root'],
    ['CAIL_BASE_PATH', '/agent%2fother', 'production_base_path_invalid'],
  ];
  for (const [key, value, errorCode] of cases) {
    assert.deepEqual(
      await validateAgentStudioConfig({ ...DEPLOYED, [key]: value }),
      { ok: false, errorCode },
      key,
    );
  }
});

test('identity verifier validation follows current JWKS contents, not a previous result', async () => {
  assert.deepEqual(await validateAgentStudioConfig(DEPLOYED), { ok: true });
  const malformed = JSON.parse(identityIssuer.jwksJson);
  malformed.keys[0].n = 'AQ';
  assert.deepEqual(await validateAgentStudioConfig({
    ...DEPLOYED,
    CAIL_IDENTITY_JWKS: JSON.stringify(malformed),
  }), { ok: false, errorCode: 'cail_identity_jwks_invalid' });
});
