import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import {
  cailErrorResponse,
  quotaExceededEnvelope,
} from '@cuny-ai-lab/cail-client/testing';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

function makeAgentStorage(seed = []) {
  const values = new Map(seed);
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
      writes.push(['put', key, value]);
    },
    async delete(key) {
      values.delete(key);
      writes.push(['delete', key]);
    },
    setAlarm() {},
    deleteAlarm() {},
    sql: {
      exec() {
        return {
          toArray: () => [],
          [Symbol.iterator]: function* iterator() {},
        };
      },
    },
  };
}

async function makeRealWorkspaceAgent(WorkspaceAgent, storage = makeAgentStorage()) {
  const agent = new WorkspaceAgent(
    {
      storage,
      id: { toString: () => 'workspace-agent-chat-test' },
      blockConcurrencyWhile: async (operation) => operation(),
      getWebSockets: () => [],
      acceptWebSocket: () => {},
      waitUntil: () => {},
    },
    {},
  );
  await agent.setName(`${'a'.repeat(32)}-workspace-1`);
  return agent;
}

function chatRequest(id = 'turn-1', messageId = 'user-1') {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request',
    id,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{
          id: messageId,
          role: 'user',
          parts: [{ type: 'text', text: 'hello' }],
        }],
      }),
    },
  });
}

function testConnection(id = 'connection-1') {
  return {
    id,
    state: null,
    tags: [],
    binaryType: 'arraybuffer',
    setState(next) {
      this.state = next;
    },
    send() {},
    close() {},
  };
}

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

test('chat persistence counts an admitted write and rejects only after migration freeze', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const base = Object.getPrototypeOf(WorkspaceAgent.prototype);
  const original = base.persistMessages;
  let calls = 0;
  base.persistMessages = async () => {
    calls += 1;
  };
  try {
    const agent = {
      activeMutations: 0,
      migrationFrozen: false,
      assertNotFrozen: WorkspaceAgent.prototype.assertNotFrozen,
    };
    await WorkspaceAgent.prototype.persistMessages.call(agent, []);
    assert.equal(calls, 1);
    assert.equal(agent.activeMutations, 0);

    agent.migrationFrozen = true;
    await assert.rejects(
      WorkspaceAgent.prototype.persistMessages.call(agent, []),
      /workspace is frozen for migration/,
    );
    assert.equal(calls, 1);
  } finally {
    base.persistMessages = original;
  }
});

test('migration freeze waits for framework chat stability and clears admission on failure', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  let resolveStable;
  let resolveEntered;
  const stable = new Promise((resolve) => { resolveStable = resolve; });
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  const writes = [];
  const deletes = [];
  const agent = {
    activeMutations: 0,
    migrationFrozen: false,
    assertNotFrozen: WorkspaceAgent.prototype.assertNotFrozen,
    waitUntilStable: async ({ timeout }) => {
      assert.equal(timeout, 5_000);
      resolveEntered();
      return stable;
    },
    ctx: {
      blockConcurrencyWhile: async (operation) => operation(),
      storage: {
        put: async (...args) => writes.push(args),
        delete: async (...args) => deletes.push(args),
      },
    },
  };

  const freeze = WorkspaceAgent.prototype.freezeForMigration.call(agent);
  await entered;
  assert.equal(agent.migrationFrozen, false);
  resolveStable(true);
  await freeze;
  assert.equal(agent.migrationFrozen, true);
  assert.deepEqual(writes, [['migrationFrozen:v1', true]]);

  await WorkspaceAgent.prototype.unfreezeAfterMigration.call(agent);
  assert.equal(agent.migrationFrozen, false);
  assert.deepEqual(deletes, [['migrationFrozen:v1']]);

  agent.migrationFrozen = true;
  agent.ctx.storage.delete = async () => {
    throw new Error('marker delete failed');
  };
  await assert.rejects(
    WorkspaceAgent.prototype.unfreezeAfterMigration.call(agent),
    /marker delete failed/,
  );
  assert.equal(agent.migrationFrozen, true);

  agent.waitUntilStable = async () => false;
  await assert.rejects(
    WorkspaceAgent.prototype.freezeForMigration.call(agent),
    /did not become stable/,
  );
  assert.equal(agent.migrationFrozen, false);

  agent.waitUntilStable = async () => true;
  agent.activeMutations = 1;
  await assert.rejects(
    WorkspaceAgent.prototype.freezeForMigration.call(agent),
    /active mutation/,
  );
  assert.equal(agent.migrationFrozen, false);
});

test('migration freeze refuses to race an active mutation', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const writes = [];
  const agent = {
    activeMutations: 1,
    migrationFrozen: false,
    waitUntilStable: async () => true,
    ctx: {
      blockConcurrencyWhile: async (operation) => operation(),
      storage: { put: async (...args) => writes.push(args) },
    },
  };
  await assert.rejects(
    WorkspaceAgent.prototype.freezeForMigration.call(agent),
    /active mutation/,
  );
  assert.equal(agent.migrationFrozen, false);
  assert.deepEqual(writes, []);
});

test('framework chat admitted before freeze drains its assistant persistence', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  const base = Object.getPrototypeOf(WorkspaceAgent.prototype);
  const originalPersist = base.persistMessages;
  const persisted = [];
  let resolveUserPersisted;
  const userPersisted = new Promise((resolve) => { resolveUserPersisted = resolve; });
  let streamController;
  base.persistMessages = async function(messages) {
    persisted.push({ ids: messages.map((message) => message.id), active: this.activeMutations });
    this.messages = [...messages];
    if (messages.some((message) => message.role === 'user')) resolveUserPersisted();
  };
  agent.onChatMessage = async () => new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  }));

  try {
    const chat = agent.onMessage(testConnection(), chatRequest());
    await userPersisted;
    for (let attempt = 0; attempt < 100 && !streamController; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(streamController, 'framework chat stream should be active after user persistence');

    const freeze = agent.freezeForMigration();
    assert.equal(agent.migrationFrozen, false, 'freeze must drain the admitted turn first');
    streamController.enqueue(new TextEncoder().encode('answer'));
    streamController.close();

    await chat;
    await freeze;
    assert.equal(agent.migrationFrozen, true);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].ids.length, 1);
    assert.equal(persisted[1].ids.length, 2);
    assert.equal(persisted[1].active, 1);
    assert.equal(agent.messages.at(-1)?.role, 'assistant');
  } finally {
    base.persistMessages = originalPersist;
  }
});

test('an in-flight standalone messages write makes migration freeze retry', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  const base = Object.getPrototypeOf(WorkspaceAgent.prototype);
  const originalPersist = base.persistMessages;
  let resolveEntered;
  let resolveRelease;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  const release = new Promise((resolve) => { resolveRelease = resolve; });
  base.persistMessages = async function(messages) {
    this.messages = [...messages];
    resolveEntered();
    await release;
  };

  try {
    const persist = WorkspaceAgent.prototype.persistMessages.call(agent, [{
      id: 'standalone-user',
      role: 'user',
      parts: [{ type: 'text', text: 'already delivered' }],
    }]);
    await entered;
    assert.equal(agent.activeMutations, 1);
    await assert.rejects(
      agent.freezeForMigration(),
      /active mutation/,
    );
    assert.equal(agent.migrationFrozen, false);

    resolveRelease();
    await persist;
    assert.equal(agent.activeMutations, 0);
    await agent.freezeForMigration();
    assert.equal(agent.migrationFrozen, true);
  } finally {
    resolveRelease();
    base.persistMessages = originalPersist;
  }
});

test('frozen agents refuse new chat submits and reconnects', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  agent.migrationFrozen = true;
  let closeArgs;
  const reconnect = testConnection('reconnect');
  reconnect.close = (...args) => { closeArgs = args; };

  await WorkspaceAgent.prototype.onConnect.call(agent, reconnect, {
    request: new Request('https://agent.test/agents/ws'),
  });
  assert.deepEqual(closeArgs, [1012, 'migration_in_progress']);

  await assert.rejects(
    agent.onMessage(testConnection('new-chat'), chatRequest('turn-2', 'user-2')),
    /workspace is frozen for migration/,
  );
});

test('migration freeze closes direct persistence and clear/reset paths', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const base = Object.getPrototypeOf(WorkspaceAgent.prototype);
  const originalPersist = base.persistMessages;
  const originalReset = base.resetTurnState;
  let persistCalls = 0;
  let resetCalls = 0;
  base.persistMessages = async () => {
    persistCalls += 1;
  };
  base.resetTurnState = () => {
    resetCalls += 1;
  };
  try {
    const agent = {
      migrationFrozen: true,
      assertNotFrozen: WorkspaceAgent.prototype.assertNotFrozen,
    };
    await assert.rejects(
      WorkspaceAgent.prototype.persistMessages.call(agent, [{
        id: 'assistant-message',
        role: 'assistant',
        parts: [{ type: 'text', text: 'done' }],
      }]),
      /workspace is frozen for migration/,
    );
    assert.equal(persistCalls, 0);
    assert.throws(
      () => WorkspaceAgent.prototype.resetTurnState.call(agent),
      /workspace is frozen for migration/,
    );

    agent.migrationFrozen = false;
    WorkspaceAgent.prototype.resetTurnState.call(agent);
    assert.equal(resetCalls, 1);
  } finally {
    base.persistMessages = originalPersist;
    base.resetTurnState = originalReset;
  }
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
    cailSubject: TEST_SUBJECTS.alice,
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
    cailSubject: TEST_SUBJECTS.alice,
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
    // Explicit isolated seam: this test exercises the stream envelope on a
    // plain object, not the constructed Durable Object verifier.
    verifyCurrentGatewayCredential() {
      return { status: 'missing' };
    },
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
    // Explicit isolated seam: rate-limit behavior is independent of JWT
    // cryptography and storage lifecycle.
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
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
    return cailErrorResponse(
      429,
      quotaExceededEnvelope({ message: quotaMessage, retryAfterSeconds: 1800 }),
      {
        'retry-after': '1800',
        'x-request-id': 'req-agent-quota-1',
        'x-should-retry': 'false',
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
    // Explicit isolated seam: this test pins quota error surfacing after the
    // credential boundary has already been admitted.
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
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
