import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { describe, it, after } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import type { WorkspaceConfig } from '../../src/lib/storage';

function randomUserId() {
  return randomBytes(16).toString('hex');
}

describe('ui state updates', () => {
  const userId = randomUserId();
  const storage = createSandboxedStorage(userId);

  after(async () => {
    await rm(path.join(storage.basePath), { recursive: true, force: true }).catch(() => {});
  });

  it('preserves panels when updating viewport', async () => {
    const wsId = 'ui-state-viewport';
    const now = new Date().toISOString();
    const workspace: WorkspaceConfig = {
      id: wsId,
      name: 'UI State Viewport',
      description: '',
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',
      tools: [],
    };
    await storage.setWorkspace(wsId, workspace);
    await storage.setUIState(wsId, {
      panels: [
        { id: 'chat', type: 'chat', title: 'Chat' },
        { id: 'table-1', type: 'table', tableId: 't1', title: 'T1' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    await storage.updateUIState(wsId, (state) => {
      state.viewport = { x: 10, y: 20, zoom: 1.2 };
      return state;
    });

    const state = await storage.getUIState(wsId);
    assert.equal(state.panels.length, 2);
    assert.equal(state.viewport?.x, 10);
    assert.equal(state.viewport?.y, 20);
  });

  it('serializes updateUIState with addPanel to avoid panel loss', async () => {
    const wsId = 'ui-state-race';
    const now = new Date().toISOString();
    const workspace: WorkspaceConfig = {
      id: wsId,
      name: 'UI State Race',
      description: '',
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',
      tools: [],
    };
    await storage.setWorkspace(wsId, workspace);
    await storage.setUIState(wsId, {
      panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => resolve();
    });

    const updatePromise = storage.updateUIState(wsId, async (state) => {
      await gate;
      state.viewport = { x: 5, y: 6, zoom: 1.1 };
      return state;
    });

    const addPromise = storage.addPanel(wsId, {
      id: 'table-2',
      type: 'table',
      tableId: 't2',
      title: 'T2',
    });

    releaseGate();
    await Promise.all([updatePromise, addPromise]);

    const state = await storage.getUIState(wsId);
    assert.ok(state.panels.some((panel) => panel.id === 'table-2'));
    assert.equal(state.viewport?.x, 5);
    assert.equal(state.viewport?.y, 6);
  });
});
