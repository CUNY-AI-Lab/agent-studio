import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';
import { makeAgentContext, makeSqlAgentStorage } from './helpers/agent-storage.mjs';

registerCloudflareStub();
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

function createLegacyTable(storage, messages) {
  storage.database.exec(`
    CREATE TABLE cf_ai_chat_agent_messages (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  const insert = storage.database.prepare(
    'INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)',
  );
  messages.forEach((message, index) => {
    insert.run(message.rowId ?? message.body.id ?? `legacy-${index}`, JSON.stringify(message.body), index);
  });
}

function legacyTableExists(storage) {
  return storage.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'",
  ).all().length > 0;
}

function makeAgent(storage) {
  return new WorkspaceAgent(makeAgentContext(storage), {});
}

test('fresh legacy lift preserves supported V4 messages and removes the old table', async () => {
  const storage = makeSqlAgentStorage();
  createLegacyTable(storage, [
    { body: { id: 'legacy-user', role: 'user', content: 'old content field' } },
    {
      body: {
        id: 'legacy-assistant',
        role: 'assistant',
        content: 'tool complete',
        toolInvocations: [{
          toolCallId: 'call-1',
          toolName: 'lookup',
          args: { query: 'saved' },
          result: { found: true },
          state: 'result',
        }],
      },
    },
  ]);

  const agent = makeAgent(storage);
  await agent.__unsafe_ensureInitialized();

  assert.equal(legacyTableExists(storage), false);
  const history = await agent.sessions.session().getHistory();
  assert.deepEqual(history.map((message) => message.id), ['legacy-user', 'legacy-assistant']);
  assert.deepEqual(history[0].parts, [{ type: 'text', text: 'old content field' }]);
  assert.ok(history[1].parts.some((part) => (
    part.type === 'tool-lookup'
    && part.toolCallId === 'call-1'
    && part.state === 'output-available'
  )));
});

test('a partial middle-row lift fails closed and the next wake rebuilds the full chain', async (t) => {
  t.mock.method(console, 'error', () => {});
  const storage = makeSqlAgentStorage();
  createLegacyTable(storage, ['A', 'B', 'C'].map((id, index) => ({
    body: {
      id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: id }],
    },
  })));

  const first = makeAgent(storage);
  const firstSession = first.sessions.session();
  const sessionPrototype = Object.getPrototypeOf(firstSession);
  const importMessage = sessionPrototype.importMessage;
  let injected = false;
  t.mock.method(sessionPrototype, 'importMessage', async function importWithOneFailure(message, options) {
    if (message.id === 'B' && !injected) {
      injected = true;
      throw new Error('injected middle-row failure');
    }
    return importMessage.call(this, message, options);
  });

  await assert.rejects(
    first.__unsafe_ensureInitialized(),
    /Legacy chat migration did not complete/,
  );
  assert.equal(legacyTableExists(storage), true);
  assert.deepEqual(
    storage.database.prepare(`
      SELECT id, parent_id FROM cf_agents_session_messages
      ORDER BY seq ASC
    `).all().map((row) => ({ ...row })),
    [
      { id: 'A', parent_id: null },
      { id: 'C', parent_id: 'A' },
    ],
    'the fixture must reproduce the SDK partial-chain failure before recovery',
  );

  const second = makeAgent(storage);
  await second.__unsafe_ensureInitialized();

  assert.equal(legacyTableExists(storage), false);
  assert.deepEqual(
    (await second.sessions.session().getHistory()).map((message) => message.id),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    storage.database.prepare(`
      SELECT id, parent_id FROM cf_agents_session_messages
      ORDER BY seq ASC
    `).all().map((row) => ({ ...row })),
    [
      { id: 'A', parent_id: null },
      { id: 'B', parent_id: 'A' },
      { id: 'C', parent_id: 'B' },
    ],
  );
});

test('orphan recovery waits for a partial legacy lift, then preserves the full chain', async (t) => {
  t.mock.method(console, 'error', () => {});
  const storage = makeSqlAgentStorage();
  const seed = makeAgent(storage);
  await seed.__unsafe_ensureInitialized();

  createLegacyTable(storage, ['A', 'B', 'C'].map((id, index) => ({
    body: {
      id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: id }],
    },
  })));

  const requestId = 'orphan-request';
  const partialId = 'partial-assistant';
  const streamId = seed._resumableStream.start(requestId, { messageId: partialId });
  for (const chunk of [
    { type: 'start', messageId: partialId },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'saved partial' },
  ]) {
    seed._resumableStream.storeChunk(streamId, JSON.stringify(chunk));
  }
  seed._resumableStream.flushBuffer();
  storage.database.prepare(`
    INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'orphan-fiber',
    `__cf_internal_chat_turn:${requestId}`,
    null,
    Date.now(),
  );
  storage.database.exec(`
    CREATE TRIGGER fail_middle
    BEFORE INSERT ON cf_agents_session_messages
    WHEN NEW.id = 'B'
    BEGIN
      SELECT RAISE(ABORT, 'injected middle-row failure');
    END
  `);

  const failedWake = makeAgent(storage);
  await assert.rejects(
    failedWake.__unsafe_ensureInitialized(),
    /Legacy chat migration did not complete/,
  );

  assert.equal(legacyTableExists(storage), true);
  assert.deepEqual(
    storage.database.prepare(`
      SELECT id FROM cf_agents_session_messages
      ORDER BY seq ASC
    `).all().map((row) => row.id),
    ['A', 'C'],
    'orphan recovery must not persist into the partial Sessions chain',
  );
  assert.equal(
    storage.database.prepare('SELECT COUNT(*) AS count FROM cf_agents_runs').get().count,
    1,
    'the interrupted run must remain available for a later roll-forward wake',
  );
  assert.equal(failedWake._resumableStream.hasActiveStream(), true);

  storage.database.exec('DROP TRIGGER fail_middle');
  const recoveredWake = makeAgent(storage);
  await recoveredWake.__unsafe_ensureInitialized();

  assert.equal(legacyTableExists(storage), false);
  assert.deepEqual(
    (await recoveredWake.sessions.session().getHistory()).map((message) => message.id),
    ['A', 'B', 'C', partialId],
  );
  assert.equal(
    storage.database.prepare('SELECT COUNT(*) AS count FROM cf_agents_runs').get().count,
    0,
  );
  assert.equal(recoveredWake._resumableStream.hasActiveStream(), false);
});

test('an empty legacy table from an old-SDK compatibility wake does not clear Sessions history', async () => {
  const storage = makeSqlAgentStorage();
  const first = makeAgent(storage);
  await first.__unsafe_ensureInitialized();
  const session = first.sessions.session();
  await session.importMessage({
    id: 'new-user',
    role: 'user',
    parts: [{ type: 'text', text: 'new history' }],
  }, { parentId: null, createdAt: 0 });
  await session.importMessage({
    id: 'new-assistant',
    role: 'assistant',
    parts: [{ type: 'text', text: 'still here' }],
  }, { parentId: 'new-user', createdAt: 1 });

  createLegacyTable(storage, []);
  const rolledForward = makeAgent(storage);
  await rolledForward.__unsafe_ensureInitialized();

  assert.equal(legacyTableExists(storage), false);
  assert.deepEqual(
    (await rolledForward.sessions.session().getHistory()).map((message) => message.id),
    ['new-user', 'new-assistant'],
  );
});

test('mixed legacy writes and newer Sessions history fail closed without clearing either store', async () => {
  const storage = makeSqlAgentStorage();
  const first = makeAgent(storage);
  await first.__unsafe_ensureInitialized();
  await first.sessions.session().importMessage({
    id: 'new-only',
    role: 'user',
    parts: [{ type: 'text', text: 'must survive' }],
  }, { parentId: null, createdAt: 0 });
  createLegacyTable(storage, [{
    body: {
      id: 'old-only',
      role: 'user',
      parts: [{ type: 'text', text: 'unsafe rollback write' }],
    },
  }]);

  const mixed = makeAgent(storage);
  await assert.rejects(
    mixed.__unsafe_ensureInitialized(),
    /newer Sessions history; refusing automatic rebuild/,
  );

  assert.equal(legacyTableExists(storage), true);
  assert.deepEqual(
    storage.database.prepare(`
      SELECT id FROM cf_agents_session_messages
      ORDER BY seq ASC
    `).all().map((row) => row.id),
    ['new-only'],
  );
});

test('invalid legacy JSON is rejected before the SDK lift without logging payload data', async (t) => {
  const errors = [];
  const warnings = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const storage = makeSqlAgentStorage();
  storage.database.exec(`
    CREATE TABLE cf_ai_chat_agent_messages (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  storage.database.prepare(
    'INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)',
  ).run('private-row-id', '{"secret":"not closed"', 0);

  const agent = makeAgent(storage);
  await assert.rejects(
    agent.__unsafe_ensureInitialized(),
    /^Error: Legacy chat migration validation failed at row 1\.$/,
  );

  assert.equal(legacyTableExists(storage), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(
    storage.database.prepare('SELECT COUNT(*) AS count FROM cf_agents_session_messages').get().count,
    0,
  );
});
