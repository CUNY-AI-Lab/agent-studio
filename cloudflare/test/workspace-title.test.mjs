import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const {
  isFirstSubstantiveTurn,
  isPlaceholderWorkspaceName,
} = await import('../src/lib/workspace-title.ts');

function userMessage(text, id = text) {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

test('placeholder names are limited to newly-created workspace labels', () => {
  assert.equal(isPlaceholderWorkspaceName('New Workspace'), true);
  assert.equal(isPlaceholderWorkspaceName(' untitled workspace '), true);
  assert.equal(isPlaceholderWorkspaceName('A real research title'), false);
  assert.equal(isPlaceholderWorkspaceName(''), false);
});

test('only the first substantive user turn is eligible for automatic naming', () => {
  assert.equal(isFirstSubstantiveTurn([userMessage('')]), false);
  assert.equal(isFirstSubstantiveTurn([userMessage('Find sources')]), true);
  assert.equal(isFirstSubstantiveTurn([
    userMessage('Find sources'),
    { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Working.' }] },
  ]), true);
  assert.equal(isFirstSubstantiveTurn([
    userMessage('Find sources'),
    userMessage('Now compare them', 'user-2'),
  ]), false);
});
