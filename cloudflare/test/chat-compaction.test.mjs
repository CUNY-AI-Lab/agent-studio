import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

import {
  CHAT_COMPACTION_RECENT_COMPLETE_TURNS,
  ChatCompactionStore,
  chatCompactionThresholdTokens,
  estimateChatTokens,
  panelProvenance,
  planChatCompaction,
  renderChatCompactionSummary,
  splitChatTurns,
} from '../src/agent/chat-compaction.ts';

registerCloudflareStub();

function makeSqlStorage() {
  const tables = new Map();
  const result = (rows = []) => ({
    toArray: () => rows,
    [Symbol.iterator]: function* iterator() {
      yield* rows;
    },
  });
  const exec = (query, ...bindings) => {
    const normalized = query.replace(/\s+/g, ' ').trim();
    const create = normalized.match(/^create table if not exists ([a-z0-9_]+)/i);
    if (create) {
      if (!tables.has(create[1])) tables.set(create[1], new Map());
      return result();
    }
    const drop = normalized.match(/^drop table if exists ([a-z0-9_]+)/i);
    if (drop) {
      tables.delete(drop[1]);
      return result();
    }
    if (/^(alter table|create index|pragma)/i.test(normalized)) return result();
    if (/^insert or replace into/i.test(normalized)) return result();
    const deletion = normalized.match(/^delete from ([a-z0-9_]+)/i);
    if (deletion) {
      tables.get(deletion[1])?.clear();
      return result();
    }
    const select = normalized.match(/^select .* from ([a-z0-9_]+)/i);
    if (select) {
      return result([...(tables.get(select[1])?.values() ?? [])]);
    }
    const insert = normalized.match(/^insert into ([a-z0-9_]+)/i);
    if (insert) {
      const table = tables.get(insert[1]);
      if (!table) throw new Error(`table missing: ${insert[1]}`);
      if (insert[1] === 'agent_studio_chat_turn_context') {
        const [userMessageId, requestId, scopePanelIds, panels, recordedAt] = bindings;
        if (!table.has(userMessageId)) {
          table.set(userMessageId, {
            user_message_id: userMessageId,
            request_id: requestId,
            scope_panel_ids: scopePanelIds,
            panels,
            recorded_at: recordedAt,
          });
        }
      } else {
        const [version, anchorMessageId, throughMessageId, sourceMessageIds, summary,
          panelProvenance, modelContextLength, thresholdTokens, createdAt, updatedAt] = bindings;
        table.set(1, {
          slot: 1,
          version,
          anchor_message_id: anchorMessageId,
          through_message_id: throughMessageId,
          source_message_ids: sourceMessageIds,
          summary,
          panel_provenance: panelProvenance,
          model_context_length: modelContextLength,
          threshold_tokens: thresholdTokens,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return result();
    }
    throw new Error(`unsupported SQL: ${normalized}`);
  };
  return { tables, sql: { exec } };
}

function user(id, text = id) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistant(id, text = id, parts = [{ type: 'text', text }]) {
  return { id, role: 'assistant', parts };
}

function turn(index) {
  return [
    user(`user-${index}`, `question ${index}`),
    assistant(`assistant-${index}`, `answer ${index}`),
  ];
}

test('splitChatTurns preserves whole UI turns and marks unresolved tool work', () => {
  const messages = [
    ...turn(1),
    user('user-2'),
    assistant('assistant-2', '', [{
      type: 'tool-codemode',
      toolCallId: 'tool-2',
      state: 'input-available',
      input: { code: 'await work()' },
    }]),
  ];

  const turns = splitChatTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].settled, true);
  assert.equal(turns[1].settled, false);
  assert.deepEqual(turns[1].messages, messages.slice(2));
});

test('planChatCompaction keeps the current and two recent complete turns intact', () => {
  const messages = [
    ...turn(1),
    ...turn(2),
    ...turn(3),
    ...turn(4),
  ];
  const plan = planChatCompaction(messages);

  assert.equal(CHAT_COMPACTION_RECENT_COMPLETE_TURNS, 2);
  assert.deepEqual(plan.candidateMessages.map((message) => message.id), [
    'user-1', 'assistant-1',
  ]);
  assert.deepEqual(plan.retainedMessages, messages.slice(2));
  assert.equal(plan.anchorMessageId, 'user-1');
  assert.equal(plan.throughMessageId, 'assistant-1');
  // The retained UI objects are the originals, including any provider-specific
  // reasoning_content carried on the parts.
  assert.strictEqual(plan.retainedMessages[0], messages[2]);
});

test('planChatCompaction never crosses an unsettled historical turn', () => {
  const messages = [
    ...turn(1),
    user('user-2'),
    assistant('assistant-2', '', [{ type: 'tool-codemode', state: 'input-available' }]),
    ...turn(3),
    ...turn(4),
    ...turn(5),
  ];
  const plan = planChatCompaction(messages);
  assert.deepEqual(plan.candidateMessages, []);
  assert.deepEqual(plan.retainedMessages, messages);
  assert.equal(plan.throughMessageId, null);
});

test('planChatCompaction appends only messages after the durable marker', () => {
  const messages = [
    ...turn(1),
    ...turn(2),
    ...turn(3),
    ...turn(4),
    ...turn(5),
  ];
  const plan = planChatCompaction(messages, 'assistant-1');
  assert.deepEqual(plan.candidateMessages.map((message) => message.id), [
    'user-2', 'assistant-2',
  ]);
  assert.equal(plan.throughMessageId, 'assistant-2');
  assert.equal(plan.anchorMessageId, null);
});

test('threshold and estimator leave explicit reserves for the model call', () => {
  assert.equal(chatCompactionThresholdTokens(100_000, {
    output: 10,
    system: 20,
    tools: 30,
  }), 59_940);
  assert.equal(chatCompactionThresholdTokens(null), null);
  assert.equal(chatCompactionThresholdTokens(1_000_000), 579_520);
  assert.ok(estimateChatTokens('a'.repeat(401)) >= 100);
});

test('summary is bounded, identifies its historical provenance, and omits raw reasoning', () => {
  const messages = [
    user('user-1', 'Summarize the source'),
    assistant('assistant-1', '', [
      { type: 'reasoning', text: 'secret chain of thought' },
      { type: 'text', text: 'The source says 42.' },
    ]),
  ];
  const provenance = [{
    userMessageId: 'user-1',
    requestId: 'request-1',
    scopePanelIds: ['panel-1'],
    panels: [{ id: 'panel-1', type: 'markdown', title: 'Source' }],
    recordedAt: '2026-01-01T00:00:00.000Z',
  }];
  const summary = renderChatCompactionSummary(null, messages, provenance, 500);
  const shortSummary = renderChatCompactionSummary(null, messages, provenance, 180);

  assert.ok(summary.length <= 500);
  assert.match(summary, /Server-maintained conversation summary/);
  assert.match(summary, /scope user-1/);
  assert.match(shortSummary, /older context omitted/);
  assert.doesNotMatch(summary, /secret chain of thought/);
});

test('panelProvenance keeps stable references without copying panel content', () => {
  const panel = {
    id: 'file-1',
    type: 'file',
    title: 'Source PDF',
    filePath: 'sources/source.pdf',
    content: 'large private content that must not enter metadata',
  };
  assert.deepEqual(panelProvenance(panel), {
    id: 'file-1',
    type: 'file',
    promptData: '{"id":"file-1","type":"file","title":"Source PDF","filePath":"sources/source.pdf","content":"large private content that must not enter metadata"}',
    title: 'Source PDF',
    filePath: 'sources/source.pdf',
  });
});

test('ChatCompactionStore persists overlays and immutable per-turn scope snapshots', () => {
  const storage = makeSqlStorage();
  const store = new ChatCompactionStore(storage.sql);
  const panel = {
    id: 'panel-1',
    type: 'markdown',
    title: 'Source',
    content: 'The source text',
  };
  store.recordTurnScope({
    userMessageId: 'user-1',
    requestId: 'request-1',
    scopePanelIds: ['panel-1'],
    scopedPanels: [panel],
  });
  // A continuation with an empty body cannot erase the admission snapshot.
  store.recordTurnScope({
    userMessageId: 'user-1',
    requestId: 'continuation-1',
    scopePanelIds: [],
    scopedPanels: [],
  });
  const scopes = store.readTurnScopes();
  assert.equal(scopes.get('user-1').requestId, 'request-1');
  assert.deepEqual(scopes.get('user-1').scopePanelIds, ['panel-1']);
  assert.match(scopes.get('user-1').panels[0].promptData, /The source text/);

  const overlay = {
    version: 1,
    anchorMessageId: 'user-1',
    throughMessageId: 'assistant-1',
    sourceMessageIds: ['user-1', 'assistant-1'],
    summary: 'Historical answer',
    panelProvenance: [scopes.get('user-1')],
    modelContextLength: 128_000,
    thresholdTokens: 56_320,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  store.writeOverlay(overlay);
  assert.deepEqual(store.readOverlay(), overlay);

  store.clear();
  assert.equal(store.readOverlay(), null);
  assert.equal(store.readTurnScopes().size, 0);
});

test('ChatCompactionStore degrades cleanly without Durable Object SQL', () => {
  const store = new ChatCompactionStore(undefined);
  assert.equal(store.available, false);
  assert.equal(store.readOverlay(), null);
  assert.equal(store.readTurnScopes().size, 0);
  store.clear();
});

test('WorkspaceAgent compaction writes only the overlay and preserves transcript identity', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  const messages = [
    ...turn(1),
    ...turn(2),
    ...turn(3),
    ...turn(4),
  ];
  agent.messages = messages;
  const scopedPanels = [{ id: 'panel-1', type: 'markdown', title: 'Source', content: 'source text' }];
  agent.messages = messages.slice(0, 2);
  agent.recordChatTurnScope('request-1', ['panel-1'], scopedPanels);
  agent.messages = messages;
  assert.equal(agent.getChatCompactionStore().readTurnScopes().size, 1);
  assert.equal(agent.getChatCompactionStore().readTurnScopes().has('user-1'), true);
  const original = structuredClone(agent.messages);
  const originalReferences = [...agent.messages];
  const result = await agent.prepareChatPromptContext({
    modelMessages: [{ role: 'user', content: 'x'.repeat(400_000) }],
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });

  assert.match(result.systemPrompt, /<chat_compaction_summary>/);
  assert.equal(agent.getChatCompactionStore().readOverlay().panelProvenance.length, 1);
  assert.match(result.systemPrompt, /type=markdown/);
  assert.match(result.systemPrompt, /source text/);
  assert.ok(result.modelMessages.every((message) => message.content !== 'answer 1'));
  assert.deepEqual(agent.messages, original);
  assert.equal(agent.messages[0], originalReferences[0]);
  assert.deepEqual(agent.getChatCompactionStore().readOverlay().sourceMessageIds, [
    'user-1', 'assistant-1',
  ]);
});

test('WorkspaceAgent keeps canonical chat usable when deterministic summary generation fails', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-failure-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  agent.messages = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
  const original = structuredClone(agent.messages);
  agent.createChatCompactionSummary = async () => {
    throw new Error('synthetic summary failure');
  };

  const result = await agent.prepareChatPromptContext({
    modelMessages: [{ role: 'user', content: 'x'.repeat(400_000) }],
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });
  assert.deepEqual(result.modelMessages, [{ role: 'user', content: 'x'.repeat(400_000) }]);
  assert.equal(result.systemPrompt, 'base prompt');
  assert.deepEqual(agent.messages, original);
  assert.equal(agent.getChatCompactionStore().readOverlay(), null);
});
