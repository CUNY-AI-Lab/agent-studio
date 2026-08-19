import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  identityCredentialsFromEnv,
  parseArgs,
} from './smoke-common.mjs';

const WORKER_PATH = fileURLToPath(new URL('./smoke-worker.mjs', import.meta.url));
const STAGING_URL_ENV = 'AGENT_STUDIO_STAGING_URL';

/**
 * Staging always validates its base URL before starting the worker. An
 * authenticated chat smoke must have both identity-keyring legs before it
 * contacts the deployment; local anonymous smoke remains available through
 * smoke-worker.
 */
export function assertStagingCredentials(argv = [], env = process.env) {
  const args = parseArgs(argv);
  if (args['base-url']) {
    throw new Error(`${STAGING_URL_ENV} must be supplied through the environment, not --base-url`);
  }

  const stagingValue = env[STAGING_URL_ENV];
  const stagingUrl = z.string().safeParse(stagingValue).success
    ? stagingValue.trim()
    : '';
  if (!stagingUrl) {
    throw new Error(`${STAGING_URL_ENV} is required`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(stagingUrl);
  } catch {
    throw new Error(`${STAGING_URL_ENV} must be an absolute HTTPS URL`);
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error(`${STAGING_URL_ENV} must be an absolute HTTPS URL without credentials or query data`);
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
    const child = spawn(process.execPath, [WORKER_PATH, ...argv, '--base-url', stagingUrl], {
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
    console.error('[smoke] staging validation failed');
    process.exitCode = 1;
  }
}
