import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_SECRETS = Object.freeze(['SESSION_SECRET', 'CAIL_IDENTITY_JWKS']);
export const WRANGLER_VERSION = '4.115.0';
export const REVIEWED_MESSAGE = 'Agent Studio staging: cail-model-api-staging';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function valueAfterFlag(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function recordFlag(flags, name, value) {
  if (flags[name] !== undefined) fail(`${name} may be supplied only once`);
  flags[name] = value;
}

/** Parse only release metadata and safe Wrangler pass-through flags. */
export function parseDeployArgs(rawArgs, cwd = process.cwd()) {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const flags = {};
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tag' || argument.startsWith('--tag=')) {
      const value = argument.includes('=')
        ? argument.slice('--tag='.length)
        : valueAfterFlag(args, index++, '--tag');
      recordFlag(flags, 'tag', value);
      continue;
    }
    if (argument === '--message' || argument.startsWith('--message=')) {
      const value = argument.includes('=')
        ? argument.slice('--message='.length)
        : valueAfterFlag(args, index++, '--message');
      recordFlag(flags, 'message', value);
      continue;
    }
    if (argument === '--secrets-file' || argument.startsWith('--secrets-file=')) {
      const value = argument.includes('=')
        ? argument.slice('--secrets-file='.length)
        : valueAfterFlag(args, index++, '--secrets-file');
      recordFlag(flags, 'secretsFile', path.resolve(cwd, value));
      continue;
    }
    if (argument === '--dry-run') {
      passthrough.push(argument);
      continue;
    }
    if (argument === '--outdir' || argument.startsWith('--outdir=')) {
      if (argument === '--outdir') {
        passthrough.push(argument, valueAfterFlag(args, index++, '--outdir'));
      } else {
        passthrough.push(argument);
      }
      continue;
    }
    fail(`${argument.split('=', 1)[0]} is not allowed by the reviewed staging script`);
  }

  if (typeof flags.tag !== 'string' || !SHA_PATTERN.test(flags.tag)) {
    fail('--tag must be the reviewed lowercase 40-hex Git SHA');
  }
  if (typeof flags.message !== 'string' || flags.message.trim() === '') {
    fail('--message must be a non-empty reviewed release message');
  }
  if (flags.message !== REVIEWED_MESSAGE) {
    fail(`--message must exactly equal "${REVIEWED_MESSAGE}"`);
  }
  if (typeof flags.secretsFile !== 'string') {
    fail('--secrets-file must name the private staging secrets file');
  }

  return {
    tag: flags.tag,
    message: flags.message,
    secretsFile: flags.secretsFile,
    passthrough,
  };
}

function requiredNamesFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return new Map(Object.entries(parsed));
}

function requiredNamesFromDotEnv(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match) entries.set(match[1], match[2]);
  }
  return entries;
}

/** Validate required key presence without logging or returning secret values. */
export async function validateSecretsFile(filePath) {
  let file;
  try {
    file = await stat(filePath);
  } catch {
    fail('the private staging secrets file could not be read');
  }
  if (!file.isFile()) fail('the private staging secrets path is not a file');

  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    fail('the private staging secrets file could not be read');
  }
  const entries = text.trimStart().startsWith('{')
    ? requiredNamesFromJson(text)
    : requiredNamesFromDotEnv(text);
  if (entries === null) fail('the private staging secrets file must be JSON or dotenv format');

  for (const name of REQUIRED_SECRETS) {
    const value = entries.get(name);
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`the private staging secrets file is missing ${name}`);
    }
  }
}

export function currentGitSha(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!SHA_PATTERN.test(sha)) fail('the current Git HEAD is not a full lowercase 40-hex SHA');
    return sha;
  } catch {
    fail('the reviewed Git HEAD could not be verified');
  }
}

export function assertReviewedRelease({ tag, message }, reviewedSha) {
  if (tag !== reviewedSha) fail('--tag must equal the current reviewed Git HEAD');
  if (message !== REVIEWED_MESSAGE) {
    fail(`--message must exactly equal "${REVIEWED_MESSAGE}"`);
  }
}

export function wranglerArguments({ tag, message, secretsFile, passthrough = [] }) {
  return [
    'deploy',
    '--env',
    'staging',
    '--strict',
    '--tag',
    tag,
    '--message',
    message,
    '--secrets-file',
    secretsFile,
    ...passthrough,
  ];
}

export function wranglerPaths(cloudflareDir) {
  return {
    package: path.resolve(cloudflareDir, '../node_modules/wrangler/package.json'),
    binary: path.resolve(cloudflareDir, '../node_modules/.bin/wrangler'),
  };
}

export async function main(rawArgs = process.argv.slice(2)) {
  const cloudflareDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const config = parseDeployArgs(rawArgs);
  assertReviewedRelease(config, currentGitSha(cloudflareDir));
  await validateSecretsFile(config.secretsFile);

  const paths = wranglerPaths(cloudflareDir);
  let installedVersion;
  try {
    installedVersion = JSON.parse(await readFile(paths.package, 'utf8')).version;
  } catch {
    fail(`the pinned Wrangler ${WRANGLER_VERSION} package is not installed`);
  }
  if (installedVersion !== WRANGLER_VERSION) {
    fail(`the staging deploy requires Wrangler ${WRANGLER_VERSION}`);
  }

  const child = spawn(paths.binary, wranglerArguments(config), {
    cwd: cloudflareDir,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Wrangler terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[agent-studio deploy] ${error instanceof Error ? error.message : 'deployment blocked'}`);
    process.exitCode = 1;
  });
}
