import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { after, before, describe, it } from 'node:test';
import { createSandboxedStorage } from '../../src/lib/storage';
import { createReadTool } from '../../src/lib/tools/io/read';

describe('read tool', () => {
  const userId = randomBytes(16).toString('hex');
  const storage = createSandboxedStorage(userId);
  const workspaceId = 'ws-read';

  before(async () => {
    const now = new Date().toISOString();
    await storage.setWorkspace(workspaceId, {
      id: workspaceId,
      name: 'Read Tools',
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

  it('filters and limits table rows', async () => {
    await storage.setTable(workspaceId, 'people', {
      id: 'people',
      title: 'People',
      columns: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'age', label: 'Age', type: 'number' },
      ],
      data: [
        { name: 'Ada', age: 28 },
        { name: 'Grace', age: 36 },
        { name: 'Linus', age: 32 },
      ],
    });

    const readTool = createReadTool({ storage, workspaceId });
    const result = await readTool.handler({
      from: 'table:people',
      where: 'age >= 30',
      limit: 1,
    }, {});

    const text = result?.content?.[0]?.text ?? '[]';
    const data = JSON.parse(text) as Array<{ name: string; age: number }>;
    assert.equal(data.length, 1);
    assert.ok(data[0].age >= 30);
  });

  it('returns a not found message for missing files', async () => {
    const readTool = createReadTool({ storage, workspaceId });
    const result = await readTool.handler({ from: 'file:missing.txt' }, {});
    const text = result?.content?.[0]?.text ?? '';
    assert.match(text, /File "missing.txt" not found/);
  });
});
