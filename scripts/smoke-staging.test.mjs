import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingCredentials } from './smoke-staging.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const STAGING_URL = 'https://staging.example.test/agent-studio';

function envWithoutIdentity() {
  const env = { ...process.env };
  delete env.AGENT_STUDIO_APP_IDENTITY_JWT;
  delete env.AGENT_STUDIO_GATEWAY_IDENTITY_JWT;
  return env;
}

test('staging API-only smoke permits an app-only environment', () => {
  assert.doesNotThrow(() => assertStagingCredentials(
    ['--with-chat=false'],
    {
      AGENT_STUDIO_STAGING_URL: STAGING_URL,
      AGENT_STUDIO_APP_IDENTITY_JWT: 'app-jwt',
    },
  ));
});

test('staging chat rejects a missing keyring leg before network startup', () => {
  for (const env of [
    { AGENT_STUDIO_STAGING_URL: STAGING_URL },
    { AGENT_STUDIO_STAGING_URL: STAGING_URL, AGENT_STUDIO_APP_IDENTITY_JWT: 'app-jwt' },
    { AGENT_STUDIO_STAGING_URL: STAGING_URL, AGENT_STUDIO_GATEWAY_IDENTITY_JWT: 'gateway-jwt' },
  ]) {
    assert.throws(
      () => assertStagingCredentials(['--with-chat=true'], env),
      /requires both AGENT_STUDIO_APP_IDENTITY_JWT and AGENT_STUDIO_GATEWAY_IDENTITY_JWT/,
    );
  }

  assert.throws(
    () => assertStagingCredentials(['--with-chat=false'], {}),
    /AGENT_STUDIO_STAGING_URL is required/,
  );
  assert.throws(
    () => assertStagingCredentials(
      ['--with-chat=false', `--base-url=${STAGING_URL}`],
      { AGENT_STUDIO_STAGING_URL: STAGING_URL },
    ),
    /must be supplied through the environment/,
  );
  assert.throws(
    () => assertStagingCredentials(['--with-chat=false'], { AGENT_STUDIO_STAGING_URL: 'http://localhost:8787' }),
    /absolute HTTPS URL/,
  );

  const documentedEnv = envWithoutIdentity();
  documentedEnv.AGENT_STUDIO_STAGING_URL = STAGING_URL;
  documentedEnv.AGENT_STUDIO_APP_IDENTITY_JWT = 'app-secret-value';
  const result = spawnSync(
    process.execPath,
    ['scripts/smoke-staging.mjs', '--with-chat=true'],
    { cwd: REPO_ROOT, env: documentedEnv, encoding: 'utf8', timeout: 5000 },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /\[smoke\] staging validation failed/);
  assert.doesNotMatch(output, /health|https:\/\/staging\.example\.test|app-secret-value|workspace|prompt|response|raw error|true|false/i);
});
