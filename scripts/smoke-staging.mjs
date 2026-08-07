import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  identityCredentialsFromEnv,
  parseArgs,
} from './_debug-common.mjs';

const WORKER_PATH = fileURLToPath(new URL('./smoke-worker.mjs', import.meta.url));
const STAGING_URL_ENV = 'AGENT_STUDIO_STAGING_URL';

/**
 * The staging profile may run an API-only smoke with the app leg alone, but a
 * staging chat smoke must not touch the deployment until both keyring legs are
 * present. This check intentionally lives in the staging wrapper rather than
 * the generic worker so local anonymous `--with-chat=true` remains available.
 */
export function assertStagingCredentials(argv = [], env = process.env) {
  const args = parseArgs(argv);
  if (args['base-url']) {
    throw new Error(`${STAGING_URL_ENV} must be supplied through the environment, not --base-url`);
  }

  const stagingUrl = typeof env[STAGING_URL_ENV] === 'string' ? env[STAGING_URL_ENV].trim() : '';
  if (!stagingUrl) {
    throw new Error(`${STAGING_URL_ENV} is required`);
  }

  if (args['with-chat'] === 'true') {
    const { appIdentityJwt, gatewayIdentityJwt } = identityCredentialsFromEnv(env);
    if (!appIdentityJwt || !gatewayIdentityJwt) {
      throw new Error(
        'staging chat requires both AGENT_STUDIO_APP_IDENTITY_JWT and AGENT_STUDIO_GATEWAY_IDENTITY_JWT',
      );
    }
  }

  return stagingUrl;
}

export function runStagingSmoke(argv = process.argv.slice(2), env = process.env) {
  const stagingUrl = assertStagingCredentials(argv, env);

  return new Promise((resolveRun, rejectRun) => {
    // Keep the staging profile redacted even if an extra `--quiet=false` is
    // supplied after the package script's defaults.
    const child = spawn(process.execPath, [WORKER_PATH, ...argv, '--base-url', stagingUrl, '--quiet=true'], {
      env,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`staging smoke terminated by ${signal}`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const exitCode = await runStagingSmoke();
    process.exitCode = exitCode;
  } catch {
    // Staging output is a boolean receipt stream. Never echo validation or
    // child-process details, which could contain deployment-specific data.
    console.error('[smoke] failed: false');
    process.exitCode = 1;
  }
}
