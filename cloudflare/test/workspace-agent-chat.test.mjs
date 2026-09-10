import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';

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

test('migration freeze does not swallow falsy marker-write failures', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  for (const rejection of [null, undefined, 0, false]) {
    const agent = {
      activeMutations: 0,
      migrationFrozen: false,
      waitUntilStable: async () => true,
      ctx: {
        blockConcurrencyWhile: async (operation) => operation(),
        storage: {
          put: async () => {
            throw rejection;
          },
        },
      },
    };
    await assert.rejects(
      WorkspaceAgent.prototype.freezeForMigration.call(agent),
      (error) => error instanceof Error
        && error.message === 'workspace migration freeze failed'
        && error.cause === rejection,
    );
    assert.equal(agent.migrationFrozen, false);
  }
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

test('destructive cleanup defers Durable Object destruction for RPC callers', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  let clearRuntimeCalls = 0;
  let deferredDestroyCalls = 0;
  let directDestroyCalls = 0;
  const agent = {
    activeMutations: 0,
    migrationFrozen: true,
    cailIdentityJwt: 'credential',
    cailSubject: 'subject',
    messages: [{ id: 'message' }],
    clearRuntimeFilesUnchecked: async () => {
      clearRuntimeCalls += 1;
    },
    ctx: {
      storage: {
        sql: { exec: () => undefined },
      },
    },
    destroy: async () => {
      directDestroyCalls += 1;
      throw new Error('inline destroy must not run through RPC');
    },
    _cf_scheduleDestroy: async () => {
      deferredDestroyCalls += 1;
    },
  };

  await WorkspaceAgent.prototype.destroyWorkspaceState.call(agent);

  assert.equal(clearRuntimeCalls, 1);
  assert.equal(deferredDestroyCalls, 1);
  assert.equal(directDestroyCalls, 0);
  assert.equal(agent.cailIdentityJwt, null);
  assert.equal(agent.cailSubject, null);
  assert.deepEqual(agent.messages, []);
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

test('code rate-limit denial rejects before sandbox execution', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    env: {
      HEAVY_RATE_LIMIT: { limit: async () => ({ success: false }) },
    },
    cailSubject: TEST_SUBJECTS.alice,
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    withMutationFence(operation) { return operation(); },
    executeCodeFenced: WorkspaceAgent.prototype.executeCodeFenced,
    csrfSessionId() { return 'session-1'; },
    requireSessionId() { return 'session-1'; },
  };

  await assert.rejects(
    WorkspaceAgent.prototype.executeCode.call(agent, 'return 1'),
    /rate_limited/,
  );
});

test('successful code execution runs the sandbox once without lifecycle writes', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const sqlWrites = [];
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
      HEAVY_RATE_LIMIT: { limit: async () => ({ success: true }) },
    },
    cailSubject: TEST_SUBJECTS.alice,
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    withMutationFence(operation) { return operation(); },
    executeCodeFenced: WorkspaceAgent.prototype.executeCodeFenced,
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
  assert.equal(sqlWrites.length, 0);
});

test('code RPC fence spans rate-limit admission and rejects queued work before side effects', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  let resolveLimitEntered;
  let resolveLimit;
  const limitEntered = new Promise((resolve) => { resolveLimitEntered = resolve; });
  const limitResult = new Promise((resolve) => { resolveLimit = resolve; });
  let limitCalls = 0;
  let executorCalls = 0;
  const sqlWrites = [];
  const agent = {
    migrationFrozen: false,
    activeMutations: 0,
    cailSubject: TEST_SUBJECTS.alice,
    env: {
      HEAVY_RATE_LIMIT: {
        limit: async () => {
          limitCalls += 1;
          resolveLimitEntered();
          return limitResult;
        },
      },
    },
    ctx: {
      blockConcurrencyWhile: async (operation) => operation(),
      storage: {
        put: async () => {},
        sql: {
          exec: (query, ...bindings) => {
            sqlWrites.push({ query, bindings });
            return { toArray: () => [] };
          },
        },
      },
    },
    waitUntilStable: async () => true,
    assertNotFrozen: WorkspaceAgent.prototype.assertNotFrozen,
    assertAuthorizedRpc() {},
    withMutationFence: WorkspaceAgent.prototype.withMutationFence,
    executeCodeFenced: WorkspaceAgent.prototype.executeCodeFenced,
    csrfSessionId() { return 'session-1'; },
    requireSessionId() { return 'session-1'; },
    requireWorkspace() { return { id: 'workspace-1' }; },
    buildHostTools() { return {}; },
    buildCodeProviders() { return {}; },
    createCodeExecutor() {
      return {
        execute: async () => {
          executorCalls += 1;
          return { ok: true, stdout: '', stderr: '', logs: [] };
        },
      };
    },
  };

  const first = WorkspaceAgent.prototype.executeCode.call(agent, 'return 1');
  await limitEntered;
  assert.equal(agent.activeMutations, 1);
  await assert.rejects(
    WorkspaceAgent.prototype.freezeForMigration.call(agent),
    /active mutation/,
  );
  assert.equal(agent.migrationFrozen, false);

  resolveLimit({ success: true });
  await first;
  assert.equal(agent.activeMutations, 0);
  await WorkspaceAgent.prototype.freezeForMigration.call(agent);
  assert.equal(agent.migrationFrozen, true);

  const beforeQueuedCall = {
    limitCalls,
    executorCalls,
    sqlWrites: sqlWrites.length,
  };
  await assert.rejects(
    WorkspaceAgent.prototype.executeCode.call(agent, 'return 2'),
    /workspace is frozen for migration/,
  );
  assert.equal(limitCalls, beforeQueuedCall.limitCalls);
  assert.equal(executorCalls, beforeQueuedCall.executorCalls);
  assert.equal(sqlWrites.length, beforeQueuedCall.sqlWrites);
});

test('codemode execution is held inside the migration mutation fence', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const events = [];
  const agent = {
    env: { LOADER: {} },
    buildCodeModeHostTools: WorkspaceAgent.prototype.buildCodeModeHostTools,
    getRuntimeWorkspace() {
      return {};
    },
    buildSerializedStateTools() {
      return { tools: {} };
    },
    buildSerializedGitTools() {
      return { tools: {} };
    },
    createCodeExecutor() {
      return {
        execute: async () => {
          events.push('execute');
          return { result: { ok: true } };
        },
      };
    },
    withMutationFence(operation) {
      events.push('enter');
      return Promise.resolve(operation()).finally(() => events.push('exit'));
    },
  };

  const codeTool = WorkspaceAgent.prototype.createCodeModeTool.call(agent, {});
  assert.ok(codeTool.execute);
  const result = await codeTool.execute(
    { code: 'return { ok: true };' },
    { toolCallId: 'tool-call-1', messages: [] },
  );

  assert.deepEqual(result, { result: { ok: true } });
  assert.deepEqual(events, ['enter', 'execute', 'exit']);
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
  assert.equal(payload.error.launch, '/agent-studio');
  assert.equal(Object.keys(payload.error).sort().join(','), 'code,launch,message');
});

test('chat admission aborts a delayed model catalog before model dispatch', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  let catalogSignal;
  let catalogStartedResolve;
  const catalogStarted = new Promise((resolve) => { catalogStartedResolve = resolve; });
  const gateway = {
    async fetch(input, init) {
      if (String(input) === 'https://cail.test/v1/models') {
        catalogSignal = init?.signal;
        catalogStartedResolve();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      throw new Error('inference must not run after admission cancellation');
    },
  };
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() {
      return {
        id: 'workspace-1',
        name: 'Human title',
        description: '',
        createdAt: '',
        updatedAt: '',
        model: 'model-a',
      };
    },
    requireSessionId() {
      return 'session-1';
    },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
  };
  const controller = new AbortController();
  const pending = WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, {
    requestId: 'catalog-abort',
    abortSignal: controller.signal,
  });
  await catalogStarted;
  controller.abort();

  let timeout;
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve('timed-out'), 100);
    }),
  ]);
  clearTimeout(timeout);
  assert.notEqual(outcome, 'timed-out', 'chat admission should settle on Stop');
  assert.equal(outcome, controller.signal.reason);
  assert.equal(catalogSignal?.aborted, true);
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

// A gateway quota envelope reaches the chat user on the first wire call. The
// direct AI SDK provider has retries disabled and preserves the typed message.
test('gateway 429 quota_exceeded streams the verbatim quota message to the user', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');

  const quotaMessage =
    'You have reached your CAIL usage quota for this period. Try again in about 1800 seconds.';
  let wireCalls = 0;
  const gateway = {
    async fetch(input) {
      if (String(input) === 'https://cail.test/v1/models') {
        return Response.json({
          object: 'list',
          data: [{ id: DEFAULT_CAIL_MODEL, capabilities: ['text-generation', 'function-calling'] }],
        });
      }
      wireCalls += 1;
      return Response.json({
        error: {
          message: quotaMessage,
          type: 'rate_limit_error',
          param: null,
          code: 'quota_exceeded',
          cail: { retry_after_seconds: 1800, retryable: false },
        },
      }, { status: 429, headers: {
        'retry-after': '1800',
        'x-request-id': 'req-agent-quota-1',
        'x-should-retry': 'false',
      } });
    },
  };

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
    // Explicit isolated seam: this test checks quota error surfacing after the
    // credential boundary has already been admitted.
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
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
  // The APICallError must not be SDK-retried: one wire call, no retry storm.
  assert.equal(wireCalls, 1, 'the AI SDK must not retry the chat request');
});

test('a placeholder workspace remains title-eligible after an empty prior response', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  let buildWorkspace;
  const noopTool = tool({
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  const gateway = {
    async fetch(input) {
      if (String(input) === 'https://cail.test/v1/models') {
        return Response.json({
          object: 'list',
          data: [{ id: DEFAULT_CAIL_MODEL, capabilities: ['text-generation', 'function-calling'] }],
        });
      }
      return Response.json({
        id: 'chatcmpl-title-survival',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  };
  const workspace = {
    id: 'placeholder-workspace',
    name: 'New Workspace',
    description: '',
    createdAt: '',
    updatedAt: '',
  };
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() { return workspace; },
    requireSessionId() { return 'session-1'; },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() { return { status: 'valid' }; },
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
    state: { panels: [] },
    messages: [
      { id: 'prior-user', role: 'user', parts: [{ type: 'text', text: 'Build a dashboard' }] },
      { id: 'prior-empty-response', role: 'assistant', parts: [{ type: 'text', text: '' }] },
      { id: 'follow-up', role: 'user', parts: [{ type: 'text', text: 'Add sources' }] },
    ],
    buildHostTools(workspaceArg) {
      buildWorkspace = workspaceArg;
      return {};
    },
    createCodeModeTool() { return noopTool; },
    buildModelTools() { return {}; },
  };

  const response = await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, {
    requestId: 'title-survival',
  });
  await response.text();

  assert.equal(buildWorkspace.name, 'New Workspace');
});

test('chat refuses a named non-function-capable model before inference', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() {
      return {
        id: 'workspace-1',
        name: 'Human title',
        description: '',
        createdAt: '',
        updatedAt: '',
        model: 'model',
      };
    },
    requireSessionId() {
      return 'session-1';
    },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
    env: {
      CAIL_API_BASE: 'https://cail.test',
      GATEWAY: {
        async fetch(input) {
          if (String(input) !== 'https://cail.test/v1/models') {
            throw new Error('inference must not run for an unsupported model');
          }
          return Response.json({
            object: 'list',
            data: [{ id: 'model', capabilities: ['text-generation'] }],
          });
        },
      },
    },
    messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build a dashboard' }] }],
    buildHostTools() {
      throw new Error('tools must not be built for an unsupported model');
    },
  };

  const response = await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, {
    requestId: 'unsupported-model',
  });
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);
  assert.equal(payload.error.code, 'model_capability_required');
  assert.equal(payload.error.cail.retryable, false);
});

test('chat caches function capability per model and revalidates a changed model', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  let workspaceModel = 'model-a';
  let catalogCalls = 0;
  let inferenceCalls = 0;
  const gateway = {
    async fetch(input) {
      const url = String(input);
      if (url === 'https://cail.test/v1/models') {
        catalogCalls += 1;
        return Response.json({
          object: 'list',
          data: [
            { id: 'model-a', capabilities: ['text-generation', 'function-calling'] },
            { id: 'model-b', capabilities: ['text-generation', 'function-calling'] },
          ],
        });
      }
      inferenceCalls += 1;
      return new Response(
        'data: {"id":"chatcmpl-cache","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'
        + 'data: {"id":"chatcmpl-cache","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
  const noopTool = tool({
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  const agent = {
    assertNotFrozen() {},
    requireWorkspace() {
      return {
        id: 'workspace-1',
        name: 'Human title',
        description: '',
        createdAt: '',
        updatedAt: '',
        model: workspaceModel,
      };
    },
    requireSessionId() {
      return 'session-1';
    },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() {
      return { status: 'valid' };
    },
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
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
  };

  await (await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, { requestId: 'cache-1' })).text();
  assert.equal(catalogCalls, 1);
  assert.equal(inferenceCalls, 1);

  await (await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, { requestId: 'cache-2' })).text();
  assert.equal(catalogCalls, 1, 'the same model should use the warm capability proof');
  assert.equal(inferenceCalls, 2, 'the second turn should still make one inference request');

  workspaceModel = 'model-b';
  await (await WorkspaceAgent.prototype.onChatMessage.call(agent, undefined, { requestId: 'cache-3' })).text();
  assert.equal(catalogCalls, 2, 'a changed model must be validated once');
  assert.equal(inferenceCalls, 3, 'the changed model should still make one inference request');
});

test('framework chat repairs an interrupted tool before a follow-up reaches inference', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const requests = [];
  const gateway = {
    async fetch(_input, init) {
      requests.push(JSON.parse(init.body));
      return new Response(
        'data: {"id":"recovery","choices":[{"index":0,"delta":{"role":"assistant","content":"Recovered"},"finish_reason":null}]}\n\n'
        + 'data: {"id":"recovery","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
  const messages = [
    { id: 'first', role: 'user', parts: [{ type: 'text', text: 'Read the file' }] },
    { id: 'interrupted', role: 'assistant', parts: [
      { type: 'text', text: 'Opening the file.' },
      { type: 'tool-read_file', toolCallId: 'interrupted-call', state: 'input-available', input: { path: 'notes.txt' } },
      { type: 'tool-read_file', toolCallId: 'failed-call', state: 'output-error', input: { path: 'missing.txt' }, errorText: 'File not found' },
    ] },
    { id: 'follow-up', role: 'user', parts: [{ type: 'text', text: 'Continue please' }] },
  ];
  const originalMessages = structuredClone(messages);
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  Object.assign(agent, {
    assertNotFrozen() {},
    requireWorkspace() { return { id: 'workspace-1' }; },
    requireSessionId() { return 'session-1'; },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() { return { status: 'valid' }; },
    functionCallingModelId: DEFAULT_CAIL_MODEL,
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
    messages,
    buildHostTools() { return {}; },
    buildModelTools() { return {}; },
    createCodeModeTool() {
      return tool({ inputSchema: z.object({}), execute: async () => 'ok' });
    },
  });
  // The storage adapter above has no SQLite rows; keep only persistence in
  // memory while the real framework receiver, repair, and stream handler run.
  agent.persistMessages = async (next) => { agent.messages = structuredClone(next); };
  await agent.onMessage(testConnection(), JSON.stringify({
    type: 'cf_agent_use_chat_request',
    id: 'interrupted-recovery',
    init: { method: 'POST', body: JSON.stringify({ messages }) },
  }));
  assert.equal(requests.length, 1, 'the follow-up must reach inference');
  assert.ok(agent.messages.some((message) => message.role === 'assistant'
    && message.parts.some((part) => part.type === 'text' && part.text.includes('Recovered'))));
  const toolCalls = requests[0].messages.flatMap((message) => message.tool_calls ?? []);
  assert.ok(toolCalls.some((call) => call.id === 'interrupted-call'));
  assert.ok(requests[0].messages.some((message) => message.role === 'tool'
    && message.tool_call_id === 'interrupted-call' && message.content.includes('interrupted')));
  assert.ok(toolCalls.some((call) => call.id === 'failed-call'));
  assert.ok(requests[0].messages.some((message) => message.role === 'tool'
    && message.tool_call_id === 'failed-call' && message.content.includes('File not found')));
  assert.ok(requests[0].messages.some((message) => message.content === 'Opening the file.'));
  assert.deepEqual(messages, originalMessages, 'client conversation remains unchanged');
  assert.equal(agent.messages[0].parts[0].text, 'Read the file');
});

test('framework chat surfaces known Gateway failures without retrying or clearing instructions', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const cases = [
    { code: 'outcome_unknown', status: 502, message: 'The model service did not confirm whether the request completed. Do not retry automatically.', expectedRetryable: false },
    { code: 'upstream_error', status: 502, message: 'The model service did not complete the request. Try again later.', retryable: false, expectedRetryable: false },
    { code: 'upstream_rate_limited', status: 429, message: 'The model service is temporarily busy. Try again later.', retryable: true, expectedRetryable: true },
    { code: 'provider_configuration_error', status: 503, message: 'The requested model service is temporarily unavailable. Try again later.' },
  ];
  for (const failure of cases) {
    const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
    let inferenceCalls = 0;
    let responseBody;
    Object.assign(agent, {
      requireWorkspace() { return { id: 'workspace-1' }; },
      requireSessionId() { return 'session-1'; },
      cailIdentityJwt: 'verified-jwt',
      verifyCurrentGatewayCredential() { return { status: 'valid' }; },
      functionCallingModelId: DEFAULT_CAIL_MODEL,
      env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: {
        async fetch() {
          inferenceCalls += 1;
          return Response.json({ error: {
            code: failure.code, message: failure.message,
            type: failure.status === 429 ? 'rate_limit_error' : 'server_error',
            cail: { retryable: failure.retryable },
          } }, { status: failure.status });
        },
      } },
      buildHostTools() { return {}; },
      buildModelTools() { return {}; },
      createCodeModeTool() {
        return tool({ inputSchema: z.object({}), execute: async () => 'ok' });
      },
    });
    // Exercise the actual framework receiver and response handling with only
    // storage and the Gateway boundary replaced by deterministic adapters.
    agent.persistMessages = async (next) => { agent.messages = structuredClone(next); };
    agent.onChatMessage = async (...args) => {
      const response = await WorkspaceAgent.prototype.onChatMessage.apply(agent, args);
      responseBody = response.clone().text();
      return response;
    };
    await agent.onMessage(testConnection(), chatRequest());
    const events = (await responseBody).split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const error = JSON.parse(events.find((event) => event.type === 'error').errorText).error;
    assert.equal(error.code, failure.code);
    assert.equal(error.message, failure.message);
    assert.equal(error.cail.retryable, failure.expectedRetryable);
    assert.equal(inferenceCalls, 1);
    assert.equal(agent.messages[0].parts[0].text, 'hello');
  }
});

test('a failed provider stream during tool arguments preserves instructions and allows one follow-up inference', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const requests = [];
  let allowFailure;
  const failureAllowed = new Promise((resolve) => { allowFailure = resolve; });
  const gateway = {
    async fetch(_input, init) {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        let chunk = 0;
        return new Response(new ReadableStream({
          async pull(controller) {
            if (chunk++ === 0) {
              controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
                id: 'interrupted-stream', choices: [{ index: 0, delta: {
                  role: 'assistant', content: 'Preparing the chart.',
                  tool_calls: [{ index: 0, id: 'partial-code', type: 'function',
                    function: { name: 'codemode', arguments: '{"code":"return ' } }],
                }, finish_reason: null }],
              }) + '\n\n'));
            } else {
              await failureAllowed;
              controller.error(new Error('synthetic upstream body read failure'));
            }
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(
        'data: {"id":"recovered-stream","choices":[{"index":0,"delta":{"role":"assistant","content":"Recovered chart instructions"},"finish_reason":null}]}\n\n'
        + 'data: {"id":"recovered-stream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  Object.assign(agent, {
    requireWorkspace() { return { id: 'workspace-1' }; },
    requireSessionId() { return 'session-1'; },
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() { return { status: 'valid' }; },
    functionCallingModelId: DEFAULT_CAIL_MODEL,
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway },
    buildHostTools() { return {}; },
    buildModelTools() { return {}; },
    createCodeModeTool() {
      return tool({ inputSchema: z.object({ code: z.string() }), execute: async () => 'ok' });
    },
  });
  agent.persistMessages = async (next) => { agent.messages = structuredClone(next); };
  const responseBodies = [];
  agent.onChatMessage = async (...args) => {
    const response = await WorkspaceAgent.prototype.onChatMessage.apply(agent, args);
    const observed = response.clone().body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        if (new TextDecoder().decode(chunk).includes('tool-input-delta')) allowFailure();
        controller.enqueue(chunk);
      },
    }));
    responseBodies.push(new Response(observed).text());
    return response;
  };
  const instructions = { id: 'survey-request', role: 'user', parts: [
    { type: 'text', text: 'Count each survey emotion and create a chart.' },
  ] };
  await agent.onMessage(testConnection(), JSON.stringify({
    type: 'cf_agent_use_chat_request', id: 'failed-stream',
    init: { method: 'POST', body: JSON.stringify({ messages: [instructions] }) },
  }));
  const firstBody = await responseBodies[0];
  assert.match(firstBody, /The response was interrupted before it finished/);
  const errorEvent = firstBody.split('\n').filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)))
    .find((event) => event.type === 'error');
  assert.equal(JSON.parse(errorEvent.errorText).error.code, 'response_interrupted');
  assert.equal(JSON.parse(errorEvent.errorText).error.cail.retryable, false);
  assert.doesNotMatch(firstBody, /synthetic upstream body read failure/);
  assert.equal(requests.length, 1, 'the failed stream is not automatically retried');
  assert.deepEqual(agent.messages[0], instructions);
  assert.ok(agent.messages.some((message) => message.parts.some((part) => part.toolCallId === 'partial-code')));

  await agent.onMessage(testConnection(), JSON.stringify({
    type: 'cf_agent_use_chat_request', id: 'follow-up-stream',
    init: { method: 'POST', body: JSON.stringify({ messages: [...agent.messages, {
      id: 'continue-request', role: 'user', parts: [{ type: 'text', text: 'Continue with that chart.' }],
    }] }) },
  }));
  assert.equal(requests.length, 2, 'the explicit follow-up makes exactly one inference');
  assert.ok(requests[1].messages.some((message) => message.content === instructions.parts[0].text));
  assert.ok(requests[1].messages.some((message) => message.role === 'tool'
    && message.tool_call_id === 'partial-code' && message.content.includes('interrupted')));
  assert.match(await responseBodies[1], /Recovered chart instructions/);
  assert.deepEqual(agent.messages[0], instructions);
});

test('repeated framework turns preserve corrections across Stop during a tool and an explicit resume', { timeout: 5_000 }, async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const { MockR2 } = await import('./helpers/env.mjs');
  const { putWorkspace, getWorkspace } = await import('../src/lib/workspaces.ts');
  const r2 = new MockR2();
  const sessionId = 'a'.repeat(32);
  let catalogCalls = 0;
  const requests = [];
  let toolStarted;
  const toolEntered = new Promise((resolve) => { toolStarted = resolve; });
  let toolSignal;
  const gateway = {
    async fetch(input, init) {
      if (String(input).endsWith('/v1/models')) {
        catalogCalls += 1;
        // The legacy workspace below migrates to the 0731 ID, which must be in the catalog regardless of the current default.
        return Response.json({ object: 'list', data: [{ id: 'deepseek-v4-flash-0731', capabilities: ['text-generation', 'function-calling'] }] });
      }
      requests.push(JSON.parse(init.body));
      const counting = requests.length === 1;
      const correcting = requests.length === 3;
      const callsTool = counting || correcting;
      const reasoning = `Synthetic reasoning for inference ${requests.length}.`;
      const delta = callsTool
        ? { role: 'assistant', reasoning_content: reasoning,
          tool_calls: [{ index: 0, id: counting ? 'survey-counts' : 'chart-revision', type: 'function',
            function: { name: 'codemode', arguments: JSON.stringify({ code: counting ? 'count emotions' : 'revise chart' }) } }] }
        : { role: 'assistant', reasoning_content: reasoning, content: `Completed turn ${requests.length}.` };
      return new Response(
        'data: ' + JSON.stringify({ id: 'survey-turn', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'survey-turn', choices: [{ index: 0, delta: {}, finish_reason: callsTool ? 'tool_calls' : 'stop' }] }) + '\n\n'
        + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
  const agent = await makeRealWorkspaceAgent(WorkspaceAgent);
  Object.assign(agent, {
    cailIdentityJwt: 'verified-jwt',
    verifyCurrentGatewayCredential() { return { status: 'valid' }; },
    async requestModelCredential() { return 'verified-jwt'; },
    env: { CAIL_API_BASE: 'https://cail.test', GATEWAY: gateway, WORKSPACE_FILES: r2 },
    buildHostTools() { return {}; },
    buildModelTools() { return {}; },
    createCodeModeTool() {
      return tool({
        inputSchema: z.object({ code: z.string() }),
        execute: async (input, options) => {
          if (input.code === 'count emotions') return { counts: { joy: 2, nervous: 1 }, total: 3 };
          toolSignal = options.abortSignal;
          toolStarted();
          await new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true });
          });
          throw new Error('a cancelled tool must never complete');
        },
      });
    },
  });
  const legacyWorkspace = {
    id: 'workspace-1', name: 'Survey workspace', description: 'Retain this description',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    model: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  };
  await putWorkspace(agent.env, sessionId, legacyWorkspace);
  await agent.syncWorkspace(legacyWorkspace, sessionId);
  // SQLite persistence, credential refresh, and provider execution are deterministic adapters;
  // submit, cancel, history repair, tool execution, and reply use the real SDK.
  agent.persistMessages = async (next) => { agent.messages = structuredClone(next); };
  const userMessages = [];
  async function submit(id, text) {
    const message = { id, role: 'user', parts: [{ type: 'text', text }] };
    userMessages.push(message);
    return agent.onMessage(testConnection(), JSON.stringify({
      type: 'cf_agent_use_chat_request', id,
      init: { method: 'POST', body: JSON.stringify({ messages: [...agent.messages, message] }) },
    }));
  }
  await submit('initial-survey', 'Use the uploaded survey. Keep all original emotion labels in a count chart.');
  const correction = submit('correct-chart', 'Combine capitalization variants, but keep anxious and nervous separate.');
  await toolEntered;
  await agent.onMessage(testConnection(), JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'correct-chart' }));
  await correction;
  assert.equal(toolSignal.aborted, true);
  assert.equal(requests.length, 3, 'Stop must prevent another inference after the cancelled tool');
  assert.deepEqual(agent.messages.filter((message) => message.role === 'user'), userMessages);

  await submit('resume-chart', 'Continue with my correction.');
  assert.equal(requests.length, 4, 'resume must send exactly one new inference');
  assert.ok(requests[3].messages.some((message) => message.role === 'tool'
    && message.tool_call_id === 'chart-revision'));
  await submit('explain-chart', 'Explain which labels were combined.');
  assert.equal(requests.length, 5, 'the later follow-up must also send exactly one inference');
  for (const message of userMessages) {
    assert.ok(requests[4].messages.some((sent) => sent.role === 'user' && sent.content === message.parts[0].text));
  }
  assert.equal(catalogCalls, 1, 'the migrated selection gets one capability proof');
  for (const request of requests) assert.equal(request.model, 'deepseek-v4-flash-0731');
  const canonicalWorkspace = { ...legacyWorkspace, model: 'deepseek-v4-flash-0731' };
  assert.deepEqual(await getWorkspace(agent.env, sessionId, legacyWorkspace.id), canonicalWorkspace);
  assert.deepEqual(agent.state.workspace, canonicalWorkspace);
  const finalMessages = requests[4].messages;
  const historicalCalls = finalMessages.flatMap((message) => message.tool_calls ?? []);
  assert.ok(historicalCalls.some((call) => call.id === 'survey-counts' && call.function.name === 'codemode'));
  assert.ok(historicalCalls.some((call) => call.id === 'chart-revision' && call.function.name === 'codemode'));
  const countsResult = finalMessages.find((message) => message.role === 'tool' && message.tool_call_id === 'survey-counts');
  assert.deepEqual(JSON.parse(countsResult.content), { counts: { joy: 2, nervous: 1 }, total: 3 });
  assert.ok(finalMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'chart-revision'));
  for (const inference of [1, 2, 3, 4]) {
    assert.ok(finalMessages.some((message) => message.role === 'assistant'
      && message.reasoning_content === `Synthetic reasoning for inference ${inference}.`));
  }
  assert.deepEqual(agent.messages.filter((message) => message.role === 'user'), userMessages);
  assert.ok(agent.messages.at(-1).parts.some((part) => part.type === 'text' && part.text === 'Completed turn 5.'));
});
