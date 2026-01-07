import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { after, before, describe, it } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import { createExecuteTool } from '../../src/lib/tools/code/execute';
import { extractPanelUpdates } from '../../src/lib/runtime';

describe('execute tool', () => {
  const userId = randomBytes(16).toString('hex');
  const storage = createSandboxedStorage(userId);
  const workspaceId = 'ws-test';
  const executeTool = createExecuteTool({ storage, workspaceId });

  const run = async (code: string): Promise<string> => {
    const result = await executeTool.handler({ code } as unknown as { code: string }, {});
    const content = (result as { content?: Array<{ type: string; text: string }> }).content;
    const textBlock = content?.find((block) => block.type === 'text');
    return textBlock?.text ?? '';
  };

  before(async () => {
    const now = new Date().toISOString();
    await storage.setWorkspace(workspaceId, {
      id: workspaceId,
      name: 'Test Workspace',
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

  it('completes when code has no explicit return value', async () => {
    const text = await run(`
      await setTable("t1", { data: [{ a: 1 }] });
    `);

    assert.equal(text.includes('Execution timed out'), false);
    assert.equal(text.includes('Error:'), false);
    assert.match(text, /Done/);
  });

  it('clears panel updates between runs and emits updatePanel events', async () => {
    const first = await run(`
      await setTable("t2", { data: [{ a: 1 }] });
    `);
    const firstUpdates = extractPanelUpdates(first).panelUpdates;
    assert.equal(firstUpdates.length, 1);
    assert.equal(firstUpdates[0].action, 'add');

    const second = await run(`
      await updatePanel("table-t2", { title: "Renamed" });
    `);
    const secondUpdates = extractPanelUpdates(second).panelUpdates;
    assert.equal(secondUpdates.length, 1);
    assert.equal(secondUpdates[0].action, 'update');
    assert.equal(secondUpdates[0].panel.id, 'table-t2');
  });

  it('blocks loopback fetch targets', async () => {
    const text = await run(`
      try {
        await fetch("http://[::1]/");
        return "allowed";
      } catch (e) {
        return e?.message || String(e);
      }
    `);

    assert.match(text, /Access to internal networks is not allowed/);
  });

  it('auto-adds chart panels with updates', async () => {
    const text = await run(`
      await setChart("sales", {
        type: "bar",
        data: [{ month: "Jan", value: 10 }],
        xKey: "month",
        yKey: "value"
      });
    `);

    const updates = extractPanelUpdates(text).panelUpdates;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'add');
    assert.equal(updates[0].panel.type, 'chart');
    assert.equal(updates[0].panel.chartId, 'sales');
  });

  it('auto-adds cards panels with updates', async () => {
    const text = await run(`
      await setCards("team", {
        title: "Team",
        items: [
          { title: "Alice", subtitle: "Engineer" },
          { title: "Bob", subtitle: "Designer" }
        ]
      });
    `);

    const updates = extractPanelUpdates(text).panelUpdates;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].action, 'add');
    assert.equal(updates[0].panel.type, 'cards');
    assert.equal(updates[0].panel.cardsId, 'team');
  });
});
