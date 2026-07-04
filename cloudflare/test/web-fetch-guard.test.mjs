// Tests for the web_fetch destination policy and server-side credential
// injection. The sandbox has no direct network; the host web_fetch tool is
// the agent's only egress, so the old runner egress-proxy semantics
// (block localhost/private/metadata, re-check every redirect hop) live here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPublicHttpUrl,
  applyConfiguredApiParams,
  guardedWebFetch,
} from '../src/lib/web-fetch-guard.ts';

test('public research API hosts are allowed', () => {
  for (const url of [
    'https://api.openalex.org/works?search=x',
    'https://api.crossref.org/works/10.1000/x',
    'http://export.arxiv.org/api/query',
  ]) {
    assert.equal(assertPublicHttpUrl(url).href, new URL(url).href);
  }
});

test('localhost, private, link-local, and metadata destinations are blocked', () => {
  for (const url of [
    'http://localhost:8787/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.internal/',
    'http://printer.local/',
    'http://router/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.throws(() => assertPublicHttpUrl(url), /not allowed|invalid/, url);
  }
});

test('non-http protocols are rejected', () => {
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/x'), /only http/);
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /only http|not allowed/);
});

test('primo credentials are injected only for the configured host', () => {
  const env = {
    PRIMO_API_BASE: 'https://api-na.hosted.exlibrisgroup.com/primo/v1/search',
    PRIMO_API_KEY: 'k-123',
    PRIMO_VID: '01CUNY_GC:CUNY_GC',
    PRIMO_SCOPE: 'IZ_CI_AW',
  };

  const primo = applyConfiguredApiParams(
    new URL('https://api-na.hosted.exlibrisgroup.com/primo/v1/search?q=any,contains,jazz'),
    env
  );
  assert.equal(primo.searchParams.get('apikey'), 'k-123');
  assert.equal(primo.searchParams.get('vid'), '01CUNY_GC:CUNY_GC');
  assert.equal(primo.searchParams.get('scope'), 'IZ_CI_AW');

  // Explicit vid/scope are preserved; the key is always server-owned.
  const explicit = applyConfiguredApiParams(
    new URL('https://api-na.hosted.exlibrisgroup.com/primo/v1/search?vid=OTHER&apikey=model-supplied'),
    env
  );
  assert.equal(explicit.searchParams.get('vid'), 'OTHER');
  assert.equal(explicit.searchParams.get('apikey'), 'k-123');

  const other = applyConfiguredApiParams(new URL('https://api.openalex.org/works'), env);
  assert.equal(other.searchParams.has('apikey'), false);

  const unconfigured = applyConfiguredApiParams(
    new URL('https://api-na.hosted.exlibrisgroup.com/primo/v1/search'),
    {}
  );
  assert.equal(unconfigured.searchParams.has('apikey'), false);
});

test('guardedWebFetch follows redirects and re-validates each hop', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://example.org/final' } });
    }
    return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  const result = await guardedWebFetch('https://example.com/start', 'text', {}, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.body, 'done');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /example\.org\/final/);
});

test('guardedWebFetch blocks redirects into private space', async () => {
  const fetchImpl = async () =>
    new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });

  await assert.rejects(
    () => guardedWebFetch('https://example.com/redirect-me', 'text', {}, fetchImpl),
    /not allowed/
  );
});

test('guardedWebFetch gives up after too many redirects', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://example.com/hop-${n}` },
    });
  };

  await assert.rejects(
    () => guardedWebFetch('https://example.com/loop', 'text', {}, fetchImpl),
    /too many redirects/
  );
});

test('guardedWebFetch json format returns a JSON string body', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ results: [1, 2] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await guardedWebFetch('https://api.openalex.org/works', 'json', {}, fetchImpl);
  assert.deepEqual(JSON.parse(result.body), { results: [1, 2] });
});
