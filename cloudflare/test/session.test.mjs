// Tests for session-cookie signing and SESSION_SECRET handling.
//
// The signing key is derived by hashing the raw secret string, so any secret
// of sufficient length works — including non-hex strings. The previous
// implementation required even-length hex and turned every other value
// (including the .dev.vars.example placeholder) into an uncaught error deep
// inside the middleware.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SESSION_SECRET_LENGTH,
  signValue,
  verifySignedValue,
  sessionMiddleware,
} from '../src/lib/session.ts';

const SESSION_ID = 'ab'.repeat(16); // 32-hex opaque id shape

test('sign/verify roundtrip works with a hex secret', async () => {
  const secret = 'cd'.repeat(32);
  const signed = await signValue(SESSION_ID, secret);
  assert.equal(await verifySignedValue(signed, secret), SESSION_ID);
});

test('sign/verify roundtrip works with a non-hex secret', async () => {
  const secret = 'not-hex-but-long-enough-to-be-a-real-secret!';
  const signed = await signValue(SESSION_ID, secret);
  assert.equal(await verifySignedValue(signed, secret), SESSION_ID);
});

test('short secrets fail loud with an actionable message', async () => {
  await assert.rejects(
    () => signValue(SESSION_ID, 'too-short'),
    new RegExp(`at least ${MIN_SESSION_SECRET_LENGTH} characters`)
  );
});

test('tampered signatures and wrong secrets are rejected', async () => {
  const secret = 'ef'.repeat(32);
  const signed = await signValue(SESSION_ID, secret);
  const [value, signature] = signed.split('.');
  const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  assert.equal(await verifySignedValue(`${value}.${flipped}`, secret), null);
  assert.equal(await verifySignedValue(signed, 'ff'.repeat(32)), null);
  assert.equal(await verifySignedValue('garbage', secret), null);
});

test('middleware maps an unloadable identity config to a typed 503, distinct from the token-invalid 401', async () => {
  const { Hono } = await import('hono');
  const { CAIL_IDENTITY_HEADER } = await import('../src/lib/cail-identity.ts');
  const baseEnv = {
    SESSION_SECRET: 'ci-style-secret-that-is-not-hex-at-all',
    CAIL_REQUIRE_IDENTITY: 'true',
  };

  const app = new Hono();
  app.use('/api/*', sessionMiddleware);
  app.get('/api/session', (c) => c.json({ sessionId: c.get('sessionId') }));

  // Token invalid against a LOADED config → the caller's 401.
  const unauthorized = await app.request(
    '/api/session',
    { headers: { [CAIL_IDENTITY_HEADER]: 'bad.jwt.token' } },
    {
      ...baseEnv,
      CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [] }),
      CAIL_IDENTITY_ISSUER: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    }
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'authentication_required');

  // Config the worker cannot LOAD → our 503, never a sign-in loop.
  const misconfigured = await app.request(
    '/api/session',
    { headers: { [CAIL_IDENTITY_HEADER]: 'bad.jwt.token' } },
    {
      ...baseEnv,
      CAIL_IDENTITY_JWKS: '{not-json',
      CAIL_IDENTITY_ISSUER: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    }
  );
  assert.equal(misconfigured.status, 503);
  assert.equal((await misconfigured.json()).error.code, 'identity_verification_misconfigured');
});

test('middleware issues and honors a cookie under a non-hex secret', async () => {
  const { Hono } = await import('hono');
  const env = { SESSION_SECRET: 'ci-style-secret-that-is-not-hex-at-all' };

  const app = new Hono();
  app.use('/api/*', sessionMiddleware);
  app.get('/api/session', (c) => c.json({ sessionId: c.get('sessionId') }));

  const first = await app.request('/api/session', {}, env);
  assert.equal(first.status, 200);
  const cookieHeader = first.headers.get('set-cookie') || '';
  const match = cookieHeader.match(/agent-studio-session=([^;]*)/);
  assert.ok(match, 'middleware should set a session cookie');
  const { sessionId } = await first.json();

  const second = await app.request(
    '/api/session',
    { headers: { cookie: `agent-studio-session=${match[1]}` } },
    env
  );
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { sessionId });
});
