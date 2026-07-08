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
  verifyCredentialForSession,
  sessionIdForSubject,
  CAIL_ALLOWED_ISSUERS,
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
// Standard opts for direct verifier calls: fixed clock + the worker's exact
// issuer allowlist. verifyIdentityJwt is now the shared @cuny-ai-lab package
// (opts object), not the old (token, secret, now) positional form.
const OPTS = { now: NOW, allowedIssuers: CAIL_ALLOWED_ISSUERS };
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
  const identity = await verifyIdentityJwt(token, SECRET, OPTS);
  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc123');
  assert.equal(identity.email, 'someone@gc.cuny.edu');
  assert.deepEqual(identity.entitlements, ['tools', 'agent-studio']);
});

test('rejects a token signed with the wrong secret', async () => {
  const token = await mintJwt(validPayload(), { secret: 'other-secret' });
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('rejects an expired token (beyond the clock tolerance)', async () => {
  // The shared verifier allows 60s of leeway; put exp well outside it.
  const token = await mintJwt(validPayload({ exp: NOW - 120 }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('rejects the wrong audience', async () => {
  const token = await mintJwt(validPayload({ aud: 'someone-else' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('rejects an issuer not in the allowlist', async () => {
  const token = await mintJwt(validPayload({ iss: 'https://evil.example/oauth' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('rejects a look-alike /cail-sso issuer not in the allowlist (Codex #3)', async () => {
  // https://evil.example/cail-sso PASSED the old endsWith("/cail-sso") suffix
  // check. The shared verifier uses an EXACT allowlist, so it is rejected —
  // this pins that the migration tightened the issuer check (closes the
  // AS-3 iss drift), not merely re-implemented it.
  const token = await mintJwt(validPayload({ iss: 'https://evil.example/cail-sso' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('accepts the staging issuer (it is listed in the allowlist)', async () => {
  const token = await mintJwt(
    validPayload({ iss: 'https://tools.cuny.qzz.io/cail-sso' }),
  );
  const identity = await verifyIdentityJwt(token, SECRET, OPTS);
  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc123');
});

test('pins the algorithm: refuses a token that declares alg=none', async () => {
  // Forge an unsigned token with alg "none".
  const headerB64 = b64urlJson({ alg: 'none', typ: 'JWT' });
  const payloadB64 = b64urlJson(validPayload());
  const forged = `${headerB64}.${payloadB64}.`;
  assert.equal(await verifyIdentityJwt(forged, SECRET, OPTS), null);
});

// ---- AS-3-2/AS-3-3: nbf claim completeness ----

test('rejects a token whose nbf is beyond the clock tolerance', async () => {
  // 60s leeway applies to nbf too; put it well past the tolerance.
  const token = await mintJwt(validPayload({ nbf: NOW + 120 }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

test('accepts a token whose nbf is in the past', async () => {
  const token = await mintJwt(validPayload({ nbf: NOW - 60 }));
  const identity = await verifyIdentityJwt(token, SECRET, OPTS);
  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc123');
});

test('accepts a token with no nbf (nbf is optional)', async () => {
  const token = await mintJwt(validPayload());
  assert.ok(await verifyIdentityJwt(token, SECRET, OPTS));
});

test('rejects a token whose nbf is present but not a number (I9 tightening)', async () => {
  // The old vendored verifier ignored a non-numeric nbf and still accepted the
  // token. The shared verifier treats a present-but-non-number nbf as invalid
  // and rejects — the intended tightening (AS-3-2/3-3 nbf drift closed).
  const token = await mintJwt(validPayload({ nbf: 'soon' }));
  assert.equal(await verifyIdentityJwt(token, SECRET, OPTS), null);
});

// ---- AS-3-1: setCailCredential verify + subject-binding (via the shared helper) ----

test('sessionIdForSubject is a 32-hex digest of cail:<subject>', async () => {
  const id = await sessionIdForSubject('cail-abc123');
  assert.match(id, /^[a-f0-9]{32}$/);
  // Stable / deterministic.
  assert.equal(id, await sessionIdForSubject('cail-abc123'));
  assert.notEqual(id, await sessionIdForSubject('cail-other'));
});

test('verifyCredentialForSession accepts the correct-subject token', async () => {
  const token = await mintJwt(validPayload());
  const expected = await sessionIdForSubject('cail-abc123');
  const identity = await verifyCredentialForSession(token, expected, SECRET, NOW);
  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc123');
});

test('verifyCredentialForSession rejects invalid / garbage tokens', async () => {
  const expected = await sessionIdForSubject('cail-abc123');
  assert.equal(await verifyCredentialForSession('not-a-jwt', expected, SECRET, NOW), null);
  assert.equal(await verifyCredentialForSession('', expected, SECRET, NOW), null);
  assert.equal(await verifyCredentialForSession(null, expected, SECRET, NOW), null);
});

test('verifyCredentialForSession rejects an expired token', async () => {
  // Beyond the 60s clock tolerance the shared verifier applies.
  const token = await mintJwt(validPayload({ exp: NOW - 120 }));
  const expected = await sessionIdForSubject('cail-abc123');
  assert.equal(await verifyCredentialForSession(token, expected, SECRET, NOW), null);
});

test('verifyCredentialForSession rejects a valid token whose subject maps to a DIFFERENT session', async () => {
  // A genuinely valid token, but for a foreign subject — cannot be installed
  // onto this DO's session.
  const token = await mintJwt(validPayload({ sub: 'cail-foreign' }));
  const thisSession = await sessionIdForSubject('cail-abc123');
  assert.notEqual(await sessionIdForSubject('cail-foreign'), thisSession);
  assert.equal(await verifyCredentialForSession(token, thisSession, SECRET, NOW), null);
});

test('returns null for a malformed token', async () => {
  assert.equal(await verifyIdentityJwt('not-a-jwt', SECRET, OPTS), null);
  assert.equal(await verifyIdentityJwt('a.b', SECRET, OPTS), null);
});

test('rejects a valid token when the allowlist is empty (fail closed)', async () => {
  // The shared verifier rejects EVERY token when allowedIssuers is absent/empty
  // — even a canonical issuer. This is the fail-closed guarantee that replaces
  // the old suffix check.
  const token = await mintJwt(validPayload());
  assert.equal(await verifyIdentityJwt(token, SECRET, { now: NOW, allowedIssuers: [] }), null);
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

test('getCailIdentityFromRequest returns null when the secret is unset (identity disabled)', async () => {
  // Even with a well-formed token present, an unconfigured secret means every
  // request is anonymous — the wrapper guards this before the shared verifier.
  const token = await mintJwt(validPayload());
  const req = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });
  const result = await getCailIdentityFromRequest(req, {}, NOW);
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
  assert.equal(
    resolveCailModelName({ CAIL_MODEL: '@cf/openai/gpt-oss-120b' }),
    '@cf/openai/gpt-oss-120b'
  );
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
      env: { CAIL_API_BASE: 'https://proxy.example', CAIL_MODEL: '@cf/zai-org/glm-5.2' },
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
