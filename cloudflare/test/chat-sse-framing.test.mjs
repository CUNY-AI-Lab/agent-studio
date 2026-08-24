import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const { AIChatAgent } = await import('@cloudflare/ai-chat');
const streamSseReply = Object.getOwnPropertyDescriptor(
  AIChatAgent.prototype,
  '_streamSSEReply',
).value;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const streamEvents = [
  { type: 'start', messageId: 'assistant-1' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'make_markdown' },
  {
    type: 'tool-input-available',
    toolCallId: 'tool-1',
    toolName: 'make_markdown',
    input: { title: 'Boundary proof' },
  },
  {
    type: 'tool-output-available',
    toolCallId: 'tool-1',
    output: { saved: true },
  },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'done' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

function encodeSse(events) {
  return encoder.encode(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
  );
}

function readLegacyEvents(chunks) {
  const events = [];
  for (const chunk of chunks) {
    for (const line of decoder.decode(chunk).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // Match the old transport's per-line error handling.
      }
    }
  }
  return events;
}

function makeAgent() {
  const broadcasts = [];
  const stored = [];
  const completed = [];
  const errors = [];
  return {
    agent: {
      chatStreamStallTimeoutMs: 0,
      _completeStream(streamId) {
        completed.push(streamId);
      },
      _broadcastChatMessage(event) {
        broadcasts.push(event);
      },
      async _storeStreamChunk(streamId, body) {
        stored.push({ body, streamId });
      },
      _markStreamError(streamId) {
        errors.push(streamId);
      },
      _emit() {},
      _streamingMessage: null,
    },
    broadcasts,
    stored,
    completed,
    errors,
  };
}

async function runPatchedStream(bytes, split) {
  const first = bytes.slice(0, split);
  const second = bytes.slice(split);
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
  const context = makeAgent();
  const message = { id: 'assistant-1', role: 'assistant', parts: [] };
  const streamCompleted = { value: false };
  const result = await streamSseReply.call(
    context.agent,
    'message-1',
    'stream-1',
    input.getReader(),
    message,
    streamCompleted,
  );
  return { context, message, result, streamCompleted };
}

function assertCompletedToolTurn({ context, message, result, streamCompleted }) {
  assert.deepEqual(result, { status: 'completed' });
  assert.equal(streamCompleted.value, true);
  assert.deepEqual(context.completed, ['stream-1']);
  assert.deepEqual(context.errors, []);

  const toolPart = message.parts.find((part) => part.toolCallId === 'tool-1');
  assert.deepEqual(toolPart, {
    type: 'tool-make_markdown',
    toolCallId: 'tool-1',
    toolName: 'make_markdown',
    state: 'output-available',
    input: { title: 'Boundary proof' },
    output: { saved: true },
  });
  assert.deepEqual(
    message.parts.find((part) => part.type === 'text'),
    { type: 'text', text: 'done', state: 'done' },
  );

  assert.deepEqual(
    context.stored.map(({ body }) => JSON.parse(body).type),
    streamEvents.map(({ type }) => type),
  );
  assert.equal(context.broadcasts.at(-1)?.done, true);
  assert.equal(
    context.broadcasts.filter((event) => event.done === true).length,
    1,
  );
}

test('the old per-read parser loses SSE events at byte boundaries', () => {
  const bytes = encodeSse([streamEvents[4]]);
  let lostBoundaries = 0;
  for (let split = 1; split < bytes.byteLength; split += 1) {
    const events = readLegacyEvents([bytes.slice(0, split), bytes.slice(split)]);
    if (events.length === 0) lostBoundaries += 1;
  }
  assert.ok(lostBoundaries > 0);
});

test('the framed chat transport preserves tool and terminal events at every split', async () => {
  const bytes = encodeSse(streamEvents);
  for (let split = 1; split < bytes.byteLength; split += 1) {
    const result = await runPatchedStream(bytes, split);
    assertCompletedToolTurn(result);
  }
});

test('framed stream cancellation keeps the abort terminal semantics', async () => {
  let cancelled = false;
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(encodeSse([streamEvents[0]]));
    },
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const context = makeAgent();
  const streamCompleted = { value: false };
  const controller = new AbortController();
  const resultPromise = streamSseReply.call(
    context.agent,
    'message-1',
    'stream-1',
    input.getReader(),
    { id: 'assistant-1', role: 'assistant', parts: [] },
    streamCompleted,
    false,
    controller.signal,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await resultPromise;

  assert.deepEqual(result, { status: 'aborted' });
  assert.equal(streamCompleted.value, true);
  assert.equal(cancelled, true);
  assert.deepEqual(context.completed, ['stream-1']);
  assert.equal(context.broadcasts.at(-1)?.done, true);
});

test('framed stream cancellation keeps the existing stall watchdog boundary', async () => {
  let cancelled = false;
  const input = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const context = makeAgent();
  context.agent.chatStreamStallTimeoutMs = 25;

  await assert.rejects(
    streamSseReply.call(
      context.agent,
      'message-1',
      'stream-1',
      input.getReader(),
      { id: 'assistant-1', role: 'assistant', parts: [] },
      { value: false },
    ),
    (error) => error?.name === 'ChatStreamStalledError',
  );
  assert.equal(cancelled, true);
  assert.deepEqual(context.completed, []);
});
