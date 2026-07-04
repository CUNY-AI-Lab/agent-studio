// Unit tests for the CAIL identity JWT verifier and model-proxy call
// construction. Runs on the built-in node:test runner (Node 22) with no extra
// deps — the modules under test use only Web-standard crypto/atob/TextEncoder,
// which Node provides as globals. Import the .ts sources through tsx's loader.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyIdentityJwt,
  getCailIdentityFromRequest,
  cailIdentityRequired,
  cailAuthRequiredResponse,
  CAIL_APP_SLUG,
  CAIL_IDENTITY_HEADER,
} from '../src/lib/cail-identity.ts';
import {
  cailCompatBaseUrl,
  createCailModel,
  resolveCailModelName,
  DEFAULT_CAIL_MODEL,
} from '../src/lib/cail-model.ts';

const SECRET = 'test-shared-secret';
const encoder = new TextEncoder();

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(encoder.encode(JSON.stringify(obj)));
}

/** Mint a signed JWT for tests. `alg` lets us forge the header alg field. */
async function mintJwt(payload, { secret = SECRET, alg = 'HS256' } = {}) {
  const headerB64 = b64urlJson({ alg, typ: 'JWT' });
  const payloadB64 = b64urlJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const NOW = 1_800_000_000;
function validPayload(overrides = {}) {
  return {
    sub: 'cail-abc123',
    aud: 'cail-internal',
    iss: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    exp: NOW + 3600,
    email: 'someone@gc.cuny.edu',
    name: 'Some One',
    entitlements: ['tools', 'agent-studio'],
    ...overrides,
  };
}

test('verifies a well-formed token and returns the subject', async () => {
  const token = await mintJwt(validPayload());
  const identity = await verifyIdentityJwt(token, SECRET, NOW);
  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc123');
  assert.equal(identity.email, 'someone@gc.cuny.edu');
  assert.deepEqual(identity.entitlements, ['tools', 'agent-studio']);
});

test('rejects a token signed with the wrong secret', async () => {
  const token = await mintJwt(validPayload(), { secret: 'other-secret' });
  assert.equal(await verifyIdentityJwt(token, SECRET, NOW), null);
});

test('rejects an expired token', async () => {
  const token = await mintJwt(validPayload({ exp: NOW - 1 }));
  assert.equal(await verifyIdentityJwt(token, SECRET, NOW), null);
});

test('rejects the wrong audience', async () => {
  const token = await mintJwt(validPayload({ aud: 'someone-else' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, NOW), null);
});

test('rejects an issuer not ending in /cail-sso', async () => {
  const token = await mintJwt(validPayload({ iss: 'https://evil.example/oauth' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, NOW), null);
});

test('pins the algorithm: refuses a token that declares alg=none', async () => {
  // Forge an unsigned token with alg "none".
  const headerB64 = b64urlJson({ alg: 'none', typ: 'JWT' });
  const payloadB64 = b64urlJson(validPayload());
  const forged = `${headerB64}.${payloadB64}.`;
  assert.equal(await verifyIdentityJwt(forged, SECRET, NOW), null);
});

test('returns null when the secret is unset (identity disabled)', async () => {
  const token = await mintJwt(validPayload());
  assert.equal(await verifyIdentityJwt(token, undefined, NOW), null);
});

test('returns null for a malformed token', async () => {
  assert.equal(await verifyIdentityJwt('not-a-jwt', SECRET, NOW), null);
  assert.equal(await verifyIdentityJwt('a.b', SECRET, NOW), null);
});

test('getCailIdentityFromRequest surfaces the raw token and identity', async () => {
  const token = await mintJwt(validPayload());
  const req = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });
  const result = await getCailIdentityFromRequest(req, { CAIL_IDENTITY_JWT_SECRET: SECRET }, NOW);
  assert.ok(result);
  assert.equal(result.token, token);
  assert.equal(result.identity.subject, 'cail-abc123');
});

test('getCailIdentityFromRequest returns null with no header', async () => {
  const req = new Request('https://agent-studio.example/api/session');
  const result = await getCailIdentityFromRequest(req, { CAIL_IDENTITY_JWT_SECRET: SECRET }, NOW);
  assert.equal(result, null);
});

test('cailIdentityRequired only true for the literal "true"', () => {
  assert.equal(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: 'true' }), true);
  assert.equal(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: 'false' }), false);
  assert.equal(cailIdentityRequired({}), false);
});

test('cailAuthRequiredResponse is a 401 with the CAIL envelope', async () => {
  const res = cailAuthRequiredResponse();
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'authentication_required');
  assert.equal(body.login_url, '/login');
});

// ---- model-proxy call construction ----

test('cailCompatBaseUrl targets the AI Gateway OpenAI-compatible path', () => {
  assert.equal(cailCompatBaseUrl('https://proxy.example'), 'https://proxy.example/v1/compat');
  // trailing slash tolerated
  assert.equal(cailCompatBaseUrl('https://proxy.example/'), 'https://proxy.example/v1/compat');
});

test('resolveCailModelName honors the override and default', () => {
  assert.equal(resolveCailModelName({ CAIL_MODEL: 'openai/gpt-4o' }), 'openai/gpt-4o');
  assert.equal(resolveCailModelName({}), DEFAULT_CAIL_MODEL);
});

test('createCailModel forwards the JWT + app header and sets NO provider key', async () => {
  const captured = [];
  const originalFetch = globalThis.fetch;
  // Intercept the outbound request the provider makes and assert on headers.
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    captured.push(req);
    // Return a minimal OpenAI-compatible error so the SDK stops fast.
    return new Response(JSON.stringify({ error: { message: 'stop' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const model = createCailModel({
      env: { CAIL_API_BASE: 'https://proxy.example', CAIL_MODEL: 'anthropic/claude-sonnet-4' },
      identityJwt: 'jwt-token-value',
    });
    // Drive a generate so the provider issues an HTTP request.
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }).catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length >= 1, true, 'provider should have issued a request');
  const req = captured[0];
  assert.equal(new URL(req.url).pathname, '/v1/compat/chat/completions');
  assert.equal(req.headers.get(CAIL_IDENTITY_HEADER), 'jwt-token-value');
  assert.equal(req.headers.get('X-CAIL-App'), CAIL_APP_SLUG);
  // No provider Bearer key must be present.
  assert.equal(req.headers.get('authorization'), null);
});

test('createCailModel throws without CAIL_API_BASE', () => {
  assert.throws(() => createCailModel({ env: {}, identityJwt: 'x' }), /CAIL_API_BASE/);
});

test('createCailModel throws without an identity JWT', () => {
  assert.throws(
    () => createCailModel({ env: { CAIL_API_BASE: 'https://proxy.example' }, identityJwt: '' }),
    /identity JWT/,
  );
});
