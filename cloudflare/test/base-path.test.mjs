import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidBasePath,
  normalizeBasePath,
  stripBasePath,
  withBasePath,
} from '../src/lib/base-path.ts';

test('base path normalization is shared by URL and cookie mounting', () => {
  assert.equal(normalizeBasePath(undefined), '/');
  assert.equal(normalizeBasePath('agent-studio///'), '/agent-studio');
  assert.equal(withBasePath('/api/session', '/agent-studio/'), '/agent-studio/api/session');
  assert.equal(withBasePath('/', '/agent-studio'), '/agent-studio/');
});

test('base path validation rejects ambiguous and encoded prefixes', () => {
  for (const value of ['/agent-studio', '/tools/agent-studio', '/']) {
    assert.equal(isValidBasePath(value), true, value);
  }
  for (const value of ['/agent//studio', '/agent/../studio', '/agent%2fstudio', '/ agent']) {
    assert.equal(isValidBasePath(value), false, value);
  }
});

test('request rewriting admits only the configured mount and preserves query data', async () => {
  const original = new Request('https://tools.example/agent-studio/api/session?x=1', {
    method: 'POST',
    body: 'payload',
  });
  const rewritten = stripBasePath(original, '/agent-studio');
  assert.ok(rewritten);
  assert.equal(new URL(rewritten.url).pathname, '/api/session');
  assert.equal(new URL(rewritten.url).search, '?x=1');
  assert.equal(rewritten.method, 'POST');
  assert.equal(await rewritten.text(), 'payload');

  assert.equal(stripBasePath(new Request('https://tools.example/api/session'), '/agent-studio'), null);
  assert.equal(stripBasePath(new Request('https://tools.example/agent-studio-other'), '/agent-studio'), null);
});
