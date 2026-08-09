import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  agentSocketBasePath,
  APP_IDENTITY_JWT_ENV,
  APP_IDENTITY_JWT_HEADER,
  assertIdentityCredentials,
  GATEWAY_IDENTITY_JWT_ENV,
  GATEWAY_IDENTITY_JWT_HEADER,
  identityCredentialsFromEnv,
  identityHeaders,
  applicationUrl,
  parseArgs,
  redactSensitiveText,
  SessionClient,
} from './smoke-common.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('SessionClient sends the bootstrapped CSRF token on protected reads', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    if (String(url).endsWith('/api/session')) {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'agent-studio-session=session.signature; Path=/');
      headers.append('Set-Cookie', `cail_csrf_agentstudio=${'a'.repeat(64)}; Path=/`);
      return new Response(JSON.stringify({ sessionId: 'session' }), { headers });
    }
    return new Response(JSON.stringify({ workspaces: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new SessionClient('http://127.0.0.1:8799');
  await client.ensureSession();
  await client.json('/api/workspaces');

  assert.equal(requests[1].headers.get('X-CAIL-CSRF'), 'a'.repeat(64));
  assert.equal(requests[1].headers.get('Cookie'), 'agent-studio-session=session.signature');
});

test('identity keyring credentials attach the app leg broadly and gateway leg only when requested', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    if (requests.length === 1) {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'agent-studio-session=session.signature; Path=/');
      headers.append('Set-Cookie', `cail_csrf_agentstudio=${'b'.repeat(64)}; Path=/`);
      return new Response(JSON.stringify({ sessionId: 'session' }), { headers });
    }
    return new Response(JSON.stringify({ workspaces: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const credentials = identityCredentialsFromEnv({
    [APP_IDENTITY_JWT_ENV]: ' app-jwt ',
    [GATEWAY_IDENTITY_JWT_ENV]: ' gateway-jwt ',
  });
  const client = new SessionClient('http://127.0.0.1:8799', '', credentials);
  await client.ensureSession();
  await client.json('/api/workspaces');
  await client.fetch('/api/workspaces/workspace/files');
  await client.json('/api/workspaces', {}, { includeGateway: true });

  assert.equal(requests[0].headers.get(APP_IDENTITY_JWT_HEADER), 'app-jwt');
  assert.equal(requests[0].headers.get(GATEWAY_IDENTITY_JWT_HEADER), null);
  assert.equal(requests[1].headers.get(APP_IDENTITY_JWT_HEADER), 'app-jwt');
  assert.equal(requests[1].headers.get(GATEWAY_IDENTITY_JWT_HEADER), null);
  assert.equal(requests[2].headers.get(APP_IDENTITY_JWT_HEADER), 'app-jwt');
  assert.equal(requests[2].headers.get(GATEWAY_IDENTITY_JWT_HEADER), null);
  assert.equal(requests[3].headers.get(APP_IDENTITY_JWT_HEADER), 'app-jwt');
  assert.equal(requests[3].headers.get(GATEWAY_IDENTITY_JWT_HEADER), 'gateway-jwt');
});

test('app-only identity remains valid for API smoke while chat requires both legs', () => {
  const credentials = assertIdentityCredentials({ appIdentityJwt: 'app-jwt' });
  assert.deepEqual(credentials, { appIdentityJwt: 'app-jwt', gatewayIdentityJwt: undefined });
  assert.deepEqual(identityHeaders(credentials), { [APP_IDENTITY_JWT_HEADER]: 'app-jwt' });
  assert.deepEqual(
    identityHeaders({ ...credentials, gatewayIdentityJwt: 'gateway-jwt' }, { includeGateway: true }),
    { [APP_IDENTITY_JWT_HEADER]: 'app-jwt', [GATEWAY_IDENTITY_JWT_HEADER]: 'gateway-jwt' },
  );
  assert.throws(
    () => assertIdentityCredentials(credentials, { withChat: true }),
    /requires both AGENT_STUDIO_APP_IDENTITY_JWT and AGENT_STUDIO_GATEWAY_IDENTITY_JWT/,
  );
});

test('anonymous local smoke remains valid only when paid chat is disabled', () => {
  assert.doesNotThrow(() => assertIdentityCredentials({}, { withChat: false }));
  assert.throws(
    () => assertIdentityCredentials({}, { withChat: true }),
    /requires both AGENT_STUDIO_APP_IDENTITY_JWT and AGENT_STUDIO_GATEWAY_IDENTITY_JWT/,
  );
});

test('parseArgs accepts separated and inline values', () => {
  assert.deepEqual(
    parseArgs(['--with-chat=true', '--base-url=https://example.invalid/agent-studio']),
    { 'with-chat': 'true', 'base-url': 'https://example.invalid/agent-studio' },
  );
});

test('diagnostic text never includes credentials or identity-bearing values', () => {
  assert.equal(
    redactSensitiveText('upstream app-jwt gateway-jwt 0123456789abcdef0123456789abcdef person@example.test', {
      appIdentityJwt: 'app-jwt',
      gatewayIdentityJwt: 'gateway-jwt',
    }),
    'upstream [redacted] [redacted] [id redacted] [email redacted]',
  );
  assert.equal(redactSensitiveText('subject cail-0123456789abcdef'), 'subject [subject redacted]');
});

test('smoke URLs preserve the deployed application mount', async () => {
  assert.equal(
    applicationUrl('/api/session', 'http://127.0.0.1:8799/agent-studio').href,
    'http://127.0.0.1:8799/agent-studio/api/session',
  );
  assert.equal(
    agentSocketBasePath('http://127.0.0.1:8799/agent-studio', 'WorkspaceAgent', 'abc-123'),
    'agent-studio/agents/workspace-agent/abc-123',
  );

  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ sessionId: 'session' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new SessionClient('http://127.0.0.1:8799/agent-studio');
  await client.ensureSession();
  assert.equal(requests[0], 'http://127.0.0.1:8799/agent-studio/api/session');
});
