// Unit tests for the Agent Studio CAIL identity boundary and model-proxy call
// construction. TypeScript sources are loaded through tsx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import {
  TEST_SUBJECTS,
  createTestIdentityIssuer,
} from '@cuny-ai-lab/cail-identity/testing';

import {
  verifyIdentityJwt,
  getCailIdentityFromRequest,
  cailIdentityRequired,
  cailAuthRequiredResponse,
  verifyCredentialForSession,
  sessionIdForSubject,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  CAIL_APP_SLUG,
  CAIL_IDENTITY_HEADER,
  CAIL_IDENTITY_AUDIENCE,
} from '../src/lib/cail-identity.ts';
import {
  createCailModel,
  resolveCailModelName,
  DEFAULT_CAIL_MODEL,
} from '../src/lib/cail-model.ts';

const NOW = 1_800_000_000;

// Minting goes through the canonical test issuer from
// @cuny-ai-lab/cail-identity/testing; this wrapper only fills in the
// repo-standard audience/claims and test clock.
function mintValid(issuer, overrides = {}) {
  return issuer.mintIdentityJwt({
    audience: CAIL_IDENTITY_AUDIENCE,
    email: 'someone@gc.cuny.edu',
    name: 'Some One',
    entitlements: ['tools', 'agent-studio'],
    now: NOW,
    ...overrides,
  });
}

function identityEnv(...issuers) {
  return {
    CAIL_IDENTITY_JWKS: JSON.stringify({
      keys: issuers.flatMap((issuer) => issuer.jwks.keys),
    }),
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  };
}

test('verifies the canonical RS256 identity contract', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const token = await mintValid(issuer);
  const identity = await verifyIdentityJwt(token, issuer.jwks, {
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
    allowedIssuers: [CAIL_CANONICAL_ISSUER],
    now: NOW,
  });

  assert.ok(identity);
  assert.equal(identity.subject, TEST_SUBJECTS.alice);
  assert.equal(identity.email, 'someone@gc.cuny.edu');
  assert.deepEqual(identity.entitlements, ['tools', 'agent-studio']);
});

test('canonical header accepts either key during rotation overlap', async () => {
  const [oldIssuer, newIssuer] = await Promise.all([
    createTestIdentityIssuer({ kid: 'old-key' }),
    createTestIdentityIssuer({ kid: 'new-key' }),
  ]);
  const env = identityEnv(oldIssuer, newIssuer);

  for (const issuer of [oldIssuer, newIssuer]) {
    const token = await mintValid(issuer);
    const request = new Request('https://agent-studio.example/api/session', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    const result = await getCailIdentityFromRequest(request, env, NOW);
    assert.ok(result);
    assert.equal(result.token, token);
    assert.equal(result.identity.subject, TEST_SUBJECTS.alice);
    assert.deepEqual(Object.keys(result).sort(), ['identity', 'token']);
  }
});

test('unconfigured identity is anonymous; an unloadable config is a CONFIG error, not a token error', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const token = await mintValid(issuer);
  const request = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });

  // Identity feature entirely off (nothing configured, enforcement off):
  // anonymous, as before.
  assert.equal(await getCailIdentityFromRequest(request, {}, NOW), null);
  // Configured but unloadable: a discriminated config error the HTTP surface
  // maps to 503 — never the token-invalid null/401.
  assert.deepEqual(
    await getCailIdentityFromRequest(request, {
      CAIL_IDENTITY_JWKS: '{not-json',
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    }, NOW),
    { configError: 'jwks_malformed' },
  );
  // Enforcement on but nothing configured: auth can never succeed → config
  // error, not a "sign in" 401 loop.
  assert.deepEqual(
    await getCailIdentityFromRequest(request, { CAIL_REQUIRE_IDENTITY: 'true' }, NOW),
    { configError: 'jwks_missing' },
  );
  // Partial config (issuer without JWKS) is operator error too.
  assert.deepEqual(
    await getCailIdentityFromRequest(request, { CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER }, NOW),
    { configError: 'jwks_missing' },
  );
});

test('identity trust is one exact configured issuer and fails closed when ambiguous', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'issuer-key' });
  const productionToken = await mintValid(issuer);
  const stagingToken = await mintValid(issuer, { issuer: CAIL_STAGING_ISSUER });
  const requestFor = (token) => new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });
  const jwks = issuer.jwksJson;

  assert.ok(await getCailIdentityFromRequest(requestFor(productionToken), {
    CAIL_IDENTITY_JWKS: jwks,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  }, NOW));
  assert.equal(await getCailIdentityFromRequest(requestFor(stagingToken), {
    CAIL_IDENTITY_JWKS: jwks,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  }, NOW), null);
  assert.ok(await getCailIdentityFromRequest(requestFor(stagingToken), {
    CAIL_IDENTITY_JWKS: jwks,
    CAIL_IDENTITY_ISSUER: CAIL_STAGING_ISSUER,
  }, NOW));
  // A JWKS with no usable issuer is an unloadable CONFIG, not a bad token.
  for (const [issuer, reason] of [
    [undefined, 'issuer_missing'],
    ['', 'issuer_missing'],
    [`${CAIL_CANONICAL_ISSUER},${CAIL_STAGING_ISSUER}`, 'issuer_unsupported'],
  ]) {
    assert.deepEqual(await getCailIdentityFromRequest(requestFor(productionToken), {
      CAIL_IDENTITY_JWKS: jwks,
      ...(issuer === undefined ? {} : { CAIL_IDENTITY_ISSUER: issuer }),
    }, NOW), { configError: reason });
  }
});

test('canonical header rejects unsupported algorithms', async () => {
  // Deliberately outside the canonical test issuer: an HS256 token is a
  // contract violation createTestIdentityIssuer cannot (and must not) mint.
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const hsKey = new TextEncoder().encode('identity-algorithm-confusion-test-key');
  const token = await new SignJWT({
    sub: TEST_SUBJECTS.alice,
    aud: CAIL_IDENTITY_AUDIENCE,
    iss: CAIL_CANONICAL_ISSUER,
    exp: NOW + 3600,
  })
    .setProtectedHeader({ alg: 'HS256', kid: 'active-key', typ: 'JWT' })
    .sign(hsKey);
  const request = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });

  assert.equal(
    await getCailIdentityFromRequest(request, identityEnv(issuer), NOW),
    null,
  );
});

test('canonical header rejects wrong audience, issuer, and expired tokens', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const env = identityEnv(issuer);

  for (const overrides of [
    { audience: 'cail:other-service' },
    { issuer: 'https://evil.example/cail-sso' },
    // exp = NOW - 120.
    { now: NOW - 3720, expiresInSeconds: 3600 },
  ]) {
    const token = await mintValid(issuer, overrides);
    const request = new Request('https://agent-studio.example/api/session', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    assert.equal(await getCailIdentityFromRequest(request, env, NOW), null);
  }
});

test('canonical header rejects an array audience claim', async () => {
  // Since cail-identity 4.4.0 the kit mints the array-`aud` shape directly
  // (even one-element), signed by the same key its JWKS advertises — the
  // verifier must still reject it.
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const token = await mintValid(issuer, { audience: [CAIL_IDENTITY_AUDIENCE] });
  const request = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });

  assert.equal(await getCailIdentityFromRequest(request, identityEnv(issuer), NOW), null);
});

test('getCailIdentityFromRequest returns null with no canonical header', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'active-key' });
  const request = new Request('https://agent-studio.example/api/session');
  assert.equal(await getCailIdentityFromRequest(request, identityEnv(issuer), NOW), null);
});

test('sessionIdForSubject is stable and subject-specific', async () => {
  const id = await sessionIdForSubject(TEST_SUBJECTS.alice);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(id, await sessionIdForSubject(TEST_SUBJECTS.alice));
  assert.notEqual(id, await sessionIdForSubject(TEST_SUBJECTS.bob));
});

test('verifyCredentialForSession accepts only a matching subject session', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'credential-key' });
  const token = await mintValid(issuer);
  const env = identityEnv(issuer);
  const expected = await sessionIdForSubject(TEST_SUBJECTS.alice);
  const identity = await verifyCredentialForSession(token, expected, env, NOW);

  assert.ok(identity);
  assert.equal(identity.subject, TEST_SUBJECTS.alice);
  assert.equal(
    await verifyCredentialForSession(
      token,
      await sessionIdForSubject(TEST_SUBJECTS.carol),
      env,
      NOW,
    ),
    null,
  );
});

test('verifyCredentialForSession rejects empty and malformed credentials', async () => {
  const issuer = await createTestIdentityIssuer({ kid: 'credential-key' });
  const env = identityEnv(issuer);
  const expected = await sessionIdForSubject(TEST_SUBJECTS.alice);

  assert.equal(await verifyCredentialForSession('not-a-jwt', expected, env, NOW), null);
  assert.equal(await verifyCredentialForSession('', expected, env, NOW), null);
  assert.equal(await verifyCredentialForSession(null, expected, env, NOW), null);
});

test('cailIdentityRequired only true for the literal "true"', () => {
  assert.equal(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: 'true' }), true);
  assert.equal(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: 'false' }), false);
  assert.equal(cailIdentityRequired({}), false);
});

test('cailAuthRequiredResponse is a 401 with the canonical nested envelope', async () => {
  const response = cailAuthRequiredResponse();
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'authentication_required');
  assert.equal(body.error.cail.login_url, '/login');
});

test('resolveCailModelName honors the override and default', () => {
  assert.equal(
    resolveCailModelName({ CAIL_MODEL: '@cf/openai/gpt-oss-120b' }),
    '@cf/openai/gpt-oss-120b',
  );
  assert.equal(resolveCailModelName({}), DEFAULT_CAIL_MODEL);
});

test('createCailModel forwards the JWT + app header and sets no provider key', async () => {
  const captured = [];
  const capturedCredentials = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    captured.push(request);
    capturedCredentials.push(init?.credentials);
    return new Response(JSON.stringify({ error: { message: 'stop' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const model = createCailModel({
      env: { CAIL_API_BASE: 'https://proxy.example', CAIL_MODEL: '@cf/zai-org/glm-5.2' },
      identityJwt: 'jwt-token-value',
      correlation: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        trace_flags: 0,
        request_id: '11111111-1111-4111-8111-111111111111',
        tracestate: 'cail=studio',
      },
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }).catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length >= 1, true, 'provider should have issued a request');
  const request = captured[0];
  assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
  assert.equal(request.headers.get(CAIL_IDENTITY_HEADER), 'jwt-token-value');
  assert.equal(request.headers.get('X-CAIL-App'), CAIL_APP_SLUG);
  assert.equal(request.headers.get('authorization'), null);
  assert.equal(request.headers.get('traceparent'), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`);
  assert.equal(request.headers.get('tracestate'), 'cail=studio');
  assert.equal(request.headers.get('x-cail-request-id'), '11111111-1111-4111-8111-111111111111');
  assert.equal(capturedCredentials[0], 'omit');
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
