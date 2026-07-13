import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  CF_VERSION_METADATA: {
    id: '11111111-1111-4111-8111-111111111111',
    tag: '',
    timestamp: '2026-07-13T14:00:00Z',
  },
};

test('required SESSION_SECRET configuration accepts a usable secret', () => {
  assert.deepEqual(
    validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...TELEMETRY }),
    { ok: true }
  );
});

test('identity enforcement requires a complete migration window', () => {
  assert.deepEqual(
    validateAgentStudioConfig({ SESSION_SECRET: SECRET, ...TELEMETRY, CAIL_REQUIRE_IDENTITY: 'true' }),
    { ok: false, errorCode: 'cail_sso_switched_at_missing' }
  );
  assert.deepEqual(
    validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_REQUIRE_IDENTITY: 'true',
      CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
    }),
    { ok: false, errorCode: 'cail_account_import_until_missing' }
  );
});

test('migration window accepts complete ISO instants and an exact 30-day duration', () => {
  assert.equal(parseIsoInstant('2026-07-13T10:00:00-04:00'), Date.parse(SWITCHED_AT));
  assert.deepEqual(
    validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      ...TELEMETRY,
      CAIL_REQUIRE_IDENTITY: 'true',
      CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
      CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
    }),
    { ok: true }
  );
  assert.equal(Date.parse(IMPORT_UNTIL) - Date.parse(SWITCHED_AT), MAX_ACCOUNT_IMPORT_WINDOW_MS);
});

test('migration window rejects malformed instants, reverse order, and durations over 30 days', () => {
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
    CAIL_SSO_SWITCHED_AT: SWITCHED_AT,
  };
  assert.deepEqual(
    validateAgentStudioConfig({
      ...base,
      CAIL_SSO_SWITCHED_AT: '2026-07-13',
      CAIL_ACCOUNT_IMPORT_UNTIL: IMPORT_UNTIL,
    }),
    { ok: false, errorCode: 'cail_sso_switched_at_invalid' }
  );
  assert.deepEqual(
    validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: 'invalid' }),
    { ok: false, errorCode: 'cail_account_import_until_invalid' }
  );
  assert.deepEqual(
    validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: '2026-07-13T13:59:59Z' }),
    { ok: false, errorCode: 'cail_account_import_until_before_switch' }
  );
  assert.deepEqual(
    validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: '2026-08-12T14:00:00.001Z' }),
    { ok: false, errorCode: 'cail_account_import_window_too_long' }
  );
  assert.deepEqual(
    validateAgentStudioConfig({ ...base, CAIL_ACCOUNT_IMPORT_UNTIL: SWITCHED_AT }),
    { ok: true }
  );
});

test('telemetry readiness requires a classified environment and Worker version metadata', () => {
  assert.deepEqual(validateAgentStudioConfig({ SESSION_SECRET: SECRET }), {
    ok: false,
    errorCode: 'cail_log_environment_missing',
  });
  assert.deepEqual(
    validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_LOG_ENV: 'preview' }),
    { ok: false, errorCode: 'cail_log_environment_invalid' },
  );
  assert.deepEqual(
    validateAgentStudioConfig({ SESSION_SECRET: SECRET, CAIL_LOG_ENV: 'test' }),
    { ok: false, errorCode: 'worker_version_metadata_missing' },
  );
  assert.deepEqual(
    validateAgentStudioConfig({
      SESSION_SECRET: SECRET,
      CAIL_LOG_ENV: 'test',
      CF_VERSION_METADATA: { id: '', tag: '', timestamp: '' },
    }),
    { ok: false, errorCode: 'worker_version_metadata_invalid' },
  );
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

test('required SESSION_SECRET configuration rejects missing and short values', () => {
  assert.deepEqual(validateAgentStudioConfig({}), {
    ok: false,
    errorCode: 'session_secret_missing',
  });
  assert.deepEqual(validateAgentStudioConfig({ SESSION_SECRET: 'too-short' }), {
    ok: false,
    errorCode: 'session_secret_too_short',
  });
});
