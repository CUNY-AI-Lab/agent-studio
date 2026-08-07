import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeployArgs,
  assertReviewedRelease,
  currentGitSha,
  REVIEWED_MESSAGE,
  validateSecretsFile,
  wranglerPaths,
  wranglerArguments,
} from '../cloudflare/scripts/deploy-staging.mjs';

const TAG = 'a'.repeat(40);

test('staging deploy arguments require reviewed metadata and reject mutable targets', () => {
  const parsed = parseDeployArgs([
    '--tag', TAG,
    '--message', REVIEWED_MESSAGE,
    '--secrets-file', '/private/staging-secrets.env',
    '--dry-run',
  ]);
  assert.deepEqual(parsed, {
    tag: TAG,
    message: REVIEWED_MESSAGE,
    secretsFile: '/private/staging-secrets.env',
    passthrough: ['--dry-run'],
  });
  assert.throws(
    () => parseDeployArgs(['--message', 'reviewed', '--secrets-file', '/tmp/secrets']),
    /--tag must be the reviewed lowercase 40-hex Git SHA/,
  );
  assert.throws(
    () => parseDeployArgs([
      '--tag', TAG,
      '--message', REVIEWED_MESSAGE,
      '--secrets-file', '/tmp/secrets',
      '--keep-vars',
    ]),
    /--keep-vars is not allowed/,
  );
  assert.throws(
    () => parseDeployArgs([
      '--tag', TAG,
      '--message', REVIEWED_MESSAGE,
      '--secrets-file', '/tmp/secrets',
      '--env', 'production',
    ]),
    /--env is not allowed/,
  );
  for (const override of [
    ['--var', 'CAIL_REQUIRE_IDENTITY:false'],
    ['--routes', 'example.invalid/*'],
    ['--strict=false'],
    ['--config', 'other.jsonc'],
  ]) {
    assert.throws(
      () => parseDeployArgs([
        '--tag', TAG,
        '--message', REVIEWED_MESSAGE,
        '--secrets-file', '/tmp/secrets',
        ...override,
      ]),
      /is not allowed/,
      override[0],
    );
  }
});

test('staging deploy requires the current HEAD and exact approved message', () => {
  assert.doesNotThrow(() => assertReviewedRelease({ tag: TAG, message: REVIEWED_MESSAGE }, TAG));
  assert.throws(
    () => assertReviewedRelease({ tag: TAG, message: REVIEWED_MESSAGE }, 'b'.repeat(40)),
    /tag must equal the current reviewed Git HEAD/,
  );
  assert.throws(
    () => assertReviewedRelease({ tag: TAG, message: 'reviewed staging release' }, TAG),
    /message must exactly equal/,
  );
  assert.match(currentGitSha(process.cwd()), /^[0-9a-f]{40}$/);
});

test('staging Wrangler arguments pin the environment and strict mode without keep-vars', () => {
  const args = wranglerArguments({
    tag: TAG,
    message: REVIEWED_MESSAGE,
    secretsFile: '/private/staging-secrets.env',
  });
  assert.deepEqual(args.slice(0, 5), ['deploy', '--env', 'staging', '--strict', '--tag']);
  assert.ok(args.includes('--secrets-file'));
  assert.equal(args.includes('--keep-vars'), false);
});

test('staging wrapper resolves the workspace-pinned Wrangler from the repository root', () => {
  assert.deepEqual(wranglerPaths('/repo/cloudflare'), {
    package: '/repo/node_modules/wrangler/package.json',
    binary: '/repo/node_modules/.bin/wrangler',
  });
});

test('required staging secrets are checked by name without exposing values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-studio-staging-secrets-'));
  try {
    const jsonPath = path.join(directory, 'secrets.json');
    await writeFile(jsonPath, JSON.stringify({ SESSION_SECRET: 'x', CAIL_IDENTITY_JWKS: 'y' }));
    await validateSecretsFile(jsonPath);

    const dotenvPath = path.join(directory, 'secrets.env');
    await writeFile(dotenvPath, 'SESSION_SECRET=x\nCAIL_IDENTITY_JWKS=y\n');
    await validateSecretsFile(dotenvPath);

    await writeFile(dotenvPath, 'SESSION_SECRET=x\n');
    await assert.rejects(validateSecretsFile(dotenvPath), /missing CAIL_IDENTITY_JWKS/);

    await writeFile(jsonPath, JSON.stringify({ SESSION_SECRET: 1, CAIL_IDENTITY_JWKS: 'y' }));
    await assert.rejects(validateSecretsFile(jsonPath), /missing SESSION_SECRET/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
