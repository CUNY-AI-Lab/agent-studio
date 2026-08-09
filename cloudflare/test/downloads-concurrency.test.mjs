import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addWorkspaceDownload,
  clearWorkspaceDownloads,
  getWorkspaceDownloads,
  putWorkspaceDownloads,
} from '../src/lib/downloads.ts';
import { MockR2 } from './helpers/env.mjs';

const SESSION = 'a'.repeat(32);
const WORKSPACE = 'b'.repeat(32);

function env() {
  return { WORKSPACE_FILES: new MockR2() };
}

test('concurrent download appends preserve every item', async () => {
  const current = env();
  const downloads = Array.from({ length: 40 }, (_, index) => ({
    filename: `item-${index}.txt`,
    format: 'txt',
    data: `value-${index}`,
  }));
  await Promise.all(downloads.map((download) =>
    addWorkspaceDownload(current, SESSION, WORKSPACE, download)));

  const stored = await getWorkspaceDownloads(current, SESSION, WORKSPACE);
  assert.equal(stored.length, downloads.length);
  assert.deepEqual(
    new Set(stored.map((download) => download.filename)),
    new Set(downloads.map((download) => download.filename)),
  );
});

test('clear removes the current per-object queue', async () => {
  const current = env();
  await addWorkspaceDownload(current, SESSION, WORKSPACE, {
    filename: 'one.txt', format: 'txt', data: 'one',
  });
  await clearWorkspaceDownloads(current, SESSION, WORKSPACE);
  assert.deepEqual(await getWorkspaceDownloads(current, SESSION, WORKSPACE), []);
});

test('normal reads skip corrupt entries while account import fails loud', async () => {
  const current = env();
  const prefix = `agent-studio/sessions/${SESSION}/workspaces/${WORKSPACE}/downloads/`;
  await current.WORKSPACE_FILES.put(`${prefix}corrupt.json`, '{not json');
  await addWorkspaceDownload(current, SESSION, WORKSPACE, {
    filename: 'readable.txt', format: 'txt', data: 'readable',
  });

  assert.deepEqual(
    (await getWorkspaceDownloads(current, SESSION, WORKSPACE))
      .map((download) => download.filename),
    ['readable.txt'],
  );
  await assert.rejects(
    getWorkspaceDownloads(current, SESSION, WORKSPACE, { onCorrupt: 'throw' }),
    /corrupt stored download object/,
  );
});

test('import replacement uses deterministic keys so retries cannot duplicate items', async () => {
  const current = env();
  const downloads = [
    { filename: 'one.txt', format: 'txt', data: 'one' },
    { filename: 'two.csv', format: 'csv', data: 'a,b' },
  ];
  await putWorkspaceDownloads(current, SESSION, WORKSPACE, downloads);
  const firstKeys = current.WORKSPACE_FILES.keysWithPrefix(
    `agent-studio/sessions/${SESSION}/workspaces/${WORKSPACE}/downloads/`,
  );
  await putWorkspaceDownloads(current, SESSION, WORKSPACE, downloads.slice(0, 1));
  assert.equal(firstKeys.length, 2);
  assert.deepEqual(await getWorkspaceDownloads(current, SESSION, WORKSPACE), downloads.slice(0, 1));
});
