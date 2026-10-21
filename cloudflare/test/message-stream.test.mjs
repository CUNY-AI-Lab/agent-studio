import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  importServer,
  makeEnv,
  openSession,
} from './helpers/env.mjs';
import {
  collectMessageStream,
  createMessageStream,
} from '../src/lib/message-stream.ts';

const app = await importServer();
const RPC_MESSAGE_LIMIT_BYTES = 32 * 1024 * 1024;
const LARGE_MESSAGE_TEXT_BYTES = 1024 * 1024;
const LARGE_MESSAGE_COUNT = 33;

async function createWorkspace(session, name) {
  const response = await session.request(app, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).workspace;
}

function streamBytesInSlices(bytes, sliceSizes) {
  let offset = 0;
  let sliceIndex = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const requested = sliceSizes[sliceIndex % sliceSizes.length];
      sliceIndex += 1;
      const end = Math.min(bytes.byteLength, offset + requested);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function installCurrentAgentLifecycleHandshake(env) {
  const getAgent = env.WorkspaceAgent.get.bind(env.WorkspaceAgent);
  env.WorkspaceAgent.get = (...args) => {
    const agent = getAgent(...args);
    agent.__unsafe_ensureInitialized ??= async () => undefined;
    return agent;
  };
}

function digestMessages(messages) {
  const hash = createHash('sha256');
  hash.update(`${messages.length}\n`);
  for (const message of messages) {
    assert.equal(message.parts.length, 1);
    assert.equal(message.parts[0].type, 'text');
    hash.update(message.id);
    hash.update('\0');
    hash.update(message.role);
    hash.update('\0');
    hash.update(String(message.parts[0].text.length));
    hash.update('\0');
    hash.update(message.parts[0].text);
    hash.update('\n');
  }
  return hash.digest('hex');
}

test('message stream collector survives record, UTF-8, and final-line chunk boundaries', async () => {
  const messages = [
    {
      id: 'first',
      role: 'user',
      parts: [{ type: 'text', text: 'mémoire 😀 漢字' }],
    },
    {
      id: 'second',
      role: 'assistant',
      metadata: { source: 'chunk-boundary' },
      parts: [{ type: 'text', text: 'final line has no trailing newline' }],
    },
  ];
  const encoder = new TextEncoder();
  const encoded = encoder.encode(messages.map((message) => JSON.stringify(message)).join('\n'));

  const collected = await collectMessageStream(streamBytesInSlices(
    encoded,
    [1, 2, 3, 5, 8, 13],
  ));

  assert.deepEqual(collected, messages);
});

test('message stream reader cancels its source when a consumer exits early', async () => {
  let cancelled = false;
  let reads = 0;
  const messages = Array.from({ length: 3 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user',
    parts: [{ type: 'text', text: String(index) }],
  }));
  const stream = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(messages[reads - 1])}\n`));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const message of (await import('../src/lib/message-stream.ts')).readMessageStream(stream)) {
    assert.equal(message.id, 'message-0');
    break;
  }

  assert.equal(cancelled, true);
  assert.ok(reads < messages.length, 'cancellation prevents remaining source reads');
});

test('workspace export route collects more than 32 MiB of streamed history', {
  timeout: 30_000,
}, async () => {
  const { env, agents } = makeEnv();
  installCurrentAgentLifecycleHandshake(env);
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'Large history');
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  assert.ok(agent);

  const messages = Array.from({ length: LARGE_MESSAGE_COUNT }, (_, index) => ({
    id: `message-${String(index).padStart(2, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{
      type: 'text',
      text: `${String.fromCharCode(65 + (index % 26))}`.repeat(LARGE_MESSAGE_TEXT_BYTES),
    }],
  }));
  const expectedDigest = digestMessages(messages);
  let streamedBytes = 0;
  let streamCalls = 0;
  agent.streamMessages = async () => {
    streamCalls += 1;
    return createMessageStream(messages).pipeThrough(new TransformStream({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength;
        assert.ok(
          chunk.byteLength <= 64 * 1024,
          'each DO stream chunk stays at or below the encoder budget',
        );
        controller.enqueue(chunk);
      },
    }));
  };
  agent.getMessages = async () => {
    throw new Error('export must not use the hydration-limited message cache');
  };

  const response = await session.request(app, `/api/workspaces/${workspace.id}/export`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(
    response.headers.get('content-disposition') || '',
    /attachment; filename="Large-history\.agent-studio\.json"/,
  );

  const bundle = await response.json();
  assert.equal(streamCalls, 1);
  assert.ok(
    streamedBytes > RPC_MESSAGE_LIMIT_BYTES,
    `expected more than 32 MiB of message history, got ${streamedBytes} bytes`,
  );
  assert.deepEqual(Object.keys(bundle).sort(), [
    'exportedAt',
    'files',
    'messages',
    'state',
    'version',
    'workspace',
  ]);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.workspace.id, workspace.id);
  assert.deepEqual(bundle.files, []);
  assert.equal(bundle.messages.length, messages.length);
  assert.deepEqual(bundle.messages.map((message) => message.id), messages.map((message) => message.id));
  assert.equal(digestMessages(bundle.messages), expectedDigest);
});
