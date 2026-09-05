import { test } from 'node:test';
import assert from 'node:assert/strict';

const SESSION_ID = 'a'.repeat(32);
const WORKSPACE_ID = 'b'.repeat(32);
const AGENT_NAME = `${SESSION_ID}-${WORKSPACE_ID}`;

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

test('WorkspaceAgent accepts server state changes before credentials are installed', async () => {
  const { registerCloudflareStub } = await import('./helpers/env.mjs');
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const agent = {
    env: { CAIL_REQUIRE_IDENTITY: 'true' },
    cailSubject: null,
    assertAuthorizedRpc: WorkspaceAgent.prototype.assertAuthorizedRpc,
  };

  assert.doesNotThrow(() => WorkspaceAgent.prototype.validateStateChange.call(agent, {
    sessionId: SESSION_ID,
    workspace: { id: WORKSPACE_ID },
    panels: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [],
  }, 'server'));
});
