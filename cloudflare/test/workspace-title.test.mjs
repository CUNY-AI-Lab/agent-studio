import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();

const { isPlaceholderWorkspaceName } = await import('../src/lib/workspace-title.ts');

test('placeholder names are limited to newly-created workspace labels', () => {
  assert.equal(isPlaceholderWorkspaceName('New Workspace'), true);
  assert.equal(isPlaceholderWorkspaceName(' untitled workspace '), true);
  assert.equal(isPlaceholderWorkspaceName('A real research title'), false);
  assert.equal(isPlaceholderWorkspaceName(''), false);
});
