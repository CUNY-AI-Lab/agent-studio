import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonEventStream, uiMessageChunkSchema } from 'ai';
import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const { AIChatAgent } = await import('@cloudflare/ai-chat');
const streamSseReply = Object.getOwnPropertyDescriptor(
  AIChatAgent.prototype,
  '_streamSSEReply',
).value;

const encoder = new TextEncoder();

const streamEvents = [
  { type: 'start', messageId: 'assistant-1' },
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'reasoning-1' },
  { type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking' },
  { type: 'reasoning-end', id: 'reasoning-1' },
  { type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'make_markdown' },
  { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"title":' },
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
  {
    type: 'source-url',
    sourceId: 'source-1',
    url: 'https://example.com/source',
    title: 'Source',
  },
  {
    type: 'source-document',
    sourceId: 'document-1',
    mediaType: 'text/plain',
    title: 'Document',
    filename: 'document.txt',
  },
  {
    type: 'file',
    url: 'data:text/plain;base64,SGk=',
    mediaType: 'text/plain',
  },
  {
    type: 'data-workspace',
    id: 'workspace-1',
    data: { saved: true },
  },
  { type: 'message-metadata', messageMetadata: { source: 'test' } },
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

function encodeSseWithEnding(events, lineEnding) {
  const lines = events
    .map(
      (event) =>
        'data: ' + JSON.stringify(event) + lineEnding + lineEnding,
    )
    .join('');
  return encoder.encode(lines + 'data: [DONE]' + lineEnding + lineEnding);
}

function makeChunkStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function oneByteChunks(bytes) {
  return Array.from(
    { length: bytes.byteLength },
    (_, index) => bytes.slice(index, index + 1),
  );
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

async function runPatchedStream(chunks) {
  const context = makeAgent();
  const message = { id: 'assistant-1', role: 'assistant', parts: [] };
  const streamCompleted = { value: false };
  const result = await streamSseReply.call(
    context.agent,
    'message-1',
    'stream-1',
    makeChunkStream(chunks).getReader(),
    message,
    streamCompleted,
  );
  return { context, message, result, streamCompleted };
}

async function readParsedResults(chunks) {
  const reader = parseJsonEventStream({
    stream: makeChunkStream(chunks),
    schema: uiMessageChunkSchema,
  }).getReader();
  const results = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return results;
    results.push(next.value);
  }
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
    message.parts.find((part) => part.type === 'reasoning'),
    { type: 'reasoning', text: 'thinking', state: 'done' },
  );
  assert.deepEqual(message.metadata, { source: 'test' });
  assert.deepEqual(
    message.parts.find((part) => part.type === 'source-url'),
    {
      type: 'source-url',
      sourceId: 'source-1',
      url: 'https://example.com/source',
      title: 'Source',
      providerMetadata: undefined,
    },
  );
  assert.deepEqual(
    message.parts.find((part) => part.type === 'file'),
    {
      type: 'file',
      mediaType: 'text/plain',
      url: 'data:text/plain;base64,SGk=',
    },
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

test('the framed chat transport preserves tool and terminal events at every split', async () => {
  const bytes = encodeSse(streamEvents);
  for (let split = 1; split < bytes.byteLength; split += 1) {
    const result = await runPatchedStream([
      bytes.slice(0, split),
      bytes.slice(split),
    ]);
    assertCompletedToolTurn(result);
  }
});

test('the maintained SSE parser keeps standard multiline, spacing, and DONE behavior', async () => {
  const standardBody = encoder.encode(
    'data: {"type":"text-delta",\n' +
      'data: "id":"text-1","delta":"line"}\n\n' +
      'data:  {"type":"finish","finishReason":"stop"}\n\n' +
      'data:[DONE]\n\n' +
      'data: {"type":"text-delta","id":"text-1","delta":"after"}\n\n',
  );
  const results = await readParsedResults([standardBody]);

  assert.deepEqual(
    results.map((result) => result.success && result.value.type),
    ['text-delta', 'finish', 'text-delta'],
  );
  assert.equal(results.every((result) => result.success), true);

  // EventSourceParserStream dispatches only a complete SSE event. An
  // unterminated tail is retained and discarded when the source closes.
  const unterminated = await readParsedResults([
    encoder.encode('data: {"type":"finish","finishReason":"stop"}\n'),
  ]);
  assert.deepEqual(unterminated, []);
});

test('the framed transport skips malformed events and preserves later completion', async () => {
  const body = encoder.encode(
    'data: {"type":"start","messageId":"assistant-1"}\n\n' +
      'data: {not-json}\n\n' +
      'data: {"type":"not-a-ui-message-chunk"}\n\n' +
      'data: {"type":"text-start","id":"text-1"}\n\n' +
      'data: {"type":"text-delta","id":"text-1","delta":"survived"}\n\n' +
      'data: {"type":"text-end","id":"text-1"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      'data: [DONE]\n\n',
  );
  const result = await runPatchedStream([body]);

  assert.deepEqual(result.result, { status: 'completed' });
  assert.deepEqual(result.message.parts, [
    { type: 'text', text: 'survived', state: 'done' },
  ]);
  assert.deepEqual(
    result.context.stored.map(({ body: storedBody }) =>
      JSON.parse(storedBody).type,
    ),
    ['start', 'text-start', 'text-delta', 'text-end', 'finish'],
  );
  assert.equal(result.context.broadcasts.at(-1)?.done, true);
});

test('the matrix survives byte-by-byte LF and CRLF transport chunks', async () => {
  for (const lineEnding of ['\n', '\r\n']) {
    const result = await runPatchedStream(
      oneByteChunks(encodeSseWithEnding(streamEvents, lineEnding)),
    );
    assertCompletedToolTurn(result);
  }
});

test('UTF-8 code points survive splits inside their encoded bytes', async () => {
  const events = [
    { type: 'text-start', id: 'text-utf8' },
    { type: 'text-delta', id: 'text-utf8', delta: 'café 🌊' },
    { type: 'text-end', id: 'text-utf8' },
    { type: 'finish', finishReason: 'stop' },
  ];
  const bytes = encodeSse(events);
  const utf8ContinuationBoundaries = [];
  for (let index = 1; index < bytes.byteLength; index += 1) {
    if ((bytes[index] & 0xc0) === 0x80) {
      utf8ContinuationBoundaries.push(index);
    }
  }

  for (const split of utf8ContinuationBoundaries) {
    const result = await runPatchedStream([
      bytes.slice(0, split),
      bytes.slice(split),
    ]);
    assert.deepEqual(result.result, { status: 'completed' });
    assert.deepEqual(result.message.parts, [
      { type: 'text', text: 'café 🌊', state: 'done' },
    ]);
  }
});

test('framed stream cancellation keeps the abort terminal semantics', async () => {
  let cancelled = false;
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"text-delta"'));
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

test('an explicit error event keeps the existing error terminal semantics', async () => {
  const result = await runPatchedStream([
    encodeSse([
      streamEvents[0],
      { type: 'error', errorText: 'provider unavailable' },
    ]),
  ]);

  assert.deepEqual(result.result, {
    status: 'error',
    error: 'provider unavailable',
  });
  assert.equal(result.streamCompleted.value, true);
  assert.deepEqual(result.context.errors, ['stream-1']);
  assert.deepEqual(result.context.completed, []);
  assert.deepEqual(
    result.context.stored.map(({ body }) => JSON.parse(body).type),
    ['start'],
  );
  assert.equal(result.context.broadcasts.at(-1)?.done, true);
});

test('a source read error rejects without completing the stream', async () => {
  const sourceError = new Error('synthetic source failure');
  const reader = {
    async read() {
      throw sourceError;
    },
    async cancel() {},
  };
  const context = makeAgent();

  await assert.rejects(
    streamSseReply.call(
      context.agent,
      'message-1',
      'stream-1',
      reader,
      { id: 'assistant-1', role: 'assistant', parts: [] },
      { value: false },
    ),
    (error) => error === sourceError,
  );
  assert.deepEqual(context.completed, []);
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

test('continuous partial traffic resets the stall watchdog between reads', async () => {
  const bytes = encodeSse(streamEvents);
  const chunks = [];
  const chunkSize = Math.ceil(bytes.byteLength / 8);
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  let index = 0;
  const reader = {
    async read() {
      if (index === chunks.length) return { done: true, value: undefined };
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { done: false, value: chunks[index++] };
    },
    async cancel() {},
  };
  const context = makeAgent();
  context.agent.chatStreamStallTimeoutMs = 25;
  const message = { id: 'assistant-1', role: 'assistant', parts: [] };
  const streamCompleted = { value: false };

  const result = await streamSseReply.call(
    context.agent,
    'message-1',
    'stream-1',
    reader,
    message,
    streamCompleted,
  );

  assertCompletedToolTurn({ context, message, result, streamCompleted });
});

test('a large event in tiny chunks is parsed without an application cap', async () => {
  const largeData = 'x'.repeat(64 * 1024);
  const bytes = encodeSse([
    { type: 'data-large', id: 'large-1', data: largeData },
    { type: 'finish', finishReason: 'stop' },
  ]);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 17) {
    chunks.push(bytes.slice(offset, offset + 17));
  }

  const result = await runPatchedStream(chunks);

  assert.deepEqual(result.result, { status: 'completed' });
  assert.deepEqual(
    result.context.stored.map(({ body }) => JSON.parse(body).type),
    ['data-large', 'finish'],
  );
  assert.equal(
    JSON.parse(result.context.stored[0].body).data.length,
    largeData.length,
  );
});
