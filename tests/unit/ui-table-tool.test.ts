import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { after, before, describe, it } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import { createTableTool } from '../../src/lib/tools/ui/table';
import type { PanelUpdate } from '../../src/lib/tools/types';

describe('ui table tool', () => {
  const userId = randomBytes(16).toString('hex');
  const storage = createSandboxedStorage(userId);
  const workspaceId = 'ws-table';

  before(async () => {
    const now = new Date().toISOString();
    await storage.setWorkspace(workspaceId, {
      id: workspaceId,
      name: 'Table Tools',
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

  it('requires columns for a new table', async () => {
    const updates: PanelUpdate[] = [];
    const tableTool = createTableTool({
      storage,
      workspaceId,
      emitPanelUpdates: (next) => updates.push(...next),
    });

    const result = await tableTool.handler({ id: 't1', title: 'Table 1' }, {});
    const text = result?.content?.[0]?.text ?? '';
    assert.match(text, /Columns are required/);
    assert.equal(updates.length, 0);
    const table = await storage.getTable(workspaceId, 't1');
    assert.equal(table, null);
  });

  it('updates table panels when data changes', async () => {
    const updates: PanelUpdate[] = [];
    await storage.addPanel(workspaceId, {
      id: 'table-t2',
      type: 'table',
      title: 'Table 2',
      tableId: 't2',
    });

    const tableTool = createTableTool({
      storage,
      workspaceId,
      emitPanelUpdates: (next) => updates.push(...next),
    });

    await tableTool.handler({
      id: 't2',
      title: 'Table 2',
      columns: [{ key: 'name', label: 'Name', type: 'text' }],
      data: [{ name: 'Ada' }],
    }, {});

    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'update');
    assert.equal(updates[0].panel.id, 'table-t2');
    assert.equal(updates[0].data?.table?.data.length, 1);

    const table = await storage.getTable(workspaceId, 't2');
    assert.ok(table);
    assert.equal(table?.data.length, 1);
  });
});
