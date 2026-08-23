import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CAIL_GATEWAY_ORIGIN } from '@cuny-ai-lab/cail-client';

const configUrl = new URL('../wrangler.jsonc', import.meta.url);

function parseJsonc(source) {
  // This config currently contains no inline comments. Strip only full-line
  // comments so URLs such as https://... remain untouched if comments are
  // added later.
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

test('all maintained Agent Studio Worker environments pin the cancellation flags', async () => {
  const config = parseJsonc(await readFile(configUrl, 'utf8'));
  const requiredFlags = [
    'nodejs_compat',
    'enable_request_signal',
    'request_signal_passthrough',
  ];

  assert.deepEqual(config.compatibility_flags, requiredFlags);
  assert.deepEqual(config.env?.staging?.compatibility_flags, requiredFlags);

  for (const flags of [config.compatibility_flags, config.env?.staging?.compatibility_flags]) {
    assert.ok(!flags.includes('enable_abortsignal_rpc'), 'AbortSignal RPC is an experimental JS-RPC feature, not this HTTP Fetch path');
    assert.ok(!flags.includes('experimental'), 'the Worker must not opt into the broad experimental flag');
  }
});

test('Gateway base configuration uses the canonical origin before the transport appends /v1', async () => {
  const config = parseJsonc(await readFile(configUrl, 'utf8'));
  const expectedOrigin = CAIL_GATEWAY_ORIGIN;

  assert.equal(config.vars?.CAIL_API_BASE, expectedOrigin);
  assert.equal(config.env?.staging?.vars?.CAIL_API_BASE, expectedOrigin);
  assert.ok(!config.vars?.CAIL_API_BASE.endsWith('/v1'));
  assert.ok(!config.env?.staging?.vars?.CAIL_API_BASE.endsWith('/v1'));
});

test('production has no public Worker or preview URL while staging keeps its isolated smoke URL', async () => {
  const config = parseJsonc(await readFile(configUrl, 'utf8'));

  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.env?.staging?.workers_dev, true);
  assert.equal(config.env?.staging?.preview_urls, false);
  assert.equal(config.route, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.env?.staging?.route, undefined);
  assert.equal(config.env?.staging?.routes, undefined);
  assert.equal(config.exports?.AgentStudioReadiness?.type, 'worker');
  assert.equal(config.env?.staging?.exports?.AgentStudioReadiness?.type, 'worker');
});

test('release readiness uses a named private entrypoint instead of an HTTP route', async () => {
  const config = parseJsonc(await readFile(configUrl, 'utf8'));
  const services = config.services ?? [];

  assert.deepEqual(
    services,
    [{ binding: 'GATEWAY', service: 'cail-model-api' }],
  );
  assert.deepEqual(config.env?.staging?.services, [
    { binding: 'GATEWAY', service: 'cail-model-api-staging' },
  ]);
});
