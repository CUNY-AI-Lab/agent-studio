import assert from 'assert';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { createSandboxedStorage } from '../../src/lib/storage';
import { describe, it, after } from 'node:test';

function randomUserId() {
  return randomBytes(16).toString('hex');
}

describe('storage sandbox', () => {
  const userId = randomUserId();
  const storage = createSandboxedStorage(userId);
  const wsId = 'testws';

  after(async () => {
    // Cleanup user data directory
    await rm(path.join(storage.basePath), { recursive: true, force: true }).catch(() => {});
  });

  it('prevents path traversal when writing files', async () => {
    await assert.rejects(
      storage.writeFile(wsId, '../hack.txt', 'nope'),
      /Path traversal detected/
    );
  });

  it('writes and reads a file inside workspace files directory', async () => {
    await storage.writeFile(wsId, 'hello.txt', 'world');
    const content = await storage.readFile(wsId, 'hello.txt');
    assert.equal(content, 'world');
  });

  it('lists files with metadata and sorts directories first', async () => {
    await storage.writeFile(wsId, 'a.txt', '1');
    await storage.writeFile(wsId, 'b.txt', '2');
    const files = await storage.listFiles(wsId);
    // Expect at least hello.txt, a.txt, b.txt
    const names = files.map(f => f.name);
    assert.ok(names.includes('hello.txt'));
    assert.ok(names.includes('a.txt'));
    assert.ok(names.includes('b.txt'));
  });

  it('tables round trip', async () => {
    await storage.setTable(wsId, 't1', {
      id: 't1',
      title: 'T1',
      columns: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'year', label: 'Year', type: 'number' },
      ],
      data: [{ title: 'A', year: 2020 }],
    });
    const t = await storage.getTable(wsId, 't1');
    assert.ok(t);
    assert.equal(t?.data.length, 1);
  });
});
