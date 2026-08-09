import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const {
  CAIL_CANONICAL_ISSUER,
  CAIL_GATEWAY_AUDIENCE,
  sessionIdForSubject,
} = await import('../src/lib/cail-identity.ts');
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

function identityEnv(issuer) {
  return {
    CAIL_IDENTITY_JWKS: issuer.jwksJson,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  };
}

function mintGateway(issuer, overrides = {}) {
  return issuer.mintIdentityJwt({
    audience: CAIL_GATEWAY_AUDIENCE,
    email: 'someone@gc.cuny.edu',
    name: 'Some One',
    entitlements: ['tools', 'agent-studio'],
    now: Math.floor(Date.now() / 1000),
    ...overrides,
  });
}

function makeStorage(seed = []) {
  const values = new Map(seed);
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      writes.push(['put', key, value]);
      values.set(key, value);
    },
    async delete(key) {
      writes.push(['delete', key]);
      values.delete(key);
    },
    sql: {
      exec() {
        return {
          toArray: () => [],
          [Symbol.iterator]: function* iterator() {},
        };
      },
    },
  };
}

async function makeRealWorkspaceAgent(sessionId, env, storage) {
  const agent = new WorkspaceAgent(
    {
      storage,
      id: { toString: () => 'workspace-agent-credential-test' },
      blockConcurrencyWhile: async (operation) => operation(),
      getWebSockets: () => [],
      acceptWebSocket: () => {},
      waitUntil: () => {},
    },
    env,
  );
  await agent.setName(`${sessionId}-workspace-1`);
  return agent;
}

test('constructed WorkspaceAgent credential boundary installs a same-subject gateway leg and persists it', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-gateway-key' });
  const env = identityEnv(issuer);
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const storage = makeStorage();
  const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
  const writesBeforeCredential = storage.writes.length;
  const token = await mintGateway(issuer);

  await agent.setCailCredential(token);

  assert.equal(agent.cailIdentityJwt, token);
  assert.equal(agent.cailSubject, TEST_SUBJECTS.alice);
  assert.deepEqual(storage.values.get('cail:identity-jwt'), token);
  assert.deepEqual(storage.values.get('cail:subject'), TEST_SUBJECTS.alice);
  assert.equal(storage.values.has('cail:operational-subject'), false);
  assert.deepEqual(storage.writes.slice(writesBeforeCredential).map(([kind, key]) => [kind, key]), [
    ['put', 'cail:identity-jwt'],
    ['put', 'cail:subject'],
  ]);
});

test('real WorkspaceAgent rejects app-audience, wrong-subject, expired, and malformed credentials without mutation', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-adverse-key' });
  const env = identityEnv(issuer);
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const cases = [
    ['app audience', await issuer.mintIdentityJwt({
      audience: 'cail:agent-studio',
      email: 'someone@gc.cuny.edu',
      now: Math.floor(Date.now() / 1000),
    })],
    ['wrong subject', await mintGateway(issuer, { subject: TEST_SUBJECTS.carol })],
    ['expired', await mintGateway(issuer, {
      now: Math.floor(Date.now() / 1000) - 3720,
      expiresInSeconds: 3600,
    })],
    ['malformed', 'not-a-jwt'],
  ];

  for (const [label, token] of cases) {
    const storage = makeStorage();
    const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
    const writesBeforeCredential = storage.writes.length;
    await assert.rejects(
      agent.setCailCredential(token),
      /rejected unverified or non-matching identity JWT/,
      label,
    );
    assert.equal(agent.cailIdentityJwt, null, label);
    assert.equal(agent.cailSubject, null, label);
    assert.deepEqual(storage.writes.slice(writesBeforeCredential), [], label);
  }
});

test('real WorkspaceAgent treats missing or malformed verifier configuration as a rejection and does not persist', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-config-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const token = await mintGateway(issuer);

  for (const env of [
    {},
    { CAIL_IDENTITY_JWKS: '{not-json', CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER },
  ]) {
    const storage = makeStorage();
    const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
    const writesBeforeCredential = storage.writes.length;
    await assert.rejects(
      agent.setCailCredential(token),
      /identity verification config could not be loaded/,
    );
    assert.equal(agent.cailIdentityJwt, null);
    assert.equal(agent.cailSubject, null);
    assert.deepEqual(storage.writes.slice(writesBeforeCredential), []);
  }
});

test('WorkspaceAgent does not revive persisted app-audience or cross-session credentials', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-legacy-key' });
  const env = identityEnv(issuer);
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const legacyAppToken = await issuer.mintIdentityJwt({
    audience: 'cail:agent-studio',
    email: 'someone@gc.cuny.edu',
  });
  const foreignGatewayToken = await mintGateway(issuer, { subject: TEST_SUBJECTS.carol });

  for (const token of [legacyAppToken, foreignGatewayToken]) {
    const storage = makeStorage([
      ['cail:identity-jwt', token],
      ['cail:subject', TEST_SUBJECTS.alice],
    ]);
    const resumed = await makeRealWorkspaceAgent(sessionId, env, storage);

    assert.equal(resumed.cailIdentityJwt, null);
    assert.equal(resumed.cailSubject, null);
    assert.equal(storage.values.has('cail:identity-jwt'), false);
    assert.equal(storage.values.has('cail:subject'), false);
  }
});

test('WorkspaceAgent credential survives the onStart storage hydration path', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-hydration-key' });
  const env = identityEnv(issuer);
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const token = await mintGateway(issuer);
  const firstStorage = makeStorage();
  const firstAgent = await makeRealWorkspaceAgent(sessionId, env, firstStorage);

  await firstAgent.setCailCredential(token);

  const resumed = await makeRealWorkspaceAgent(sessionId, env, firstStorage);
  assert.equal(resumed.cailIdentityJwt, token);
  assert.equal(resumed.cailSubject, TEST_SUBJECTS.alice);
});

test('server credential RPC reaches a constructed WorkspaceAgent chat/model boundary with the verified gateway leg', async (t) => {
  t.mock.method(console, 'error', () => {});
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-chat-boundary-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const env = {
    ...identityEnv(issuer),
    CAIL_API_BASE: 'https://cail.test',
    CAIL_CANONICAL_ORIGIN: 'https://studio.test',
    CAIL_REQUIRE_IDENTITY: 'true',
    SESSION_SECRET: 'workspace-chat-boundary-secret',
  };
  const storage = makeStorage();
  const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
  const gatewayToken = await mintGateway(issuer);
  const wire = [];
  env.GATEWAY = {
    async fetch(_input, init) {
      const headers = new Headers(init?.headers);
      wire.push({
        method: init?.method,
        authorization: headers.get('authorization'),
        identityJwt: headers.get('X-CAIL-Identity-JWT'),
        app: headers.get('X-CAIL-App'),
        credentials: init?.credentials,
        redirect: init?.redirect,
      });
      return Response.json({
        error: {
          message: 'Gateway test boundary reached.',
          type: 'authentication_error',
          param: null,
          code: 'authentication_required',
          cail: { retryable: false },
        },
      }, { status: 401, headers: { 'x-should-retry': 'false' } });
    },
  };

  // This is the same internal server→DO RPC used by server.ts after its HTTP
  // keyring middleware has verified the optional gateway leg. Accept an
  // authenticated first-party WebSocket handshake on the same constructed DO,
  // then call its real chat method (not a route-level agent double).
  await agent.setCailCredential(gatewayToken);
  const { mintCsrfToken } = await import('../src/lib/csrf.ts');
  const csrfToken = await mintCsrfToken(sessionId, env.SESSION_SECRET, 'subject');
  const closeCalls = [];
  await agent.onConnect(
    {
      id: 'connection-1',
      state: null,
      setState: () => {},
      send: () => {},
      close: (...args) => closeCalls.push(args),
    },
    {
      request: new Request(
        `https://studio.test/agents/workspace-agent/${sessionId}-workspace-1?csrfToken=${csrfToken}`,
        { headers: { 'Sec-Fetch-Site': 'same-origin' } },
      ),
    },
  );
  assert.deepEqual(closeCalls, []);

  const { tool } = await import('ai');
  const { z } = await import('zod');
  const noopTool = tool({
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  // Keep tool construction local to this composed test; the model, credential
  // adapter, and WorkspaceAgent method remain real.
  agent.requireWorkspace = () => ({
    id: 'workspace-1',
    name: 'Boundary test workspace',
    description: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    model: '@cf/zai-org/glm-5.2',
  });
  agent.requireSessionId = () => sessionId;
  agent.messages = [{
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  }];
  agent.buildHostTools = () => ({});
  agent.createCodeModeTool = () => noopTool;
  agent.buildModelTools = () => ({});

  const response = await agent.onChatMessage(undefined, { requestId: 'request-1' });
  const responseBody = await response.text();

  assert.equal(
    wire.length,
    1,
    `the real chat method should make exactly one gateway request; response=${JSON.stringify(responseBody)}`,
  );
  assert.deepEqual(wire[0], {
    method: 'POST',
    authorization: `Bearer ${gatewayToken}`,
    identityJwt: null,
    app: 'agent-studio',
    credentials: 'omit',
    redirect: 'error',
  });
});

test('warm WorkspaceAgent re-verifies an expired Gateway leg before chat and purges it', async (t) => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-warm-expiry-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const installNowMs = Math.floor(Date.now() / 1000) * 1000;
  let currentNowMs = installNowMs;
  t.mock.method(Date, 'now', () => currentNowMs);

  const env = identityEnv(issuer);
  const storage = makeStorage();
  const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
  const token = await mintGateway(issuer, {
    now: Math.floor(installNowMs / 1000),
    expiresInSeconds: 1,
  });
  await agent.setCailCredential(token);
  assert.equal(agent.cailIdentityJwt, token);

  // Move beyond the shared verifier's 60-second clock tolerance while the DO
  // remains warm; no hibernation or reconstructed instance is involved.
  currentNowMs = installNowMs + 62_000;

  agent.requireWorkspace = () => ({ id: 'workspace-1' });
  agent.requireSessionId = () => sessionId;

  const response = await agent.onChatMessage(undefined, { requestId: 'warm-expired' });
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);

  assert.equal(event.type, 'error');
  assert.equal(payload.error.code, 'authentication_required');
  assert.equal(agent.cailIdentityJwt, null);
  assert.equal(agent.cailSubject, null);
  assert.equal(storage.values.has('cail:identity-jwt'), false);
  assert.equal(storage.values.has('cail:subject'), false);
});

test('warm WorkspaceAgent fails closed on verifier configuration loss without purging recovery state', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-warm-config-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const env = identityEnv(issuer);
  const storage = makeStorage();
  const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
  const token = await mintGateway(issuer);
  await agent.setCailCredential(token);

  // Simulate operator configuration drift after installation. The current
  // token and its derived fields must remain available for recovery once the
  // verifier configuration is repaired, but chat must not call the gateway.
  env.CAIL_IDENTITY_JWKS = '{not-json';
  agent.requireWorkspace = () => ({ id: 'workspace-1' });
  agent.requireSessionId = () => sessionId;

  const response = await agent.onChatMessage(undefined, { requestId: 'warm-config-error' });
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);

  assert.equal(event.type, 'error');
  assert.equal(payload.error.code, 'authentication_required');
  assert.equal(agent.cailIdentityJwt, token);
  assert.equal(storage.values.get('cail:identity-jwt'), token);
  assert.equal(storage.values.get('cail:subject'), TEST_SUBJECTS.alice);
});

test('constructed WorkspaceAgent denies the actual chat boundary when the optional gateway leg is absent', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-chat-missing-gateway-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const env = identityEnv(issuer);
  const agent = await makeRealWorkspaceAgent(sessionId, env, makeStorage());
  agent.requireWorkspace = () => ({ id: 'workspace-1' });
  agent.requireSessionId = () => sessionId;

  const response = await agent.onChatMessage(undefined, { requestId: 'missing-gateway' });
  const body = await response.text();
  const event = JSON.parse(body.split('\n')[0].slice('data: '.length));
  const payload = JSON.parse(event.errorText);

  assert.equal(event.type, 'error');
  assert.equal(payload.error.code, 'authentication_required');
});
