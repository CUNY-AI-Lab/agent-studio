import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerUrl = new URL('./release-readiness-worker.mjs', import.meta.url);
const configUrl = new URL('./release-readiness-wrangler.jsonc', import.meta.url);

function parseJsonc(source) {
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

test('release helper exposes only a local GET boundary over the named remote entrypoint', async () => {
  const worker = (await import(workerUrl)).default;
  const calls = [];
  const env = {
    AGENT_STUDIO_READINESS: {
      getReadiness: async () => {
        calls.push(true);
        return {
          ok: true,
          service: 'agent-studio',
          configuration: 'ready',
          version_id: 'version-id',
          tag: 'commit-sha',
        };
      },
    },
  };

  const response = await worker.fetch(new Request('http://127.0.0.1/readiness'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'agent-studio',
    configuration: 'ready',
    version_id: 'version-id',
    tag: 'commit-sha',
  });
  assert.deepEqual(calls, [true]);

  const rejected = await worker.fetch(new Request('http://127.0.0.1/readiness', { method: 'POST' }), env);
  assert.equal(rejected.status, 404);
});

test('release helper follows current per-binding remote service guidance', async () => {
  const config = parseJsonc(await readFile(configUrl, 'utf8'));
  assert.deepEqual(config.services, [{
    binding: 'AGENT_STUDIO_READINESS',
    service: 'agent-studio',
    entrypoint: 'AgentStudioReadiness',
    remote: true,
  }]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});
