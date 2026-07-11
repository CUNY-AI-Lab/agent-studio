import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

test('anonymous chat streams an authentication error instead of assistant JSON', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() {
      return { id: 'workspace-1' };
    },
    requireSessionId() {
      return 'session-1';
    },
    cailIdentityJwt: null,
    finalizeObservabilityRequest() {},
  };

  const response = await WorkspaceAgent.prototype.onChatMessage.call(
    agent,
    undefined,
    { requestId: 'request-1' },
  );
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);

  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(event.type, 'error');
  assert.equal(payload.error, 'authentication_required');
  assert.equal(payload.login_url, '/login');
});

// Behavioral pin for the fleet's quota-surfacing bug (S5/A7): a gateway 429
// quota_exceeded envelope must reach the chat user as the VERBATIM envelope
// message, not a generic failure — and on the FIRST wire call (the shared
// client's chatFetch throws the parsed CailError, which no AI SDK retries).
test('gateway 429 quota_exceeded streams the verbatim quota message to the user', async (t) => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');

  const quotaMessage =
    'You have reached your CAIL usage quota for this period. Try again in about 1800 seconds.';
  let wireCalls = 0;
  const originalFetch = globalThis.fetch;
  // createCailModel builds the shared client per request, which captures
  // globalThis.fetch — so this stub IS the gateway for the model call.
  globalThis.fetch = async () => {
    wireCalls += 1;
    return new Response(
      JSON.stringify({ error: 'quota_exceeded', message: quotaMessage, retry_after_seconds: 1800 }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1800' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const noopTool = tool({
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() {
      return { id: 'workspace-1' };
    },
    requireSessionId() {
      return 'session-1';
    },
    cailIdentityJwt: 'header.payload.signature',
    env: { CAIL_API_BASE: 'https://cail.test' },
    state: { panels: [] },
    messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    buildHostTools() {
      return {};
    },
    createCodeModeTool() {
      return noopTool;
    },
    buildModelTools() {
      return {};
    },
    ensureObservabilityRequest() {
      return { steps: 0 };
    },
    pushObservabilityEvent() {},
    finalizeObservabilityRequest() {},
    recordChunkObservability() {},
    markObservabilityUpdated() {},
  };

  const response = await WorkspaceAgent.prototype.onChatMessage.call(
    agent,
    undefined,
    { requestId: 'request-1' },
  );
  const body = await response.text();
  const errorEvent = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice('data: '.length));
      } catch {
        return null;
      }
    })
    .find((event) => event?.type === 'error');

  assert.ok(errorEvent, `expected an error event in the stream, got:\n${body}`);
  const payload = JSON.parse(errorEvent.errorText);
  assert.equal(payload.type, 'quota_exceeded');
  assert.equal(payload.message, quotaMessage);
  assert.equal(payload.retryAfter, '1800');
  // The thrown CailError must not be SDK-retried: one wire call, no retry storm.
  assert.equal(wireCalls, 1);
});
