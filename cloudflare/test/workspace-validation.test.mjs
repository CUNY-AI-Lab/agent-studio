// Tests for the workspace PATCH validation schema — specifically the per-
// workspace model override, which must accept only CAIL catalog ids
// (`@cf/...` Workers AI or `cail/...` OpenRouter) and reject anything else
// (the route turns a parse failure into a 400).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patchWorkspaceSchema } from '../src/lib/workspace-validation.ts';

test('accepts a well-formed @cf model id', () => {
  const result = patchWorkspaceSchema.safeParse({ model: '@cf/zai-org/glm-5.2' });
  assert.equal(result.success, true);
  assert.equal(result.data.model, '@cf/zai-org/glm-5.2');
});

test('accepts a cail/ (OpenRouter namespace) model id', () => {
  const result = patchWorkspaceSchema.safeParse({ model: 'cail/gpt-4.1-nano' });
  assert.equal(result.success, true);
  assert.equal(result.data.model, 'cail/gpt-4.1-nano');
});

test('accepts a name/description patch with no model', () => {
  const result = patchWorkspaceSchema.safeParse({ name: 'Renamed' });
  assert.equal(result.success, true);
  assert.equal(result.data.model, undefined);
});

test('rejects a model id outside the @cf/ and cail/ namespaces', () => {
  for (const bad of ['gpt-4o', 'openai/gpt-4', '@openai/gpt-4', 'https://evil/x', '', '@cf/', 'cail/', '@cail/gpt-4.1-nano']) {
    assert.equal(
      patchWorkspaceSchema.safeParse({ model: bad }).success,
      false,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('rejects an over-long model id', () => {
  const result = patchWorkspaceSchema.safeParse({ model: `@cf/${'x'.repeat(300)}` });
  assert.equal(result.success, false);
});
