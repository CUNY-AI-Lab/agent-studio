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

test('WorkspaceAgent rejects every generic client state replacement', async () => {
  const { registerCloudflareStub } = await import('./helpers/env.mjs');
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    name: AGENT_NAME,
    env: { CAIL_REQUIRE_IDENTITY: 'true' },
    cailSubject: 'cail-subject',
    assertAuthorizedRpc: WorkspaceAgent.prototype.assertAuthorizedRpc,
  };

  assert.throws(
    () => WorkspaceAgent.prototype.validateStateChange.call(agent, {
      sessionId: SESSION_ID,
      workspace: { id: WORKSPACE_ID },
      panels: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    }, 'client'),
    /client state replacement is disabled/,
  );
});
