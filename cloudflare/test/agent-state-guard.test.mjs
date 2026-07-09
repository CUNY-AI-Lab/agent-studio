import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertClientStateIdentity,
  parseAgentName,
} from '../src/lib/agent-state-guard.ts';

const SESSION_ID = 'a'.repeat(32);
const WORKSPACE_ID = 'b'.repeat(32);
const AGENT_NAME = `${SESSION_ID}-${WORKSPACE_ID}`;

test('parseAgentName parses canonical names and rejects bad shapes', () => {
  assert.deepEqual(parseAgentName(AGENT_NAME), {
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(parseAgentName(`${SESSION_ID}-${WORKSPACE_ID}-extra`), null);
  assert.equal(parseAgentName(`${SESSION_ID.toUpperCase()}-${WORKSPACE_ID}`), null);
  assert.equal(parseAgentName('not-an-agent-name'), null);
});

test('assertClientStateIdentity accepts matching and absent identities', () => {
  assert.doesNotThrow(() => assertClientStateIdentity(AGENT_NAME, {
    sessionId: SESSION_ID,
    workspace: { id: WORKSPACE_ID },
  }));
  assert.doesNotThrow(() => assertClientStateIdentity(AGENT_NAME, {
    sessionId: null,
    workspace: null,
  }));
  assert.doesNotThrow(() => assertClientStateIdentity(AGENT_NAME, {}));
});

test('assertClientStateIdentity rejects a foreign session id', () => {
  assert.throws(
    () => assertClientStateIdentity(AGENT_NAME, { sessionId: 'c'.repeat(32) }),
    /client state cannot change sessionId/,
  );
});

test('assertClientStateIdentity rejects a foreign workspace id', () => {
  assert.throws(
    () => assertClientStateIdentity(AGENT_NAME, { workspace: { id: 'd'.repeat(32) } }),
    /client state cannot change workspace\.id/,
  );
});

test('assertClientStateIdentity rejects identities when the agent name is unparseable', () => {
  assert.throws(
    () => assertClientStateIdentity('bad-name', { sessionId: SESSION_ID }),
    /client state cannot set sessionId \(unresolvable agent name\)/,
  );
});
