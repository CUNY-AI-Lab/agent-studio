import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Wrangler source defaults suppress content-bearing invocation logs and bind version metadata', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(source, /"invocation_logs"\s*:\s*false/);
  assert.match(source, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"/s);
});
