import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

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
    finalizeObservabilityRequest() {},
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
  assert.equal(payload.error, 'authentication_required');
  assert.equal(payload.login_url, '/login');
});
