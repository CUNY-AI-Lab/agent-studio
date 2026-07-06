// Regression coverage for the downloads.json lost-write race (AS-2-4).
//
// The old addWorkspaceDownload did R2 get -> array.push -> put with no
// compare-and-set, so two concurrent adds could read the same base array and
// the second put would clobber the first's entry. Downloads are now stored as
// individual per-object R2 entries under a `downloads/` prefix, so concurrent
// appends are independent PUTs and both survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MockR2 } from './helpers/env.mjs';
import {
  addWorkspaceDownload,
  getWorkspaceDownloads,
  clearWorkspaceDownloads,
  putWorkspaceDownloads,
} from '../src/lib/downloads.ts';

const SESSION = 'sess-1';
const WS = 'ws-1';

function envWith(r2) {
  return { WORKSPACE_FILES: r2 };
}

test('two concurrent addWorkspaceDownload calls both survive', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  await Promise.all([
    addWorkspaceDownload(env, SESSION, WS, { filename: 'a.txt', format: 'txt', data: 'a' }),
    addWorkspaceDownload(env, SESSION, WS, { filename: 'b.txt', format: 'txt', data: 'b' }),
  ]);

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.equal(downloads.length, 2, 'both concurrent downloads must persist');
  const names = downloads.map((d) => d.filename).sort();
  assert.deepEqual(names, ['a.txt', 'b.txt']);
});

test('many concurrent adds all survive', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  const count = 25;
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      addWorkspaceDownload(env, SESSION, WS, { filename: `f${i}.txt`, format: 'txt', data: i })
    )
  );

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.equal(downloads.length, count);
  const names = new Set(downloads.map((d) => d.filename));
  assert.equal(names.size, count, 'no entries lost or collided');
});

test('sequential adds preserve insertion order', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  for (const name of ['first', 'second', 'third']) {
    await addWorkspaceDownload(env, SESSION, WS, { filename: name, format: 'txt', data: name });
  }

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.deepEqual(downloads.map((d) => d.filename), ['first', 'second', 'third']);
});

test('clearWorkspaceDownloads removes all entries', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  await addWorkspaceDownload(env, SESSION, WS, { filename: 'a.txt', format: 'txt', data: 'a' });
  await addWorkspaceDownload(env, SESSION, WS, { filename: 'b.txt', format: 'txt', data: 'b' });
  await clearWorkspaceDownloads(env, SESSION, WS);

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.deepEqual(downloads, []);
});

test('legacy downloads.json blob is still readable (backward-read)', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  // Simulate a pre-migration single-blob workspace.
  await r2.put(
    `agent-studio/sessions/${SESSION}/workspaces/${WS}/downloads.json`,
    JSON.stringify([{ filename: 'legacy.txt', format: 'txt', data: 'old' }])
  );

  // A new per-object add lands alongside the legacy blob.
  await addWorkspaceDownload(env, SESSION, WS, { filename: 'new.txt', format: 'txt', data: 'new' });

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.deepEqual(downloads.map((d) => d.filename), ['legacy.txt', 'new.txt']);

  // Clearing also drops the legacy blob.
  await clearWorkspaceDownloads(env, SESSION, WS);
  assert.deepEqual(await getWorkspaceDownloads(env, SESSION, WS), []);
});

test('putWorkspaceDownloads replaces the set (migration helper)', async () => {
  const r2 = new MockR2();
  const env = envWith(r2);

  await addWorkspaceDownload(env, SESSION, WS, { filename: 'stale.txt', format: 'txt', data: 'x' });
  await putWorkspaceDownloads(env, SESSION, WS, [
    { filename: 'one.txt', format: 'txt', data: '1' },
    { filename: 'two.txt', format: 'txt', data: '2' },
  ]);

  const downloads = await getWorkspaceDownloads(env, SESSION, WS);
  assert.deepEqual(downloads.map((d) => d.filename), ['one.txt', 'two.txt']);
});
