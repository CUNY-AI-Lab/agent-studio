import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';
import { makeAgentContext, makeSqlAgentStorage } from './helpers/agent-storage.mjs';
import { completeSessionHistory } from '../src/lib/session-history.ts';

registerCloudflareStub();
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

test('complete history crosses the Agents 10,001-row path cap without loss or reordering', {
  timeout: 30_000,
}, async () => {
  const storage = makeSqlAgentStorage();
  const agent = new WorkspaceAgent(makeAgentContext(storage), {});
  await agent.__unsafe_ensureInitialized();
  const session = agent.sessions.session();
  const count = 10_003;
  let parentId = null;

  for (let index = 0; index < count; index += 1) {
    const id = `message-${String(index).padStart(5, '0')}`;
    const message = index === 5_001
      ? {
        id,
        role: 'assistant',
        metadata: { retained: true, index },
        parts: [{
          type: 'tool-lookup',
          toolCallId: 'call-middle',
          state: 'output-available',
          input: { query: 'middle' },
          output: { found: true },
        }],
      }
      : {
        id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `message ${index}` }],
      };
    await session.importMessage(message, { parentId, createdAt: index });
    parentId = id;
  }

  assert.equal((await session.getHistory()).length, 10_001, 'fixture must cross the upstream cap');
  const history = [];
  for await (const message of completeSessionHistory(session)) history.push(message);

  assert.equal(history.length, count);
  assert.deepEqual(
    history.map((message) => message.id),
    Array.from({ length: count }, (_, index) => `message-${String(index).padStart(5, '0')}`),
  );
  assert.deepEqual(history[5_001].metadata, { retained: true, index: 5_001 });
  assert.deepEqual(history[5_001].parts, [{
    type: 'tool-lookup',
    toolCallId: 'call-middle',
    state: 'output-available',
    input: { query: 'middle' },
    output: { found: true },
  }]);
});

test('complete history fails closed on empty, missing, and repeated boundaries', async () => {
  const latest = { id: 'leaf', role: 'user', parts: [] };

  await assert.rejects(async () => {
    for await (const _message of completeSessionHistory({
      async getLatestLeaf() { return latest; },
      async getHistoryRowStats() { return []; },
      async getMessage() { return latest; },
    })) { /* consume */ }
  }, /missing its requested leaf/);

  await assert.rejects(async () => {
    for await (const _message of completeSessionHistory({
      async getLatestLeaf() { return latest; },
      async getHistoryRowStats() { return [{ id: 'other' }]; },
      async getMessage() { return null; },
    })) { /* consume */ }
  }, /missing its requested leaf/);

  await assert.rejects(async () => {
    for await (const _message of completeSessionHistory({
      async getLatestLeaf() { return latest; },
      async getHistoryRowStats(leafId) {
        return leafId === 'leaf'
          ? [{ id: 'older' }, { id: 'leaf' }]
          : [{ id: 'leaf' }, { id: 'older' }];
      },
      async getMessage() { return latest; },
    })) { /* consume */ }
  }, /repeated page boundary/);
});
