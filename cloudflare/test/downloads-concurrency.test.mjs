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

test('expired compatibility ignores legacy downloads.json but keeps current entries', async () => {
  const r2 = new MockR2();
  const env = {
    ...envWith(r2),
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_SSO_SWITCHED_AT: '2026-07-01T00:00:00Z',
    CAIL_ACCOUNT_IMPORT_UNTIL: '2026-07-02T00:00:00Z',
  };
  await r2.put(
    `agent-studio/sessions/${SESSION}/workspaces/${WS}/downloads.json`,
    JSON.stringify([{ filename: 'legacy.txt', format: 'txt', data: 'old' }])
  );
  await addWorkspaceDownload(env, SESSION, WS, {
    filename: 'current.txt',
    format: 'txt',
    data: 'current',
  });

  const downloads = await getWorkspaceDownloads(env, SESSION, WS, {
    now: Date.parse('2026-07-02T00:00:00.001Z'),
  });
  assert.deepEqual(downloads.map((download) => download.filename), ['current.txt']);
});

// ---------------------------------------------------------------------------
// Corrupt-object observability (readJson-swallow regression, fallback rule):
// a parse failure on an object that EXISTS must never be silently read as
// "record absent". Default reads stay resilient but emit a structured
// `downloads.corrupt` wide event per corrupt object (metadata only — the R2
// key embeds session/workspace ids and a filename, so it stays OUT of the
// log; the 'throw' path keeps it in the thrown Error). onCorrupt: 'throw'
// (the migration mode) propagates instead of returning empty.
// ---------------------------------------------------------------------------

const LEGACY_KEY = `agent-studio/sessions/${SESSION}/workspaces/${WS}/downloads.json`;

function corruptEventsFrom(logMock) {
  return logMock.mock.calls
    .map((call) => call.arguments[0])
    .filter((event) => event && event['event.name'] === 'agent_studio.download.corrupt');
}

test('corrupt legacy downloads.json emits a structured event, not silently read as empty', async (t) => {
  const r2 = new MockR2();
  const env = envWith(r2);
  await r2.put(LEGACY_KEY, '{not valid json');
  await addWorkspaceDownload(env, SESSION, WS, { filename: 'ok.txt', format: 'txt', data: 'ok' });

  const logs = t.mock.method(console, 'error', () => {});
  const downloads = await getWorkspaceDownloads(env, SESSION, WS);

  // Listing stays up (one bad object cannot take it down)...
  assert.deepEqual(downloads.map((d) => d.filename), ['ok.txt']);
  // ...but the corruption is visible as a structured wide event — and the R2
  // key (session/workspace ids + filename) never reaches the log line.
  const events = corruptEventsFrom(logs);
  assert.equal(events.length, 1);
  assert.equal(events[0]['error.type'], 'corrupt_download_object');
  assert.equal(events[0]['cail.outcome'], 'error');
  assert.equal(events[0].severity_number >= 17, true);
  for (const call of logs.mock.calls) {
    assert.ok(!JSON.stringify(call.arguments[0]).includes(LEGACY_KEY), 'R2 key leaked into a log line');
  }
});

test('corrupt per-object downloads emit one event each and are skipped; good entries survive', async (t) => {
  const r2 = new MockR2();
  const env = envWith(r2);
  await addWorkspaceDownload(env, SESSION, WS, { filename: 'good.txt', format: 'txt', data: 'g' });
  const prefix = `agent-studio/sessions/${SESSION}/workspaces/${WS}/downloads/`;
  const badParseKey = `${prefix}0000000000000000-bad-parse.json`;
  const badShapeKey = `${prefix}0000000000000001-bad-shape.json`;
  await r2.put(badParseKey, '{truncated');
  await r2.put(badShapeKey, JSON.stringify({ seq: 1, createdAt: 'x' })); // no download payload

  const logs = t.mock.method(console, 'error', () => {});
  const downloads = await getWorkspaceDownloads(env, SESSION, WS);

  assert.deepEqual(downloads.map((d) => d.filename), ['good.txt']);
  assert.equal(corruptEventsFrom(logs).length, 2);
  for (const call of logs.mock.calls) {
    const line = JSON.stringify(call.arguments[0]);
    assert.ok(!line.includes(badParseKey) && !line.includes(badShapeKey), 'R2 key leaked into a log line');
  }
});

test("onCorrupt: 'throw' propagates a corrupt legacy blob instead of reading it as empty", async (t) => {
  const r2 = new MockR2();
  const env = envWith(r2);
  await r2.put(LEGACY_KEY, '{not valid json');

  t.mock.method(console, 'error', () => {});
  await assert.rejects(
    getWorkspaceDownloads(env, SESSION, WS, { onCorrupt: 'throw' }),
    /corrupt stored download object at .*downloads\.json/
  );
});

test("onCorrupt: 'throw' propagates a corrupt per-object entry", async (t) => {
  const r2 = new MockR2();
  const env = envWith(r2);
  const prefix = `agent-studio/sessions/${SESSION}/workspaces/${WS}/downloads/`;
  await r2.put(`${prefix}0000000000000000-bad.json`, '{truncated');

  t.mock.method(console, 'error', () => {});
  await assert.rejects(
    getWorkspaceDownloads(env, SESSION, WS, { onCorrupt: 'throw' }),
    /corrupt stored download object/
  );
});

test('a genuinely absent legacy blob is still plain emptiness — no log, no throw', async (t) => {
  const r2 = new MockR2();
  const env = envWith(r2);

  const errors = t.mock.method(console, 'error', () => {});
  assert.deepEqual(await getWorkspaceDownloads(env, SESSION, WS, { onCorrupt: 'throw' }), []);
  assert.equal(errors.mock.callCount(), 0);
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
