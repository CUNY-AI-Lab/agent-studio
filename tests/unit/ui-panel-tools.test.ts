import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { after, before, describe, it } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import {
  createAddPanelTool,
  createRemovePanelTool,
  createUpdatePanelTool,
} from '../../src/lib/tools/ui/panel';
import type { PanelUpdate } from '../../src/lib/tools/types';

describe('ui panel tools', () => {
  const userId = randomBytes(16).toString('hex');
  const storage = createSandboxedStorage(userId);
  const workspaceId = 'ws-panels';
  const updates: PanelUpdate[] = [];

  const makeContext = () => ({
    storage,
    workspaceId,
    emitPanelUpdates: (next: PanelUpdate[]) => updates.push(...next),
  });

  before(async () => {
    const now = new Date().toISOString();
    await storage.setWorkspace(workspaceId, {
      id: workspaceId,
      name: 'Panel Tools',
      description: '',
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',
      tools: [],
    });
  });

  after(async () => {
    await rm(path.join(storage.basePath), { recursive: true, force: true }).catch(() => {});
  });

  it('adds a panel and emits update', async () => {
    updates.length = 0;
    const addTool = createAddPanelTool(makeContext());
    await addTool.handler({ id: 'panel-add', type: 'markdown', title: 'Notes' }, {});

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'add');
    assert.equal(updates[0].panel.id, 'panel-add');

    const state = await storage.getUIState(workspaceId);
    assert.ok(state.panels.some((panel) => panel.id === 'panel-add'));
  });

  it('updates a panel and emits update', async () => {
    updates.length = 0;
    await storage.addPanel(workspaceId, {
      id: 'panel-update',
      type: 'markdown',
      title: 'Old title',
    });

    const updateTool = createUpdatePanelTool(makeContext());
    await updateTool.handler({ id: 'panel-update', title: 'New title' }, {});

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'update');
    assert.equal(updates[0].panel.title, 'New title');

    const state = await storage.getUIState(workspaceId);
    const panel = state.panels.find((item) => item.id === 'panel-update');
    assert.equal(panel?.title, 'New title');
  });

  it('removes a panel and emits update', async () => {
    updates.length = 0;
    await storage.addPanel(workspaceId, {
      id: 'panel-remove',
      type: 'markdown',
      title: 'Remove me',
    });

    const removeTool = createRemovePanelTool(makeContext());
    await removeTool.handler({ id: 'panel-remove' }, {});

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'remove');
    assert.equal(updates[0].panel.id, 'panel-remove');

    const state = await storage.getUIState(workspaceId);
    assert.equal(state.panels.some((panel) => panel.id === 'panel-remove'), false);
  });
});
