// Regression coverage for the export/import round-trip of a workspace that
// carries a per-workspace `model` override (AS-2-2). The export bundle
// serializes the whole workspace record verbatim, so the import schema must
// accept the `model` key it emits; otherwise the .strict() parse throws and the
// import fails outright — data loss on round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceExportBundle } from '../src/lib/export.ts';
import { decodeWorkspaceImportFile, parseWorkspaceImportBundle } from '../src/lib/import.ts';

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

test('round-trip: negative canvas coordinates export and re-import unchanged', async () => {
  const now = new Date(0).toISOString();
  const workspace = {
    id: 'ws-negative-canvas',
    name: 'Negative Canvas',
    description: 'tiles can live above and left of the origin',
    createdAt: now,
    updatedAt: now,
  };
  const state = {
    ...baseState(workspace),
    panels: [{
      id: 'panel-negative',
      type: 'markdown',
      title: 'Above and left',
      content: 'content',
      layout: { x: -480.5, y: -220.25, width: 420, height: 260 },
    }],
    viewport: { x: 760, y: 540, zoom: 0.8 },
  };

  const bundle = await createWorkspaceExportBundle({
    workspace,
    state,
    messages: [],
    files: [],
    readFile: async () => null,
  });
  const reparsed = parseWorkspaceImportBundle(JSON.parse(JSON.stringify(bundle)));

  assert.deepEqual(reparsed.state.panels[0].layout, state.panels[0].layout);
  assert.deepEqual(reparsed.state.viewport, state.viewport);
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

test('round-trip: text files preserve a valid UTF-8 BOM byte-for-byte', async () => {
  const now = new Date(0).toISOString();
  const workspace = {
    id: 'ws-bom',
    name: 'UTF-8 BOM',
    description: '',
    createdAt: now,
    updatedAt: now,
  };
  const original = Uint8Array.from([0xef, 0xbb, 0xbf, 0x48, 0x69]);

  const bundle = await createWorkspaceExportBundle({
    workspace,
    state: baseState(workspace),
    messages: [],
    files: [{ path: 'bom.txt', isDirectory: false, size: original.byteLength }],
    readFile: async () => ({
      contentType: 'text/plain; charset=utf-8',
      data: original.buffer,
    }),
  });

  assert.equal(bundle.files[0].encoding, 'utf8');
  assert.equal(bundle.files[0].content, '\ufeffHi');
  const decoded = decodeWorkspaceImportFile(bundle.files[0]);
  assert.deepEqual([...new TextEncoder().encode(decoded)], [...original]);
});

test('round-trip: invalid UTF-8 bytes fall back to base64 without changing bytes', async () => {
  const now = new Date(0).toISOString();
  const workspace = {
    id: 'ws-invalid-utf8',
    name: 'Invalid UTF-8',
    description: '',
    createdAt: now,
    updatedAt: now,
  };
  const original = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);

  const bundle = await createWorkspaceExportBundle({
    workspace,
    state: baseState(workspace),
    messages: [],
    files: [{ path: 'invalid.txt', isDirectory: false, size: original.byteLength }],
    readFile: async () => ({
      contentType: 'text/plain; charset=utf-8',
      data: original.buffer,
    }),
  });

  assert.equal(bundle.files[0].encoding, 'base64');
  const decoded = decodeWorkspaceImportFile(bundle.files[0]);
  assert.ok(decoded instanceof Uint8Array);
  assert.deepEqual([...decoded], [...original]);
});
