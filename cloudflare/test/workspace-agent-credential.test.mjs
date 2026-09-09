import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createTestIdentityIssuer, TEST_SUBJECTS } from './helpers/identity.mjs';

import { registerCloudflareStub, importServer, makeEnv, Session } from './helpers/env.mjs';
import { loadIdentityVerifierConfig, verifyIdentityJwt } from '@cuny-ai-lab/cail-identity';

registerCloudflareStub();

const {
  CAIL_CANONICAL_ISSUER,
  CAIL_GATEWAY_AUDIENCE,
  sessionIdForSubject,
} = await import('../src/lib/cail-identity.ts');
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

test('a long tool step refreshes through the authenticated route before its next model request', async (t) => {
  t.mock.method(console, 'info', () => {});
  const start = 1_800_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: start * 1000 });
  const issuer = await createTestIdentityIssuer();
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const { env, agents } = makeEnv();
  Object.assign(env, identityEnv(issuer), {
    CAIL_REQUIRE_IDENTITY: 'true', CAIL_API_BASE: 'https://cail.test',
    CAIL_CANONICAL_ORIGIN: 'https://studio.test', CAIL_BASE_PATH: '/agent-studio',
    GATEWAY: { fetch: async () => new Response(null, { status: 500 }) },
  });
  const app = await importServer();
  const session = new Session(env);
  const headersForNow = async () => ({
    'content-type': 'application/json',
    'X-CAIL-Identity-JWT': await issuer.mintIdentityJwt({ audience: 'cail:agent-studio', expiresInSeconds: 300 }),
    'X-CAIL-Gateway-Identity-JWT': await mintGateway(issuer, { expiresInSeconds: 300 }),
  });
  const headers = await headersForNow();
  assert.equal((await session.request(app, '/api/session', { headers })).status, 200);
  const created = await session.request(app, '/api/workspaces', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Long turn workspace' }),
  });
  assert.equal(created.status, 201);
  const { workspace } = await created.json();
  const agent = await makeRealWorkspaceAgent(sessionId, env, makeStorage());
  agents.set(`${sessionId}-${workspace.id}`, agent);
  await agent.setCailCredential(headers['X-CAIL-Gateway-Identity-JWT']);
  agent.requireWorkspace = () => workspace;
  agent.requireSessionId = () => sessionId;
  agent.messages = [{ id: 'user-message', role: 'user', parts: [{ type: 'text', text: 'Continue the saved work.' }] }];
  const originalMessages = structuredClone(agent.messages);
  const { DEFAULT_CAIL_MODEL } = await import('../src/lib/cail-model.ts');
  agent.functionCallingModelId = DEFAULT_CAIL_MODEL;
  const { tool } = await import('ai');
  const lookup = tool({ inputSchema: z.object({}), execute: async () => {
    t.mock.timers.setTime((start + 373) * 1000);
    return 'saved work';
  } });
  agent.buildHostTools = () => ({});
  agent.buildModelTools = () => ({ lookup });
  agent.createCodeModeTool = () => lookup;
  const requests = [];
  env.GATEWAY = { async fetch(input, init) {
    const jwt = new Headers(init.headers).get('authorization').slice('Bearer '.length);
    const config = await loadIdentityVerifierConfig({
      jwks: issuer.jwksJson, issuer: CAIL_CANONICAL_ISSUER, expectedAudience: CAIL_GATEWAY_AUDIENCE,
      now: Math.floor(Date.now() / 1000),
    });
    assert.equal(config.ok, true);
    // The shared Gateway verifier is real; provider output and Registry access
    // are substituted. This is an in-process HTTP/DO/SDK integration test.
    assert.ok(await verifyIdentityJwt(jwt, config.config), 'each inference must have a currently valid credential');
    requests.push({ jwt, body: JSON.parse(init.body) });
    const choices = requests.length === 1
      ? [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }]
      : [{ index: 0, delta: { content: 'Continued successfully.' }, finish_reason: null }];
    return new Response(`data: ${JSON.stringify({ id: 'synthetic', choices })}\n\n`
      + `data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } };
  const response = await agent.onChatMessage(undefined, { requestId: 'long-turn' });
  const events = [];
  let buffer = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      if (event.type !== 'data-credential-refresh') continue;
      assert.equal(event.transient, true);
      const freshHeaders = await headersForNow();
      const unrelated = await session.request(app, `/api/workspaces/${workspace.id}/model-credential`, {
        method: 'POST', headers: freshHeaders, body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      assert.equal(unrelated.status, 409);
      const refreshed = await session.request(app, `/api/workspaces/${workspace.id}/model-credential`, {
        method: 'POST', headers: freshHeaders, body: JSON.stringify(event.data),
      });
      assert.equal(refreshed.status, 204);
    }
  }
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].jwt, requests[1].jwt);
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.ok(events.some((event) => event.type === 'text-delta' && event.delta === 'Continued successfully.'));
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.deepEqual(agent.messages, originalMessages);
});

test('credential refresh cancellation and a missing browser acknowledgment release the pending step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const issuer = await createTestIdentityIssuer();
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const agent = await makeRealWorkspaceAgent(sessionId, identityEnv(issuer), makeStorage());
  const token = await mintGateway(issuer);
  await agent.setCailCredential(token);
  const requests = [];
  const writer = { write: (part) => requests.push(part) };
  const abort = new AbortController();
  const cancelled = agent.requestModelCredential(writer, abort.signal);
  const cancellation = assert.rejects(cancelled, /cancelled/);
  abort.abort(new Error('Chat cancelled.'));
  await cancellation;
  assert.equal(agent.pendingCredentialRefresh, null);

  const pending = agent.requestModelCredential(writer);
  const expiry = assert.rejects(pending, /did not refresh/);
  // A late HTTP completion from the cancelled request cannot resolve or
  // overwrite the new request's credential.
  assert.equal(await agent.completeModelCredentialRefresh(requests[0].data.requestId, token), false);
  assert.equal(agent.pendingCredentialRefresh.requestId, requests[1].data.requestId);
  t.mock.timers.tick(15_000);
  await expiry;
  assert.equal(agent.pendingCredentialRefresh, null);
  assert.equal(await agent.completeModelCredentialRefresh(requests[1].data.requestId, token), false);
  assert.equal(agent.cailIdentityJwt, token);
});

test('the first verified browser refresh wins, including an unchanged token, without accepting another subject', async () => {
  const issuer = await createTestIdentityIssuer();
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const agent = await makeRealWorkspaceAgent(sessionId, identityEnv(issuer), makeStorage());
  const token = await mintGateway(issuer);
  await agent.setCailCredential(token);
  let requestId;
  const pending = agent.requestModelCredential({ write: (part) => { requestId = part.data.requestId; } });
  const wrongSubject = await mintGateway(issuer, { subject: TEST_SUBJECTS.carol });
  await assert.rejects(agent.completeModelCredentialRefresh(requestId, wrongSubject), /rejected/);
  assert.equal(agent.cailIdentityJwt, token);
  assert.equal(agent.pendingCredentialRefresh.requestId, requestId);
  assert.equal(await agent.completeModelCredentialRefresh(requestId, token), true);
  assert.equal(await pending, token);
  assert.equal(await agent.completeModelCredentialRefresh(requestId, token), false);
  assert.equal(agent.pendingCredentialRefresh, null);
});

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

test('constructed WorkspaceAgent credential boundary persists only the verified gateway leg', async () => {
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
  assert.equal(storage.values.has('cail:subject'), false);
  assert.equal(storage.values.has('cail:operational-subject'), false);
  assert.deepEqual(storage.writes.slice(writesBeforeCredential).map(([kind, key]) => [kind, key]), [
    ['put', 'cail:identity-jwt'],
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
    const storage = makeStorage([['cail:identity-jwt', token]]);
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
  assert.equal(firstStorage.values.has('cail:subject'), false);
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
    async fetch(input, init) {
      if (String(input) === 'https://cail.test/v1/models') {
        return Response.json({
          object: 'list',
          data: [{ id: '@cf/zai-org/glm-5.2', capabilities: ['text-generation', 'function-calling'] }],
        });
      }
      const headers = new Headers(init?.headers);
      const requestBody = z.object({ model: z.string() }).parse(
        await new Request(input, init).json(),
      );
      wire.push({
        method: init?.method,
        authorization: headers.get('authorization'),
        identityJwt: headers.get('X-CAIL-Identity-JWT'),
        app: headers.get('X-CAIL-App'),
        credentials: init?.credentials,
        redirect: init?.redirect,
        model: requestBody.model,
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
    redirect: 'manual',
    model: '@cf/zai-org/glm-5.2',
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

test('warm WorkspaceAgent refreshes a newly primed leg after expiry without forwarding the stale token', async (t) => {
  t.mock.method(console, 'error', () => {});
  const issuer = await createTestIdentityIssuer({ kid: 'workspace-refresh-chat-key' });
  const sessionId = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const installNowMs = Math.floor(Date.now() / 1000) * 1000;
  let currentNowMs = installNowMs;
  t.mock.method(Date, 'now', () => currentNowMs);

  const wire = [];
  const env = {
    ...identityEnv(issuer),
    CAIL_API_BASE: 'https://cail.test',
    CAIL_REQUIRE_IDENTITY: 'true',
    SESSION_SECRET: 'workspace-refresh-chat-secret',
    GATEWAY: {
      async fetch(input, init) {
        if (String(input) === 'https://cail.test/v1/models') {
          return Response.json({
            object: 'list',
            data: [{ id: '@cf/zai-org/glm-5.2', capabilities: ['text-generation', 'function-calling'] }],
          });
        }
        const headers = new Headers(init?.headers);
        wire.push({
          authorization: headers.get('authorization'),
          app: headers.get('X-CAIL-App'),
        });
        return new Response(
          'data: {"id":"chatcmpl-refresh","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"chatcmpl-refresh","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
  };
  const storage = makeStorage();
  const agent = await makeRealWorkspaceAgent(sessionId, env, storage);
  const staleToken = await mintGateway(issuer, {
    now: Math.floor(installNowMs / 1000),
    expiresInSeconds: 1,
  });
  await agent.setCailCredential(staleToken);
  currentNowMs = installNowMs + 62_000;

  agent.requireWorkspace = () => ({
    id: 'workspace-1',
    model: '@cf/zai-org/glm-5.2',
  });
  agent.requireSessionId = () => sessionId;
  agent.messages = [{
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  }];
  const { tool } = await import('ai');
  const noopTool = tool({
    description: 'noop',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  agent.buildHostTools = () => ({});
  agent.createCodeModeTool = () => noopTool;
  agent.buildModelTools = () => ({});

  const staleResponse = await agent.onChatMessage(undefined, { requestId: 'stale-refresh' });
  const staleBody = await staleResponse.text();
  const staleEvent = JSON.parse(staleBody.split('\n')[0].slice('data: '.length));
  assert.equal(JSON.parse(staleEvent.errorText).error.code, 'authentication_required');
  assert.equal(wire.length, 0);

  const freshToken = await mintGateway(issuer, {
    now: Math.floor(currentNowMs / 1000),
    expiresInSeconds: 120,
  });
  await agent.setCailCredential(freshToken);
  const freshResponse = await agent.onChatMessage(undefined, { requestId: 'fresh-refresh' });
  await freshResponse.text();

  assert.deepEqual(wire, [{
    authorization: `Bearer ${freshToken}`,
    app: 'agent-studio',
  }]);
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
  assert.equal(storage.values.has('cail:subject'), false);
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
