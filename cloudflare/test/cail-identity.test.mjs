// Unit tests for the Agent Studio CAIL identity boundary and model-proxy call
// construction. TypeScript sources are loaded through tsx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

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

function validPayload(overrides = {}) {
  return {
    sub: 'cail-abc12300abc12300abc12300abc12300',
    aud: CAIL_IDENTITY_AUDIENCE,
    iss: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    exp: NOW + 3600,
    email: 'someone@gc.cuny.edu',
    name: 'Some One',
    entitlements: ['tools', 'agent-studio'],
    ...overrides,
  };
}

async function makeKey(kid) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

async function mintIdentityJwt(payload, key) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .sign(key.privateKey);
}

function identityEnv(...keys) {
  return {
    CAIL_IDENTITY_JWKS: JSON.stringify({ keys: keys.map((key) => key.publicJwk) }),
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  };
}

test('verifies the canonical RS256 identity contract', async () => {
  const key = await makeKey('active-key');
  const token = await mintIdentityJwt(validPayload(), key);
  const identity = await verifyIdentityJwt(token, { keys: [key.publicJwk] }, {
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
    allowedIssuers: [CAIL_CANONICAL_ISSUER],
    now: NOW,
  });

  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc12300abc12300abc12300abc12300');
  assert.equal(identity.email, 'someone@gc.cuny.edu');
  assert.deepEqual(identity.entitlements, ['tools', 'agent-studio']);
});

test('canonical header accepts either key during rotation overlap', async () => {
  const [oldKey, newKey] = await Promise.all([makeKey('old-key'), makeKey('new-key')]);
  const env = identityEnv(oldKey, newKey);

  for (const key of [oldKey, newKey]) {
    const token = await mintIdentityJwt(validPayload(), key);
    const request = new Request('https://agent-studio.example/api/session', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    const result = await getCailIdentityFromRequest(request, env, NOW);
    assert.ok(result);
    assert.equal(result.token, token);
    assert.equal(result.identity.subject, 'cail-abc12300abc12300abc12300abc12300');
    assert.deepEqual(Object.keys(result).sort(), ['identity', 'token']);
  }
});

test('canonical header rejects missing or malformed JWKS', async () => {
  const key = await makeKey('active-key');
  const token = await mintIdentityJwt(validPayload(), key);
  const request = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });

  assert.equal(await getCailIdentityFromRequest(request, {}, NOW), null);
  assert.equal(
    await getCailIdentityFromRequest(request, {
      CAIL_IDENTITY_JWKS: '{not-json',
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    }, NOW),
    null,
  );
});

test('identity trust is one exact configured issuer and fails closed when ambiguous', async () => {
  const key = await makeKey('issuer-key');
  const productionToken = await mintIdentityJwt(validPayload(), key);
  const stagingToken = await mintIdentityJwt(
    validPayload({ iss: CAIL_STAGING_ISSUER }),
    key,
  );
  const requestFor = (token) => new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });
  const jwks = JSON.stringify({ keys: [key.publicJwk] });

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
  for (const issuer of [undefined, '', `${CAIL_CANONICAL_ISSUER},${CAIL_STAGING_ISSUER}`]) {
    assert.equal(await getCailIdentityFromRequest(requestFor(productionToken), {
      CAIL_IDENTITY_JWKS: jwks,
      ...(issuer === undefined ? {} : { CAIL_IDENTITY_ISSUER: issuer }),
    }, NOW), null);
  }
});

test('canonical header rejects unsupported algorithms', async () => {
  const key = await makeKey('active-key');
  const hsKey = new TextEncoder().encode('identity-algorithm-confusion-test-key');
  const token = await new SignJWT(validPayload())
    .setProtectedHeader({ alg: 'HS256', kid: 'active-key', typ: 'JWT' })
    .sign(hsKey);
  const request = new Request('https://agent-studio.example/api/session', {
    headers: { [CAIL_IDENTITY_HEADER]: token },
  });

  assert.equal(
    await getCailIdentityFromRequest(request, identityEnv(key), NOW),
    null,
  );
});

test('canonical header rejects wrong audience, issuer, and expired tokens', async () => {
  const key = await makeKey('active-key');
  const env = identityEnv(key);

  for (const overrides of [
    { aud: 'cail:other-service' },
    { aud: [CAIL_IDENTITY_AUDIENCE] },
    { iss: 'https://evil.example/cail-sso' },
    { exp: NOW - 120 },
  ]) {
    const token = await mintIdentityJwt(validPayload(overrides), key);
    const request = new Request('https://agent-studio.example/api/session', {
      headers: { [CAIL_IDENTITY_HEADER]: token },
    });
    assert.equal(await getCailIdentityFromRequest(request, env, NOW), null);
  }
});

test('getCailIdentityFromRequest returns null with no canonical header', async () => {
  const key = await makeKey('active-key');
  const request = new Request('https://agent-studio.example/api/session');
  assert.equal(await getCailIdentityFromRequest(request, identityEnv(key), NOW), null);
});

test('sessionIdForSubject is stable and subject-specific', async () => {
  const id = await sessionIdForSubject('cail-abc12300abc12300abc12300abc12300');
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(id, await sessionIdForSubject('cail-abc12300abc12300abc12300abc12300'));
  assert.notEqual(id, await sessionIdForSubject('cail-07e7000007e7000007e7000007e70000'));
});

test('verifyCredentialForSession accepts only a matching subject session', async () => {
  const key = await makeKey('credential-key');
  const token = await mintIdentityJwt(validPayload(), key);
  const env = identityEnv(key);
  const expected = await sessionIdForSubject('cail-abc12300abc12300abc12300abc12300');
  const identity = await verifyCredentialForSession(token, expected, env, NOW);

  assert.ok(identity);
  assert.equal(identity.subject, 'cail-abc12300abc12300abc12300abc12300');
  assert.equal(
    await verifyCredentialForSession(
      token,
      await sessionIdForSubject('cail-f0e19000f0e19000f0e19000f0e19000'),
      env,
      NOW,
    ),
    null,
  );
});

test('verifyCredentialForSession rejects empty and malformed credentials', async () => {
  const key = await makeKey('credential-key');
  const env = identityEnv(key);
  const expected = await sessionIdForSubject('cail-abc12300abc12300abc12300abc12300');

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
