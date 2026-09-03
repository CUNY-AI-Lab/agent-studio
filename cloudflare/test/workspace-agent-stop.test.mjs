import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const workspace = {
  id: 'workspace-stop-test',
  name: 'Stop test',
  description: '',
  createdAt: '',
  updatedAt: '',
};

function makeQueuedAgent(WorkspaceAgent, overrides = {}) {
  return {
    env: {},
    storageOperationTail: Promise.resolve(),
    activeMutations: 0,
    assertNotFrozen() {},
    withStorageOperation: WorkspaceAgent.prototype.withStorageOperation,
    withMutationFence: WorkspaceAgent.prototype.withMutationFence,
    ...overrides,
  };
}

test('a host mutation rejects after the turn aborts before entering the fence', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let fenceCalls = 0;
  let writes = 0;
  const agent = {
    env: {},
    storageOperationTail: Promise.resolve(),
    withStorageOperation: WorkspaceAgent.prototype.withStorageOperation,
    withMutationFence(operation) {
      fenceCalls += 1;
      return operation();
    },
    getRuntimeWorkspace() {
      return {
        writeFile: async () => {
          writes += 1;
        },
      };
    },
  };
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );

  await tools.write_file.execute({ filePath: 'accepted.txt', content: 'allowed' });
  assert.equal(writes, 1, 'the same host path writes while the turn is active');

  controller.abort();
  await assert.rejects(
    () => tools.write_file.execute({ filePath: 'stopped.txt', content: 'must not write' }),
    (error) => error === controller.signal.reason,
  );
  assert.equal(fenceCalls, 1);
  assert.equal(writes, 1);
});

test('a host append rechecks the turn abort after its existence read', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let existsCalls = 0;
  let releaseExists;
  let existsEntered;
  const existsGate = new Promise((resolve) => { releaseExists = resolve; });
  const entered = new Promise((resolve) => { existsEntered = resolve; });
  let writes = 0;
  const runtime = {
    exists: async () => {
      existsCalls += 1;
      if (existsCalls === 1) return true;
      existsEntered();
      await existsGate;
      return true;
    },
    appendFile: async () => {
      writes += 1;
    },
  };
  const agent = makeQueuedAgent(WorkspaceAgent, {
    getRuntimeWorkspace() {
      return runtime;
    },
  });
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );

  await tools.write_file.execute({ filePath: 'accepted.txt', content: 'allowed', mode: 'append' });
  assert.equal(writes, 1, 'the append path writes while the turn is active');

  const stopped = tools.write_file.execute({
    filePath: 'stopped.txt',
    content: 'must not write',
    mode: 'append',
  });
  await entered;
  controller.abort();
  releaseExists();

  await assert.rejects(stopped, (error) => error === controller.signal.reason);
  assert.equal(writes, 1);
});

test('a docx host write rechecks the turn abort after document generation', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let writes = 0;
  const agent = makeQueuedAgent(WorkspaceAgent, {
    writeRuntimeFileBytes: WorkspaceAgent.prototype.writeRuntimeFileBytes,
    getRuntimeWorkspace() {
      return {
        writeFileBytes: async () => {
          writes += 1;
        },
      };
    },
  });
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );
  const content = [{ type: 'paragraph', text: 'accepted' }];

  await tools.write_docx.execute({ filePath: 'accepted.docx', content });
  assert.equal(writes, 1, 'the docx path writes while the turn is active');

  // Admit the queued operation first, then abort while the real asynchronous
  // DOCX build is preparing bytes. No document implementation is replaced.
  const stopped = tools.write_docx.execute({
    filePath: 'stopped.docx',
    content: [{ type: 'paragraph', text: 'must not write' }],
  });
  queueMicrotask(() => controller.abort());

  await assert.rejects(stopped, (error) => error === controller.signal.reason);
  assert.equal(writes, 1);
});

test('ui_show_file rechecks the turn abort after reading the file', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let readCalls = 0;
  let releaseRead;
  let readEntered;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const entered = new Promise((resolve) => { readEntered = resolve; });
  let panels = 0;
  const runtime = {
    stat: async () => ({ type: 'file', size: 0, mimeType: 'text/plain' }),
    readFileBytes: async () => {
      readCalls += 1;
      if (readCalls > 1) {
        readEntered();
        await readGate;
      }
      return new Uint8Array(0);
    },
  };
  const agent = makeQueuedAgent(WorkspaceAgent, {
    readRuntimeFileContent: WorkspaceAgent.prototype.readRuntimeFileContent,
    getRuntimeWorkspace() {
      return runtime;
    },
    upsertPanelWithAssociation() {
      panels += 1;
    },
  });
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );

  await tools.ui_show_file.execute({ filePath: 'accepted.txt', title: 'Accepted' });
  assert.equal(panels, 1, 'the file panel is created while the turn is active');

  const stopped = tools.ui_show_file.execute({ filePath: 'stopped.txt', title: 'Stopped' });
  await entered;
  controller.abort();
  releaseRead();

  await assert.rejects(stopped, (error) => error === controller.signal.reason);
  assert.equal(panels, 1);
});

test('ui_workspace rechecks the turn abort before the CAS transform', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let getCalls = 0;
  let releaseGet;
  let getEntered;
  const getGate = new Promise((resolve) => { releaseGet = resolve; });
  const entered = new Promise((resolve) => { getEntered = resolve; });
  let puts = 0;
  const env = {
    WORKSPACE_FILES: {
      get: async () => {
        getCalls += 1;
        if (getCalls > 1) {
          getEntered();
          await getGate;
        }
        return { etag: 'etag', json: async () => ({ ...workspace }) };
      },
      put: async () => {
        puts += 1;
        return {};
      },
    },
  };
  const agent = makeQueuedAgent(WorkspaceAgent, {
    env,
    syncWorkspace: async () => {},
  });
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );

  await tools.ui_workspace.execute({ description: 'accepted' });
  assert.equal(puts, 1, 'the workspace metadata writes while the turn is active');

  const stopped = tools.ui_workspace.execute({ description: 'must not write' });
  await entered;
  controller.abort();
  releaseGet();

  await assert.rejects(stopped, (error) => error === controller.signal.reason);
  assert.equal(puts, 1);
});

test('a host mutation rechecks the turn abort after the actual storage queue wait', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let resolveAdmission;
  let fenceEntered;
  const admission = new Promise((resolve) => { resolveAdmission = resolve; });
  const entered = new Promise((resolve) => { fenceEntered = resolve; });
  let writes = 0;
  const agent = {
    env: {},
    storageOperationTail: Promise.resolve(),
    activeMutations: 0,
    assertNotFrozen() {},
    withStorageOperation: WorkspaceAgent.prototype.withStorageOperation,
    withMutationFence: WorkspaceAgent.prototype.withMutationFence,
    getRuntimeWorkspace() {
      return {
        writeFile: async () => {
          writes += 1;
        },
      };
    },
  };
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    agent,
    workspace,
    'session-stop-test',
    [],
    controller.signal,
  );

  const earlierOperation = agent.withStorageOperation(async () => {
    fenceEntered();
    await admission;
  });
  await entered;
  const write = tools.write_file.execute({ filePath: 'queued.txt', content: 'must not write' });
  controller.abort();
  resolveAdmission();

  await assert.rejects(write, (error) => error === controller.signal.reason);
  await earlierOperation;
  assert.equal(writes, 0);
  assert.equal(agent.activeMutations, 0);
});

test('a Code Mode state provider rejects a write after the turn aborts', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const controller = new AbortController();
  let writes = 0;
  const agent = {
    env: {},
    storageOperationTail: Promise.resolve(),
    activeMutations: 0,
    assertNotFrozen() {},
    withStorageOperation: WorkspaceAgent.prototype.withStorageOperation,
    withMutationFence: WorkspaceAgent.prototype.withMutationFence,
    serializeProviderWrites: WorkspaceAgent.prototype.serializeProviderWrites,
    buildSerializedStateTools: WorkspaceAgent.prototype.buildSerializedStateTools,
    buildSerializedGitTools: WorkspaceAgent.prototype.buildSerializedGitTools,
    buildCodeModeHostTools: WorkspaceAgent.prototype.buildCodeModeHostTools,
    getRuntimeWorkspace() {
      return {
        writeFile: async () => {
          writes += 1;
        },
      };
    },
  };
  const providers = WorkspaceAgent.prototype.buildCodeProviders.call(
    agent,
    {},
    controller.signal,
  );
  const state = providers.find((provider) => provider.name === 'state');
  assert.ok(state);

  await state.fns.writeFile({ path: '/accepted.txt', content: 'allowed' });
  assert.equal(writes, 1);
  controller.abort();
  await assert.rejects(
    () => state.fns.writeFile({ path: '/stopped.txt', content: 'must not write' }),
    { name: 'AbortError' },
  );
  assert.equal(writes, 1);
});
