// Tests for the OAuth client-credentials token broker: request shape, caching,
// expiry, and configuration gating. All network is via an injected fetch — no
// real HTTP and no real credentials (fake values only).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAccessToken,
  invalidateToken,
  isProviderConfigured,
  __resetTokenCacheForTests,
} from '../src/lib/api-token-broker.ts';

const WORLDCAT_ENV = {
  OCLC_CLIENT_ID: 'wc-id',
  OCLC_CLIENT_SECRET: 'wc-secret',
};

const LIBGUIDES_ENV = {
  LIBGUIDES_BASE_URL: 'https://lgapi-us.libapps.com/1.2',
  LIBGUIDES_CLIENT_ID: 'lg-id',
  LIBGUIDES_CLIENT_SECRET: 'lg-secret',
  LIBGUIDES_SITE_ID: '999',
};

function tokenResponse(token, expiresIn) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('isProviderConfigured requires the credential pair', () => {
  assert.equal(isProviderConfigured('worldcat', WORLDCAT_ENV), true);
  assert.equal(isProviderConfigured('worldcat', { OCLC_CLIENT_ID: 'x' }), false);
  assert.equal(isProviderConfigured('libguides', LIBGUIDES_ENV), true);
  assert.equal(isProviderConfigured('libguides', { LIBGUIDES_BASE_URL: 'x' }), false);
});

test('unconfigured provider returns null and does not fetch', async () => {
  __resetTokenCacheForTests();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return tokenResponse('nope', 1200);
  };
  const token = await getAccessToken('worldcat', {}, fetchImpl);
  assert.equal(token, null);
  assert.equal(called, false);
});

test('worldcat token request uses POST + Basic auth + client_credentials scope', async () => {
  __resetTokenCacheForTests();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return tokenResponse('wc-token', 1200);
  };
  const token = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  assert.equal(token, 'wc-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth.oclc.org/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  // Basic value is base64(id:secret), never the raw secret.
  const decoded = Buffer.from(
    calls[0].init.headers.Authorization.replace('Basic ', ''),
    'base64'
  ).toString('utf-8');
  assert.equal(decoded, 'wc-id:wc-secret');
  assert.match(calls[0].init.body, /grant_type=client_credentials/);
  assert.match(calls[0].init.body, /scope=WorldCatMetadataAPI/);
});

test('libguides token request posts form-encoded credentials to {base}/oauth/token', async () => {
  __resetTokenCacheForTests();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return tokenResponse('lg-token', 3600);
  };
  const token = await getAccessToken('libguides', LIBGUIDES_ENV, fetchImpl);
  assert.equal(token, 'lg-token');
  assert.equal(calls[0].url, 'https://lgapi-us.libapps.com/1.2/oauth/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('client_id'), 'lg-id');
  assert.equal(body.get('client_secret'), 'lg-secret');
});

test('a fresh token is cached: the second call does not refetch', async () => {
  __resetTokenCacheForTests();
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return tokenResponse(`wc-${n}`, 1200);
  };
  const first = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  const second = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  assert.equal(first, 'wc-1');
  assert.equal(second, 'wc-1');
  assert.equal(n, 1);
});

test('an (almost) expired token is re-acquired thanks to the safety margin', async () => {
  __resetTokenCacheForTests();
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    // expires_in below the 60s safety margin => cached expiry is already in the past.
    return tokenResponse(`wc-${n}`, 30);
  };
  const first = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  const second = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  assert.equal(first, 'wc-1');
  assert.equal(second, 'wc-2');
  assert.equal(n, 2);
});

test('invalidateToken forces the next call to re-acquire', async () => {
  __resetTokenCacheForTests();
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return tokenResponse(`wc-${n}`, 1200);
  };
  await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  invalidateToken('worldcat');
  const after = await getAccessToken('worldcat', WORLDCAT_ENV, fetchImpl);
  assert.equal(after, 'wc-2');
  assert.equal(n, 2);
});
