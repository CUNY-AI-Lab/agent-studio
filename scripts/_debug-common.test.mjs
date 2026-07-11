import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SessionClient } from './_debug-common.mjs';

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
      headers.append(
        'Set-Cookie',
        'agent-studio-session=session.signature; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
      );
      headers.append(
        'Set-Cookie',
        `cail_csrf_agentstudio=${'a'.repeat(64)}; Path=/; SameSite=Lax`,
      );
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
