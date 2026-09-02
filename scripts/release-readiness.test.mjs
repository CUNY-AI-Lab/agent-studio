import assert from 'node:assert/strict';
import test from 'node:test';

const workerUrl = new URL('./release-readiness-worker.mjs', import.meta.url);
const FAILURE = {
  ok: false,
  service: 'agent-studio',
  configuration: 'not_ready',
  version_id: null,
  tag: null,
};

const VALID_READINESS = {
  ok: true,
  service: 'agent-studio',
  configuration: 'ready',
  version_id: 'version-id',
  tag: 'commit-sha',
};

test('release helper exposes only a local GET boundary over the named remote entrypoint', async () => {
  const worker = (await import(workerUrl)).default;
  const calls = [];
  const env = {
    AGENT_STUDIO_READINESS: {
      getReadiness: async () => {
        calls.push(true);
        return VALID_READINESS;
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

test('release helper sanitizes malformed private readiness responses', async () => {
  const worker = (await import(workerUrl)).default;
  const response = await worker.fetch(new Request('http://127.0.0.1/readiness'), {
    AGENT_STUDIO_READINESS: { getReadiness: async () => ({ ...VALID_READINESS, secret: 'leak' }) },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), FAILURE);
});

test('release helper sanitizes private readiness RPC failures', async () => {
  const worker = (await import(workerUrl)).default;
  const response = await worker.fetch(new Request('http://127.0.0.1/readiness'), {
    AGENT_STUDIO_READINESS: {
      getReadiness: async () => {
        throw new Error('private RPC secret detail');
      },
    },
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), FAILURE);
  assert.doesNotMatch(body, /private RPC secret detail|Error|stack/i);
});
