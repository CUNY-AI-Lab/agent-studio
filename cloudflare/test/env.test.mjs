import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER } from '@cuny-ai-lab/cail-identity';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';

import {
  accountImportWindowState,
  legacyAccountCompatibilityAllowed,
  MAX_ACCOUNT_IMPORT_WINDOW_MS,
  MIN_REQUIRED_SESSION_SECRET_LENGTH,
  parseIsoInstant,
  validateAgentStudioConfig,
} from '../src/env.ts';

const SECRET = 'x'.repeat(MIN_REQUIRED_SESSION_SECRET_LENGTH);
const SWITCHED_AT = '2026-07-13T14:00:00Z';
const IMPORT_UNTIL = '2026-08-12T14:00:00Z';
const TELEMETRY = {
  CAIL_LOG_ENV: 'test',
  CAIL_FLEET_EVENTS: { writeDataPoint() {} },
  CF_VERSION_METADATA: {
    id: '11111111-1111-4111-8111-111111111111',
    tag: '',
    timestamp: '2026-07-13T14:00:00Z',
  },
};

const productionIssuer = await createTestIdentityIssuer({ kid: 'active' });
const PRODUCTION = {
  ...TELEMETRY,
  CAIL_LOG_ENV: 'production',
  CAIL_REQUIRE_IDENTITY: 'true',
  CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  CAIL_IDENTITY_JWKS: productionIssuer.jwksJson,
  CAIL_API_BASE: 'https://model-proxy.example',
  CAIL_CANONICAL_ORIGIN: 'https://tools.example',
  CAIL_BASE_PATH: '/agent-studio',
  API_RATE_LIMIT: { limit() {} },
  HEAVY_RATE_LIMIT: { limit() {} },
  GALLERY_OWNER_KEYS: JSON.stringify({ active: 'g'.repeat(32) }),
  GALLERY_OWNER_ACTIVE_KEY_ID: 'active',
  CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
  CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
  GATEWAY: { fetch() {} },
};

function deeplyNestedJwks(rawJwks, depth = 5000) {
  const nestedMetadata = `${'{"nested":'.repeat(depth)}"x"${'}'.repeat(depth)}`;
  return `${rawJwks.slice(0, -1)},"metadata":${nestedMetadata}}`;
}

test('required SESSION_SECRET configuration accepts a usable secret', async () => {
  assert.deepEqual(
    await validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...TELEMETRY }),
    { ok: true }
  );
});

test('identity enforcement requires a complete migration window', async () => {
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_REQUIRE_IDENTITY: 'true',
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    }),
    { ok: false, errorCode: 'cail_sso_switched_at_missing' }
  );
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_REQUIRE_IDENTITY: 'true',
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
      CAIL_IDENTITY_JWKS: productionIssuer.jwksJson,
      CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
    }),
    { ok: false, errorCode: 'cail_account_import_until_missing' }
  );
});

test('migration window accepts complete ISO instants and an exact 30-day duration', async () => {
  assert.equal(parseIsoInstant('2026-07-13T10:00:00-04:00'), Date.parse(SWITCHED_AT));
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_REQUIRE_IDENTITY: 'true',
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
      CAIL_IDENTITY_JWKS: productionIssuer.jwksJson,
      CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
      CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
    }),
    { ok: true }
  );
  assert.equal(Date.parse(IMPORT_UNTIL) - Date.parse(SWITCHED_AT), MAX_ACCOUNT_IMPORT_WINDOW_MS);
});

test('migration window rejects malformed instants, reverse order, and durations over 30 days', async () => {
  for (const value of [
    '2026-07-13',
    '2026-07-13T14:00:00',
    '2026-02-30T14:00:00Z',
    'not-an-instant',
  ]) {
    assert.equal(parseIsoInstant(value), null, value);
  }

  const base = {
    SESSION_SECRET: SECRET,
    ...TELEMETRY,
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_IDENTITY_JWKS: productionIssuer.jwksJson,
    CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
  };
  assert.deepEqual(
    await validateAgentStudioConfig({
      ...base,
      CAIL_SSO_SWITCHED_AT: '2026-07-13',
      CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
    }),
    { ok: false, errorCode: 'cail_sso_switched_at_invalid' }
  );
  assert.deepEqual(
    await validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: 'invalid' }),
    { ok: false, errorCode: 'cail_account_import_until_invalid' }
  );
  assert.deepEqual(
    await validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: '2026-07-13T13:59:59Z' }),
    { ok: false, errorCode: 'cail_account_import_until_before_switch' }
  );
  assert.deepEqual(
    await validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: '2026-08-12T14:00:00.001Z' }),
    { ok: false, errorCode: 'cail_account_import_window_too_long' }
  );
  assert.deepEqual(
    await validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: SWITCHED_AT }),
    { ok: true }
  );
});

test('telemetry readiness requires a classified environment and Worker version metadata', async () => {
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET }), {
    ok: false,
    errorCode: 'cail_log_environment_missing',
  });
  assert.deepEqual(
    await validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_LOG_ENV: 'preview' }),
    { ok: false, errorCode: 'cail_log_environment_invalid' },
  );
  assert.deepEqual(
    await validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_LOG_ENV: 'test' }),
    { ok: false, errorCode: 'worker_version_metadata_missing' },
  );
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      CAIL_LOG_ENV: 'test',
      CF_VERSION_METADATA: { id: '', tag: '', timestamp: '' },
    }),
    { ok: false, errorCode: 'worker_version_metadata_invalid' },
  );
  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_LOG_ENV: 'test',
    CF_VERSION_METADATA: TELEMETRY.CF_VERSION_METADATA,
  }), { ok: false, errorCode: 'cail_fleet_events_missing' });
  assert.deepEqual(await validateAgentStudioConfig({
    SESSION_SECRET: SECRET,
    CAIL_LOG_ENV: 'test',
    CF_VERSION_METADATA: TELEMETRY.CF_VERSION_METADATA,
    CAIL_FLEET_EVENTS: {},
  }), { ok: false, errorCode: 'cail_fleet_events_invalid' });
});

test('environment classification is exact and never accepts drifted production labels', async () => {
  for (const value of ['', ' production', 'production ', 'Production', 'candidate']) {
    assert.deepEqual(
      await validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_LOG_ENV: value }),
      {
        ok: false,
        errorCode: value === '' ? 'cail_log_environment_missing' : 'cail_log_environment_invalid',
      },
      value,
    );
  }
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET }), {
    ok: false,
    errorCode: 'cail_log_environment_missing',
  });
});

test('migration compatibility opens at the switch and closes at the deadline', () => {
  const env = {
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
    CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
  };
  assert.equal(accountImportWindowState(env, Date.parse(SWITCHED_AT) - 1), 'not-started');
  assert.equal(accountImportWindowState(env, Date.parse(SWITCHED_AT)), 'open');
  assert.equal(accountImportWindowState(env, Date.parse(IMPORT_UNTIL) - 1), 'open');
  assert.equal(accountImportWindowState(env, Date.parse(IMPORT_UNTIL)), 'expired');
  assert.equal(accountImportWindowState(env, Date.parse(IMPORT_UNTIL) + 1), 'expired');
  assert.equal(legacyAccountCompatibilityAllowed(env, Date.parse(IMPORT_UNTIL) + 1), false);
  assert.equal(legacyAccountCompatibilityAllowed({}, Date.now()), true);
});

test('required SESSION_SECRET configuration rejects missing and short values', async () => {
  assert.deepEqual(await validateAgentStudioConfig({}), {
    ok: false,
    errorCode: 'session_secret_missing',
  });
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: 'too-short' }), {
    ok: false,
    errorCode: 'session_secret_too_short',
  });
});

test('production fails closed unless identity, route, proxy, and rate boundaries are explicit', async () => {
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...PRODUCTION }), { ok: true });

  const cases = [
    ['CAIL_REQUIRE_IDENTITY', 'false', 'production_identity_required'],
    ['CAIL_IDENTITY_ISSUER', undefined, 'cail_identity_issuer_missing'],
    ['CAIL_IDENTITY_ISSUER', CAIL_STAGING_ISSUER, 'cail_identity_issuer_environment_mismatch'],
    ['CAIL_IDENTITY_ISSUER', 'https://evil.example/cail-sso', 'cail_identity_issuer_invalid'],
    ['CAIL_IDENTITY_JWKS', '', 'production_identity_jwks_missing'],
    ['CAIL_IDENTITY_JWKS', '{}', 'production_identity_jwks_invalid'],
    ['CAIL_IDENTITY_JWKS', JSON.stringify({ keys: [{ kty: 'RSA', kid: 'active' }] }), 'production_identity_jwks_invalid'],
    ['CAIL_API_BASE', 'http://model-proxy.example', 'production_api_base_invalid'],
    ['CAIL_MODEL', 'cail/gpt-4.1-nano', 'cail_model_invalid'],
    ['CAIL_CANONICAL_ORIGIN', 'https://tools.example/path', 'production_canonical_origin_invalid'],
    ['CAIL_BASE_PATH', '', 'production_base_path_missing'],
    ['CAIL_BASE_PATH', '/agent%2fother', 'production_base_path_invalid'],
    ['CAIL_BASE_PATH', '/', 'production_base_path_root'],
    ['API_RATE_LIMIT', undefined, 'production_api_rate_limit_missing'],
    ['HEAVY_RATE_LIMIT', undefined, 'production_heavy_rate_limit_missing'],
    ['GALLERY_OWNER_KEYS', undefined, 'production_gallery_owner_keys_missing'],
    ['GALLERY_OWNER_KEYS', '{}', 'production_gallery_owner_keys_invalid'],
    ['GALLERY_OWNER_ACTIVE_KEY_ID', 'missing', 'production_gallery_owner_active_key_missing'],
    ['GATEWAY', undefined, 'production_gateway_binding_missing'],
  ];
  for (const [key, value, errorCode] of cases) {
    assert.deepEqual(
      await validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...PRODUCTION, [key]: value }),
      { ok: false, errorCode },
      key,
    );
  }
});

test('production JWKS startup validation uses the shared eligible-key contract', async () => {
  const validJwks = JSON.parse(PRODUCTION.CAIL_IDENTITY_JWKS);
  const validKey = validJwks.keys[0];
  const invalidJwks = [
    ['non-base64url modulus', { keys: [{ ...validKey, n: 'not base64!' }] }],
    ['undersized modulus', { keys: [{ ...validKey, n: 'AQ' }] }],
    ['private key material', { keys: [{ ...validKey, d: 'private' }] }],
    ['duplicate kid', { keys: [validKey, { ...validKey }] }],
  ];

  for (const [label, jwks] of invalidJwks) {
    assert.deepEqual(
      await validateAgentStudioConfig({
        SESSION_SECRET: SECRET,
        ...PRODUCTION,
        CAIL_IDENTITY_JWKS: JSON.stringify(jwks),
      }),
      { ok: false, errorCode: 'production_identity_jwks_invalid' },
      label,
    );
  }
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...PRODUCTION,
      CAIL_IDENTITY_JWKS: deeplyNestedJwks(PRODUCTION.CAIL_IDENTITY_JWKS),
    }),
    { ok: false, errorCode: 'production_identity_jwks_invalid' },
    'deeply nested metadata',
  );
});

test('identity-required staging validates JWKS at startup and never reuses a prior config', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'staging-cache-key' });
  const staging = {
    ...TELEMETRY,
    CAIL_LOG_ENV: 'staging',
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_ISSUER: CAIL_STAGING_ISSUER,
    CAIL_IDENTITY_JWKS: issuer.jwksJson,
    CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
    CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
  };
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...staging }), { ok: true });

  const changedJwks = JSON.parse(issuer.jwksJson);
  changedJwks.keys[0].n = 'AQ';
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...staging,
      CAIL_IDENTITY_JWKS: JSON.stringify(changedJwks),
    }),
    { ok: false, errorCode: 'cail_identity_jwks_invalid' },
  );
  assert.deepEqual(await validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...staging }), { ok: true });
});

test('a whitespace identity issuer is configured and rejected before runtime verification', async () => {
  assert.deepEqual(
    await validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_IDENTITY_ISSUER: '   ',
    }),
    { ok: false, errorCode: 'cail_identity_issuer_invalid' },
  );
});

test('identity remains optional only when both issuer and JWKS are absent', async () => {
  const base = { SESSION_SECRET: SECRET, ...TELEMETRY };
  assert.deepEqual(await validateAgentStudioConfig(base), { ok: true });
  assert.deepEqual(
    await validateAgentStudioConfig({
      ...base,
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    }),
    { ok: false, errorCode: 'cail_identity_jwks_missing' },
  );
  assert.deepEqual(
    await validateAgentStudioConfig({
      ...base,
      CAIL_IDENTITY_JWKS: productionIssuer.jwksJson,
    }),
    { ok: false, errorCode: 'cail_identity_issuer_missing' },
  );
});
