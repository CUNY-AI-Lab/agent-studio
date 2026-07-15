import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

test('chat action success waits for the post-persistence onChatResponse hook', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const action = { actionTerminal: false };
  const calls = [];
  const agent = {
    ctx: { storage: { sql: { exec: () => ({ toArray: () => [] }) } } },
    pendingChatAction: action,
    finishModelCall(seenAction, terminal, errorType) {
      calls.push(['model', seenAction, terminal, errorType]);
    },
    finishChatAction(seenAction, terminal, errorType) {
      calls.push(['action', seenAction, terminal, errorType]);
    },
  };

  WorkspaceAgent.prototype.onChatResponse.call(agent, {
    message: { id: 'assistant-1', role: 'assistant', parts: [] },
    requestId: 'request-1',
    continuation: false,
    status: 'completed',
  });

  assert.deepEqual(calls, [
    ['model', action, { outcome: 'ok', reason: 'completed' }, undefined],
    ['action', action, { outcome: 'ok', reason: 'completed' }, undefined],
  ]);
});

test('deferred chat failures become terminal only in the post-persistence hook', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const action = {
    actionTerminal: false,
    deferredTerminal: {
      terminal: { outcome: 'denied', reason: 'quota_blocked' },
      errorType: 'quota_exceeded',
    },
  };
  const calls = [];
  const agent = {
    ctx: { storage: { sql: { exec: () => ({ toArray: () => [] }) } } },
    pendingChatAction: action,
    finishModelCall(seenAction, terminal, errorType) {
      calls.push(['model', seenAction, terminal, errorType]);
    },
    finishChatAction(seenAction, terminal, errorType) {
      calls.push(['action', seenAction, terminal, errorType]);
    },
  };

  WorkspaceAgent.prototype.onChatResponse.call(agent, {
    message: { id: 'assistant-1', role: 'assistant', parts: [] },
    requestId: 'request-1',
    continuation: false,
    status: 'failed',
  });

  assert.deepEqual(calls, [
    ['model', action, { outcome: 'denied', reason: 'quota_blocked' }, 'quota_exceeded'],
    ['action', action, { outcome: 'denied', reason: 'quota_blocked' }, 'quota_exceeded'],
  ]);
});

test('chat persistence is framework-owned rather than overridden as an instrumentation seam', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  assert.equal(Object.hasOwn(WorkspaceAgent.prototype, 'persistMessages'), false);
});

test('migration freeze refuses to race an active mutation', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const writes = [];
  const agent = {
    activeMutations: 1,
    migrationFrozen: false,
    ctx: { storage: { put: async (...args) => writes.push(args) } },
  };
  await assert.rejects(
    WorkspaceAgent.prototype.freezeForMigration.call(agent),
    /active mutation/,
  );
  assert.equal(agent.migrationFrozen, false);
  assert.deepEqual(writes, []);
});

test('destructive cleanup refuses to race an active mutation', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = { activeMutations: 1, migrationFrozen: false };
  await assert.rejects(
    WorkspaceAgent.prototype.destroyWorkspaceState.call(agent),
    /active mutation/,
  );
  assert.equal(agent.migrationFrozen, false);
});

test('identity enforcement rejects mutation RPCs on an anonymous pre-cutover socket', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    env: { CAIL_REQUIRE_IDENTITY: 'true' },
    cailSubject: null,
    migrationFrozen: false,
    assertNotFrozen: WorkspaceAgent.prototype.assertNotFrozen,
    assertAuthorizedRpc: WorkspaceAgent.prototype.assertAuthorizedRpc,
  };

  await assert.rejects(
    WorkspaceAgent.prototype.applyLayoutPatch.call(agent, {}),
    /authentication_required/,
  );
});

test('code rate-limit denial does not emit an orphan canonical action terminal', async (t) => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const records = [];
  t.mock.method(console, 'warn', (record) => records.push(record));
  const agent = {
    env: {
      CAIL_LOG_ENV: 'test',
      CAIL_FLEET_EVENTS: { writeDataPoint() {} },
      CF_VERSION_METADATA: {
        id: '11111111-1111-4111-8111-111111111111', tag: '', timestamp: '2026-07-13T14:00:00Z',
      },
      HEAVY_RATE_LIMIT: { limit: async () => ({ success: false }) },
    },
    cailSubject: 'cail-0123456789abcdef0123456789abcdef',
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    withMutationFence(operation) { return operation(); },
    csrfSessionId() { return 'session-1'; },
    requireSessionId() { return 'session-1'; },
  };

  await assert.rejects(
    WorkspaceAgent.prototype.executeCode.call(agent, 'return 1'),
    /rate_limited/,
  );
  assert.deepEqual(records.map((record) => record['event.name']), ['agent_studio.code.denied']);
  assert.equal(records[0]['url.template'], '/api/workspaces/{id}/runtime/execute');
  assert.equal(records[0]['cail.outcome.reason'], 'rate_limited');
});

test('successful code execution emits one paired canonical action lifecycle', async (t) => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const records = [];
  const sqlWrites = [];
  t.mock.method(console, 'log', (record) => records.push(record));
  const agent = {
    ctx: {
      storage: {
        sql: {
          exec: (query, ...bindings) => {
            sqlWrites.push({ query, bindings });
            return { toArray: () => [] };
          },
        },
      },
    },
    env: {
      CAIL_LOG_ENV: 'test',
      CAIL_FLEET_EVENTS: { writeDataPoint() {} },
      CF_VERSION_METADATA: {
        id: '11111111-1111-4111-8111-111111111111', tag: '', timestamp: '2026-07-13T14:00:00Z',
      },
    },
    cailSubject: 'cail-0123456789abcdef0123456789abcdef',
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    withMutationFence(operation) { return operation(); },
    csrfSessionId() { return 'session-1'; },
    requireSessionId() { return 'session-1'; },
    requireWorkspace() { return { id: 'workspace-1' }; },
    buildHostTools() { return {}; },
    buildCodeProviders() { return {}; },
    createCodeExecutor() {
      return { execute: async () => ({ ok: true, stdout: '', stderr: '', logs: [] }) };
    },
  };

  const result = await WorkspaceAgent.prototype.executeCode.call(agent, 'return 1');
  assert.equal(result.ok, true);
  assert.deepEqual(records.map((record) => record['event.name']), [
    'cail.action.admitted',
    'cail.action.terminal',
  ]);
  assert.equal(records[0]['cail.action.id'], records[1]['cail.action.id']);
  assert.equal(records[0]['url.template'], '/api/workspaces/{id}/runtime/execute');
  assert.equal(records[1]['cail.outcome'], 'ok');
  assert.equal(sqlWrites.length, 2);
  assert.match(sqlWrites[0].query, /studio_action_lifecycle_events_v1/);
  assert.equal(sqlWrites[0].bindings[1], '/api/workspaces/{id}/runtime/execute');
  assert.equal(sqlWrites[1].bindings[3], 'ok');
});

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
  assert.equal(payload.error.code, 'authentication_required');
  assert.equal(payload.error.cail.login_url, '/login');
});

test('WebSocket chat admission uses the heavy rate-limit binding', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() { return { id: 'workspace-1' }; },
    requireSessionId() { return 'session-1'; },
    cailIdentityJwt: 'verified-jwt',
    env: { HEAVY_RATE_LIMIT: { limit: async () => ({ success: false }) } },
  };
  const response = await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, {
    requestId: 'request-1',
  });
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);
  assert.equal(payload.error.code, 'rate_limited');
  assert.equal(payload.error.cail.retryable, true);
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
      JSON.stringify({
        error: {
          message: quotaMessage,
          type: 'rate_limit_error',
          param: null,
          code: 'quota_exceeded',
          cail: { retry_after_seconds: 1800 },
        },
      }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '1800',
          'x-request-id': 'req-agent-quota-1',
          'x-should-retry': 'false',
        },
      },
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
    ctx: { storage: { sql: { exec: () => ({ toArray: () => [] }) } } },
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
    admitModelCall(action) {
      return WorkspaceAgent.prototype.admitModelCall.call(this, action);
    },
    finishModelCall(action, terminal, errorType) {
      return WorkspaceAgent.prototype.finishModelCall.call(this, action, terminal, errorType);
    },
    finishChatAction(action, terminal, errorType) {
      return WorkspaceAgent.prototype.finishChatAction.call(this, action, terminal, errorType);
    },
    deferChatTerminal(action, terminal, errorType) {
      return WorkspaceAgent.prototype.deferChatTerminal.call(this, action, terminal, errorType);
    },
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
  assert.equal(payload.error.code, 'quota_exceeded');
  assert.equal(payload.error.message, quotaMessage);
  assert.equal(payload.error.cail.retry_after_seconds, 1800);
  // The thrown CailError must not be SDK-retried: one wire call, no retry storm.
  assert.equal(wireCalls, 1);
});
