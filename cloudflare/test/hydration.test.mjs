import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hydrateLegacyWorkspaceFiles } from '../src/lib/hydration.ts';
import { getWorkspaceFilesPrefix } from '../src/lib/files.ts';
import { MockR2 } from './helpers/env.mjs';

const SESSION = 'a'.repeat(32);
const WORKSPACE = 'workspace-one';

class FakeRuntime {
  constructor() {
    this.files = new Map();
  }

  async lstat(path) {
    return this.files.has(path) ? { type: 'file' } : null;
  }

  async writeFileBytes(path, bytes, contentType) {
    this.files.set(path, { bytes: new Uint8Array(bytes), contentType });
  }
}

function makeEnv(r2) {
  return {
    WORKSPACE_FILES: r2,
    CAIL_LOG_ENV: 'test',
    CAIL_FLEET_EVENTS: { writeDataPoint() {} },
    CF_VERSION_METADATA: {
      id: '11111111-1111-4111-8111-111111111111',
      tag: '',
      timestamp: '2026-07-13T14:00:00Z',
    },
  };
}

function legacyKey(path) {
  return `${getWorkspaceFilesPrefix(SESSION, WORKSPACE)}${path}`;
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

test('hydrateLegacyWorkspaceFiles rejects when a listed legacy file cannot be read and leaves legacy data intact', async () => {
  const r2 = new MockR2();
  await r2.put(legacyKey('readable.txt'), 'ok');
  await r2.put(legacyKey('missing.txt'), 'gone');
  const originalGet = r2.get.bind(r2);
  r2.get = async (key) => (key === legacyKey('missing.txt') ? null : originalGet(key));
  const runtime = new FakeRuntime();

  await assert.rejects(
    hydrateLegacyWorkspaceFiles(makeEnv(r2), SESSION, WORKSPACE, runtime),
    /workspace-one.*missing\.txt/,
  );

  assert.deepEqual(r2.keysWithPrefix(getWorkspaceFilesPrefix(SESSION, WORKSPACE)), [
    legacyKey('missing.txt'),
    legacyKey('readable.txt'),
  ]);
  assert.equal(runtime.files.size, 1);
  assert.equal(text(runtime.files.get('/readable.txt').bytes), 'ok');
});

test('hydrateLegacyWorkspaceFiles copies all legacy files then deletes the legacy prefix', async () => {
  const r2 = new MockR2();
  await r2.put(legacyKey('notes.md'), '# hi');
  await r2.put(legacyKey('dir/inner.txt'), 'inner', {
    httpMetadata: { contentType: 'text/custom' },
  });
  const runtime = new FakeRuntime();

  const result = await hydrateLegacyWorkspaceFiles(makeEnv(r2), SESSION, WORKSPACE, runtime);

  assert.deepEqual(result, { copied: 2, skipped: 0 });
  assert.equal(text(runtime.files.get('/notes.md').bytes), '# hi');
  assert.equal(runtime.files.get('/notes.md').contentType, 'text/markdown; charset=utf-8');
  assert.equal(text(runtime.files.get('/dir/inner.txt').bytes), 'inner');
  assert.equal(runtime.files.get('/dir/inner.txt').contentType, 'text/custom');
  assert.deepEqual(r2.keysWithPrefix(getWorkspaceFilesPrefix(SESSION, WORKSPACE)), []);
});

test('hydrateLegacyWorkspaceFiles skips existing runtime paths without overwriting them', async () => {
  const r2 = new MockR2();
  await r2.put(legacyKey('keep.txt'), 'legacy');
  await r2.put(legacyKey('copy.txt'), 'copy me');
  const runtime = new FakeRuntime();
  await runtime.writeFileBytes('/keep.txt', new TextEncoder().encode('runtime'), 'text/plain');

  const result = await hydrateLegacyWorkspaceFiles(makeEnv(r2), SESSION, WORKSPACE, runtime);

  assert.deepEqual(result, { copied: 1, skipped: 1 });
  assert.equal(text(runtime.files.get('/keep.txt').bytes), 'runtime');
  assert.equal(text(runtime.files.get('/copy.txt').bytes), 'copy me');
  assert.deepEqual(r2.keysWithPrefix(getWorkspaceFilesPrefix(SESSION, WORKSPACE)), []);
});

test('hydrateLegacyWorkspaceFiles resolves empty legacy prefixes without deleting', async () => {
  const r2 = new MockR2();
  await r2.put('unrelated/key.txt', 'stay');
  let deleteCalls = 0;
  const originalDelete = r2.delete.bind(r2);
  r2.delete = async (...args) => {
    deleteCalls += 1;
    return originalDelete(...args);
  };
  const runtime = new FakeRuntime();

  const result = await hydrateLegacyWorkspaceFiles(makeEnv(r2), SESSION, WORKSPACE, runtime);

  assert.deepEqual(result, { copied: 0, skipped: 0 });
  assert.equal(deleteCalls, 0);
  assert.deepEqual([...r2.store.keys()], ['unrelated/key.txt']);
});

test('hydrateLegacyWorkspaceFiles ignores legacy files after the import deadline', async (t) => {
  const r2 = new MockR2();
  await r2.put(legacyKey('expired.txt'), 'do not hydrate');
  const runtime = new FakeRuntime();
  const env = {
    ...makeEnv(r2),
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_SSO_SWITCHED_AT: '2026-07-01T00:00:00Z',
    CAIL_ACCOUNT_IMPORT_UNTIL: '2026-07-02T00:00:00Z',
  };

  const warnings = t.mock.method(console, 'warn', () => {});
  const result = await hydrateLegacyWorkspaceFiles(
    env,
    SESSION,
    WORKSPACE,
    runtime,
    Date.parse('2026-07-02T00:00:00.001Z')
  );

  assert.deepEqual(result, { copied: 0, skipped: 0 });
  assert.equal(runtime.files.size, 0);
  assert.ok(await r2.get(legacyKey('expired.txt')), 'ignored legacy data must not be deleted');
  assert.equal(warnings.mock.callCount(), 1);
});
