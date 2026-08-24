// Regression coverage for the export/import round-trip of a workspace that
// carries a per-workspace `model` override (AS-2-2). The export bundle
// serializes the whole workspace record verbatim, so the import schema must
// accept the `model` key it emits; otherwise the .strict() parse throws and the
// import fails outright — data loss on round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceExportBundle } from '../src/lib/export.ts';
import { parseWorkspaceImportBundle } from '../src/lib/import.ts';

function baseState(workspace) {
  return {
    sessionId: null,
    workspace,
    panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [],
  };
}

test('round-trip: a workspace WITH a model override exports and re-imports', async () => {
  const now = new Date(0).toISOString();
  const workspace = {
    id: 'ws-1',
    name: 'Model Override',
    description: 'has a model override',
    createdAt: now,
    updatedAt: now,
    model: '@cf/zai-org/glm-5.2',
  };

  const bundle = await createWorkspaceExportBundle({
    workspace,
    // state.workspace is validated by the SAME workspaceRecordSchema, so include
    // the override there too to exercise both code paths.
    state: baseState(workspace),
    messages: [],
    files: [],
    readFile: async () => null,
  });

  // The exported bundle must carry the override verbatim at both positions.
  assert.equal(bundle.workspace.model, '@cf/zai-org/glm-5.2');
  assert.equal(bundle.state.workspace.model, '@cf/zai-org/glm-5.2');

  // Re-import: this threw before the fix (strict schema rejected `model`).
  const reparsed = parseWorkspaceImportBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(reparsed.workspace.model, '@cf/zai-org/glm-5.2');
  assert.equal(reparsed.state.workspace.model, '@cf/zai-org/glm-5.2');
});

test('round-trip: a workspace WITHOUT a model override still imports', async () => {
  const now = new Date(0).toISOString();
  const workspace = {
    id: 'ws-2',
    name: 'No Override',
    description: 'plain',
    createdAt: now,
    updatedAt: now,
  };

  const bundle = await createWorkspaceExportBundle({
    workspace,
    state: baseState(workspace),
    messages: [],
    files: [],
    readFile: async () => null,
  });

  const reparsed = parseWorkspaceImportBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(reparsed.workspace.model, undefined);
});

test('round-trip: a malformed model id is still rejected on import', () => {
  const now = new Date(0).toISOString();
  const bundle = {
    version: 1,
    exportedAt: now,
    workspace: {
      id: 'ws-3',
      name: 'Bad Model',
      description: 'not a @cf id',
      createdAt: now,
      updatedAt: now,
      model: 'gpt-4o',
    },
    state: baseState({
      id: 'ws-3',
      name: 'Bad Model',
      description: 'not a @cf id',
      createdAt: now,
      updatedAt: now,
    }),
    messages: [],
    files: [],
  };

  assert.throws(() => parseWorkspaceImportBundle(bundle));
});
