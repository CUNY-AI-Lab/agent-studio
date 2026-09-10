import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { convertToModelMessages } from 'ai';

import { registerCloudflareStub } from './helpers/env.mjs';

import {
  CHAT_COMPACTION_RECENT_COMPLETE_TURNS,
  ChatCompactionStore,
  chatCompactionBudgets,
  estimateChatTokens,
  panelProvenance,
  planChatCompaction,
  renderChatCompactionSummary,
  chatMessagesFingerprint,
  sourceMessagesForChatCompaction,
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
        const [version, anchorMessageId, anchorThroughMessageId, throughMessageId,
          sourceMessageIds, sourceFingerprint, summary, panelProvenance,
          modelContextLength, triggerTokens, targetTokens, thresholdTokens,
          createdAt, updatedAt] = bindings;
        table.set(1, {
          slot: 1,
          version,
          anchor_message_id: anchorMessageId,
          anchor_through_message_id: anchorThroughMessageId,
          through_message_id: throughMessageId,
          source_message_ids: sourceMessageIds,
          source_fingerprint: sourceFingerprint,
          summary,
          panel_provenance: panelProvenance,
          model_context_length: modelContextLength,
          trigger_tokens: triggerTokens,
          target_tokens: targetTokens,
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

function makeRealSqlStorage(schema) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const sql = {
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      if (/^\s*select\b/i.test(query)) {
        return { toArray: () => statement.all(...bindings) };
      }
      if (bindings.length > 0) {
        statement.run(...bindings);
      } else {
        database.exec(query);
      }
      return { toArray: () => [] };
    },
  };
  return { database, sql };
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
  assert.equal(plan.anchorThroughMessageId, 'assistant-1');
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
  assert.equal(plan.anchorThroughMessageId, null);
});

test('source freshness fingerprints every canonical message in the compacted range', async () => {
  const messages = [...turn(1), ...turn(2)];
  const overlay = {
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-1',
  };
  const source = sourceMessagesForChatCompaction(messages, overlay);
  assert.deepEqual(source.map((message) => message.id), ['user-1', 'assistant-1']);
  const fingerprint = await chatMessagesFingerprint(source);
  const changed = structuredClone(source);
  changed[1].parts[0].text = 'edited historical answer';
  assert.notEqual(await chatMessagesFingerprint(changed), fingerprint);
});

test('high-water and target-water budgets cap against explicit reserves', () => {
  assert.deepEqual(chatCompactionBudgets(128_000), {
    hardTokens: 107_520,
    triggerTokens: 102_400,
    targetTokens: 76_800,
  });
  assert.deepEqual(chatCompactionBudgets(100_000, {
    output: 10,
    system: 20,
    tools: 30,
  }), {
    hardTokens: 99_940,
    triggerTokens: 80_000,
    targetTokens: 60_000,
  });
  assert.equal(chatCompactionBudgets(null), null);
  assert.equal(chatCompactionBudgets(20_000), null);
  assert.deepEqual(chatCompactionBudgets(32_000).targetTokens, 11_520);
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

test('successive summary updates remain chronological with one wrapper header', () => {
  const first = renderChatCompactionSummary(null, [...turn(1)], [], 2_000);
  const second = renderChatCompactionSummary(first, [...turn(2)], [], 2_000);
  assert.equal(second.match(/Server-maintained conversation summary/g)?.length, 1);
  assert.ok(second.indexOf('user(user-1)') < second.indexOf('user(user-2)'));
  assert.ok(second.indexOf('assistant(assistant-1)') < second.indexOf('assistant(assistant-2)'));
  assert.ok(second.indexOf('user(user-2)') < second.indexOf('assistant(assistant-2)'));
});

test('completed tool summaries retain independently labeled input and output', () => {
  const summary = renderChatCompactionSummary(null, [
    assistant('assistant-tool', '', [{
      type: 'tool-codemode',
      toolName: 'codemode',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { code: 'return await lookup()' },
      output: { doi: '10.5555/unique-completed-tool-result-doi' },
    }]),
  ], [], 2_000);
  assert.match(summary, /input=/);
  assert.match(summary, /output=.*10\.5555\/unique-completed-tool-result-doi/);
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
    version: 3,
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-1',
    sourceMessageIds: ['user-1', 'assistant-1'],
    sourceFingerprint: 'fingerprint-1',
    summary: 'Historical answer',
    panelProvenance: [scopes.get('user-1')],
    modelContextLength: 128_000,
    triggerTokens: 102_400,
    targetTokens: 76_800,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  store.writeOverlay(overlay);
  assert.deepEqual(store.readOverlay(), overlay);

  store.clear();
  assert.equal(store.readOverlay(), null);
  assert.equal(store.readTurnScopes().size, 0);
});

test('v2-to-v3 overlay upgrade writes the legacy NOT NULL threshold column', () => {
  const { database, sql } = makeRealSqlStorage(`
    create table agent_studio_chat_compaction_overlay (
      slot integer primary key check (slot = 1),
      version integer not null,
      anchor_message_id text,
      through_message_id text not null,
      source_message_ids text not null,
      summary text not null,
      panel_provenance text not null,
      model_context_length integer not null,
      threshold_tokens integer not null,
      created_at text not null,
      updated_at text not null
    )
  `);
  const store = new ChatCompactionStore(sql);
  const overlay = {
    version: 3,
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-2',
    sourceMessageIds: ['user-1', 'assistant-1', 'user-2', 'assistant-2'],
    sourceFingerprint: 'fingerprint-v3',
    summary: 'Historical answer',
    panelProvenance: [],
    modelContextLength: 128_000,
    triggerTokens: 102_400,
    targetTokens: 76_800,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  store.writeOverlay(overlay);
  assert.deepEqual(store.readOverlay(), overlay);
  assert.equal(
    database.prepare('select threshold_tokens from agent_studio_chat_compaction_overlay').get().threshold_tokens,
    overlay.targetTokens,
  );
  database.close();
});

test('intermediate v3 schema upgrade adds the threshold compatibility column', () => {
  const { database, sql } = makeRealSqlStorage(`
    create table agent_studio_chat_compaction_overlay (
      slot integer primary key check (slot = 1),
      version integer not null,
      anchor_message_id text,
      anchor_through_message_id text,
      through_message_id text not null,
      source_message_ids text not null,
      source_fingerprint text,
      summary text not null,
      panel_provenance text not null,
      model_context_length integer not null,
      trigger_tokens integer not null,
      target_tokens integer not null,
      created_at text not null,
      updated_at text not null
    )
  `);
  const store = new ChatCompactionStore(sql);
  const overlay = {
    version: 3,
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-2',
    sourceMessageIds: ['user-1', 'assistant-1', 'user-2', 'assistant-2'],
    sourceFingerprint: 'fingerprint-intermediate-v3',
    summary: 'Historical answer',
    panelProvenance: [],
    modelContextLength: 128_000,
    triggerTokens: 102_400,
    targetTokens: 76_800,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  store.writeOverlay(overlay);
  assert.deepEqual(store.readOverlay(), overlay);
  assert.equal(
    database.prepare('select threshold_tokens from agent_studio_chat_compaction_overlay').get().threshold_tokens,
    overlay.targetTokens,
  );
  database.close();
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
    modelMessages: [{ role: 'user', content: 'x'.repeat(500_000) }],
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });

  assert.equal(result.systemPrompt, 'base prompt');
  assert.equal(agent.getChatCompactionStore().readOverlay().panelProvenance.length, 1);
  const historicalContext = result.modelMessages.find((message) => message.role === 'assistant'
    && JSON.stringify(message.content).includes('<chat_compaction_summary>'));
  assert.match(String(historicalContext.content), /<chat_compaction_summary>/);
  assert.match(String(historicalContext.content), /type=markdown/);
  assert.match(String(historicalContext.content), /source text/);
  assert.doesNotMatch(String(historicalContext.content), /answer 1/);
  assert.ok(!result.systemPrompt.includes('source text'));
  assert.ok(result.modelMessages.some((message) => JSON.stringify(message).includes('answer 1')));
  assert.deepEqual(result.modelMessages.slice(0, 3).map((message) => message.role), [
    'user', 'assistant', 'assistant',
  ]);
  assert.deepEqual(agent.messages, original);
  assert.equal(agent.messages[0], originalReferences[0]);
  assert.deepEqual(agent.getChatCompactionStore().readOverlay().sourceMessageIds, [
    'user-1', 'assistant-1',
  ]);
});

test('large seven-turn history compacts chronologically and rebuilds after a same-ID edit', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-large-history-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  const largeText = 'x'.repeat(30_000);
  const messages = Array.from({ length: 7 }, (_, index) => [
    user(`user-${index + 1}`, `question ${index + 1} ${largeText}`),
    assistant(`assistant-${index + 1}`, `answer ${index + 1} ${largeText}`),
  ]).flat();
  agent.messages = messages;
  const original = structuredClone(agent.messages);
  const fullModelMessages = await convertToModelMessages(agent.messages);
  const contextLength = 128_000;
  const targetTokens = chatCompactionBudgets(contextLength).targetTokens;
  const result = await agent.prepareChatPromptContext({
    modelMessages: fullModelMessages,
    contextLength,
    systemPrompt: 'base prompt',
  });
  const contextIndex = result.modelMessages.findIndex((message) => message.role === 'assistant'
    && JSON.stringify(message.content).includes('<chat_compaction_summary>'));
  assert.equal(contextIndex, 2);
  assert.deepEqual(result.modelMessages.slice(0, 2), fullModelMessages.slice(0, 2));
  assert.deepEqual(result.modelMessages.slice(3), fullModelMessages.slice(8));
  assert.ok(!result.modelMessages.some((message) => JSON.stringify(message) === JSON.stringify(fullModelMessages[2])));
  assert.ok(estimateChatTokens(result.modelMessages) < estimateChatTokens(fullModelMessages));
  assert.ok(estimateChatTokens(result.modelMessages) + estimateChatTokens(result.systemPrompt) <= targetTokens);
  assert.equal(result.systemPrompt, 'base prompt');
  assert.deepEqual(agent.messages, original);

  const firstOverlay = agent.getChatCompactionStore().readOverlay();
  assert.ok(firstOverlay);
  const firstFingerprint = firstOverlay.sourceFingerprint;
  agent.messages[1].parts[0].text = `edited historical answer with the same message id ${'e'.repeat(30_000)}`;
  const changedModelMessages = await convertToModelMessages(agent.messages);
  const changedResult = await agent.prepareChatPromptContext({
    modelMessages: changedModelMessages,
    contextLength,
    systemPrompt: 'base prompt',
  });
  const rebuiltOverlay = agent.getChatCompactionStore().readOverlay();
  assert.ok(rebuiltOverlay);
  assert.notEqual(rebuiltOverlay.sourceFingerprint, firstFingerprint);
  assert.equal(changedResult.systemPrompt, 'base prompt');
  assert.match(JSON.stringify(changedResult.modelMessages.slice(0, 2)), /edited historical answer/);
});

test('an existing overlay advances only when its effective prompt crosses the trigger watermark', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-effective-watermark-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  agent.messages = Array.from({ length: 5 }, (_, index) => turn(index + 1)).flat();
  const budgets = chatCompactionBudgets(128_000);
  const sourceOverlay = {
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-1',
  };
  const source = sourceMessagesForChatCompaction(agent.messages, sourceOverlay);
  const overlay = {
    version: 3,
    ...sourceOverlay,
    sourceMessageIds: ['user-1', 'assistant-1'],
    sourceFingerprint: await chatMessagesFingerprint(source),
    summary: 'prior summary',
    panelProvenance: [],
    modelContextLength: 128_000,
    triggerTokens: budgets.triggerTokens,
    targetTokens: budgets.targetTokens,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  agent.getChatCompactionStore().writeOverlay(overlay);
  const excessiveModelMessages = [{ role: 'user', content: 'z'.repeat(500_000) }];
  const before = await agent.prepareChatPromptContext({
    modelMessages: excessiveModelMessages,
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });
  assert.ok(estimateChatTokens(before.modelMessages) + estimateChatTokens(before.systemPrompt) < budgets.triggerTokens);
  assert.deepEqual(agent.getChatCompactionStore().readOverlay(), overlay);

  agent.messages[3].parts[0].text = `large retained result ${'r'.repeat(500_000)}`;
  const after = await agent.prepareChatPromptContext({
    modelMessages: excessiveModelMessages,
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });
  const advanced = agent.getChatCompactionStore().readOverlay();
  assert.equal(advanced.throughMessageId, 'assistant-2');
  assert.notEqual(advanced.sourceFingerprint, overlay.sourceFingerprint);
  assert.match(advanced.summary, /assistant\(assistant-2\)/);
  assert.ok(estimateChatTokens(after.modelMessages) + estimateChatTokens(after.systemPrompt) <= budgets.targetTokens);
});

test('reused overlays fit the hard budget when effective history is between target and trigger', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-hard-budget-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  const sourceText = 's'.repeat(40_000);
  const tailText = 't'.repeat(55_000);
  const messages = [
    ...turn(1),
    ...Array.from({ length: 4 }, (_, index) => [
      user(`user-${index + 2}`, `source ${index + 2} ${sourceText}`),
      assistant(`assistant-${index + 2}`, `source answer ${index + 2} ${sourceText}`),
    ]).flat(),
    ...Array.from({ length: 3 }, (_, index) => [
      user(`user-${index + 6}`, `tail ${index + 6} ${tailText}`),
      assistant(`assistant-${index + 6}`, `tail answer ${index + 6} ${tailText}`),
    ]).flat(),
  ];
  agent.messages = messages;

  const contextLength = 128_000;
  const budgets = chatCompactionBudgets(contextLength);
  assert.ok(budgets);
  const sourceOverlay = {
    anchorMessageId: 'user-1',
    anchorThroughMessageId: 'assistant-1',
    throughMessageId: 'assistant-5',
  };
  const sourceMessages = sourceMessagesForChatCompaction(messages, sourceOverlay);
  assert.ok(sourceMessages);
  const overlay = {
    version: 3,
    ...sourceOverlay,
    sourceMessageIds: sourceMessages.map((message) => message.id),
    sourceFingerprint: await chatMessagesFingerprint(sourceMessages),
    summary: 'prior summary',
    panelProvenance: [],
    modelContextLength: contextLength,
    triggerTokens: budgets.triggerTokens,
    targetTokens: budgets.targetTokens,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  agent.getChatCompactionStore().writeOverlay(overlay);

  const fullModelMessages = await convertToModelMessages(messages);
  const systemPrompt = 'base prompt';
  const canonicalEstimate = estimateChatTokens(fullModelMessages) + estimateChatTokens(systemPrompt);
  assert.ok(canonicalEstimate > budgets.triggerTokens);

  const result = await agent.prepareChatPromptContext({
    modelMessages: fullModelMessages,
    contextLength,
    systemPrompt,
  });
  const effectiveEstimate = estimateChatTokens(result.modelMessages) + estimateChatTokens(result.systemPrompt);
  assert.ok(effectiveEstimate > budgets.targetTokens);
  assert.ok(effectiveEstimate <= budgets.hardTokens);
  assert.notDeepEqual(result.modelMessages, fullModelMessages);
  assert.match(JSON.stringify(result.modelMessages), /<chat_compaction_summary>/);
  assert.deepEqual(agent.getChatCompactionStore().readOverlay(), overlay);
});

test('history between target and trigger watermarks does not compact', async () => {
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const storage = makeSqlStorage();
  const agent = new WorkspaceAgent({
    storage,
    id: { toString: () => 'chat-compaction-hysteresis-test' },
    blockConcurrencyWhile: async (operation) => operation(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  }, {});
  const mediumText = 'm'.repeat(25_000);
  agent.messages = Array.from({ length: 7 }, (_, index) => [
    user(`medium-user-${index + 1}`, mediumText),
    assistant(`medium-assistant-${index + 1}`, mediumText),
  ]).flat();
  const fullModelMessages = await convertToModelMessages(agent.messages);
  const budgets = chatCompactionBudgets(128_000);
  const estimated = estimateChatTokens(fullModelMessages) + estimateChatTokens('base prompt');
  assert.ok(estimated > budgets.targetTokens);
  assert.ok(estimated <= budgets.triggerTokens);
  const result = await agent.prepareChatPromptContext({
    modelMessages: fullModelMessages,
    contextLength: 128_000,
    systemPrompt: 'base prompt',
  });
  assert.deepEqual(result.modelMessages, fullModelMessages);
  assert.equal(result.systemPrompt, 'base prompt');
  assert.equal(agent.getChatCompactionStore().readOverlay(), null);
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
