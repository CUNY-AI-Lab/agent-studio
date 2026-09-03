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
