import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
