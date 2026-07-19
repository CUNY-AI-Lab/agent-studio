// Tests for the workspace PATCH validation schema — specifically the per-
// workspace model override, which accepts only provider-neutral `cail/...`
// aliases and rejects anything else (the route maps a parse failure to 400).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patchWorkspaceSchema } from '../src/lib/workspace-validation.ts';

test('accepts a well-formed cail model alias', () => {
  const result = patchWorkspaceSchema.safeParse({ model: 'cail/workers-llama-3.1-8b' });
  assert.equal(result.success, true);
  assert.equal(result.data.model, 'cail/workers-llama-3.1-8b');
});

test('accepts a name/description patch with no model', () => {
  const result = patchWorkspaceSchema.safeParse({ name: 'Renamed' });
  assert.equal(result.success, true);
  assert.equal(result.data.model, undefined);
});

test('rejects a model id outside the cail namespace', () => {
  for (const bad of ['gpt-4o', 'openai/gpt-4', '@cf/model', 'https://evil/x', '', 'cail/']) {
    assert.equal(
      patchWorkspaceSchema.safeParse({ model: bad }).success,
      false,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('rejects an over-long model id', () => {
  const result = patchWorkspaceSchema.safeParse({ model: `cail/${'x'.repeat(300)}` });
  assert.equal(result.success, false);
});
