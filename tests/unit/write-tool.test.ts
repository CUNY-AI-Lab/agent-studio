import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { after, before, describe, it } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import { createWriteTool } from '../../src/lib/tools/io/write';
import type { PanelUpdate } from '../../src/lib/tools/types';

describe('write tool', () => {
  const userId = randomBytes(16).toString('hex');
  const storage = createSandboxedStorage(userId);
  const workspaceId = 'ws-write';

  before(async () => {
    const now = new Date().toISOString();
    await storage.setWorkspace(workspaceId, {
      id: workspaceId,
      name: 'Write Tools',
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

  it('writes to tables and emits updates', async () => {
    const updates: PanelUpdate[] = [];
    await storage.addPanel(workspaceId, {
      id: 'table-items',
      type: 'table',
      title: 'Items',
      tableId: 'items',
    });

    const writeTool = createWriteTool({
      storage,
      workspaceId,
      emitPanelUpdates: (next) => updates.push(...next),
    });

    await writeTool.handler({
      to: 'table:items',
      data: [{ name: 'Widget', qty: 2 }],
      mode: 'replace',
    }, {});

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'update');
    assert.equal(updates[0].panel.id, 'table-items');
    assert.equal(updates[0].data?.table?.data.length, 1);
    assert.ok(updates[0].data?.table?.columns.some((col) => col.key === 'name'));

    const table = await storage.getTable(workspaceId, 'items');
    assert.ok(table);
    assert.equal(table?.data.length, 1);
  });

  it('writes and appends to files', async () => {
    const writeTool = createWriteTool({ storage, workspaceId });

    await writeTool.handler({ to: 'file:notes.txt', data: 'Hello', mode: 'replace' }, {});
    await writeTool.handler({ to: 'file:notes.txt', data: 'World', mode: 'append' }, {});

    const content = await storage.readFile(workspaceId, 'notes.txt');
    assert.equal(content, 'HelloWorld');
  });
});
