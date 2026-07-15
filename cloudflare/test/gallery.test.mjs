import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getGalleryItem,
  listGalleryItems,
  publishWorkspace,
  unpublishGalleryItem,
} from '../src/lib/gallery.ts';
import { MockR2 } from './helpers/env.mjs';

const SESSION = 'a'.repeat(32);
const WORKSPACE = {
  id: 'b'.repeat(32),
  name: 'Workspace',
  description: 'Prompt',
  createdAt: '2026-07-14T00:00:00Z',
  updatedAt: '2026-07-14T00:00:00Z',
};
const STATE = {
  sessionId: SESSION,
  workspace: WORKSPACE,
  panels: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  groups: [],
  connections: [],
};

function env(r2, active = 'old', keys = { old: 'o'.repeat(32) }) {
  return {
    WORKSPACE_FILES: r2,
    SESSION_SECRET: 's'.repeat(32),
    GALLERY_OWNER_KEYS: JSON.stringify(keys),
    GALLERY_OWNER_ACTIVE_KEY_ID: active,
  };
}

async function publish(targetEnv, operationId) {
  return publishWorkspace({
    env: targetEnv,
    sessionId: SESSION,
    workspace: WORKSPACE,
    state: STATE,
    title: 'Public item',
    description: 'Description',
    operationId,
    files: [],
    readFile: async () => null,
  });
}

test('publish retries are idempotent and public records contain no owner identifier', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const first = await publish(targetEnv, 'operation-one');
  const second = await publish(targetEnv, 'operation-one');
  assert.equal(second.id, first.id);
  assert.equal(r2.keysWithPrefix('agent-studio/gallery/items/').filter((key) => key.endsWith('manifest.json')).length, 1);
  const manifest = await (await r2.get(`agent-studio/gallery/items/${first.id}/manifest.json`)).json();
  assert.equal('authorId' in manifest, false);
  assert.equal('authorId' in await getGalleryItem(targetEnv, first.id), false);
  assert.ok(await r2.get(`agent-studio/gallery/items/${first.id}/owner.json`));
});

test('a committed publish retry does not read files or delete the existing item', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const first = await publish(targetEnv, 'ambiguous-response');
  const second = await publishWorkspace({
    env: targetEnv,
    sessionId: SESSION,
    workspace: WORKSPACE,
    state: STATE,
    title: 'Changed retry payload',
    description: 'Must not replace committed data',
    operationId: 'ambiguous-response',
    files: [{ path: 'missing.txt', isDirectory: false }],
    readFile: async () => {
      throw new Error('retry must not read files after commit');
    },
  });
  assert.equal(second.id, first.id);
  assert.equal(second.title, first.title);
  assert.ok(await r2.get(`agent-studio/gallery/items/${first.id}/manifest.json`));
});

test('retained gallery owner keys authorize old records after active-key rotation', async () => {
  const r2 = new MockR2();
  const item = await publish(env(r2), 'rotation');
  const rotated = env(r2, 'new', { old: 'o'.repeat(32), new: 'n'.repeat(32) });
  await unpublishGalleryItem(rotated, item.id, SESSION);
  assert.equal(await r2.get(`agent-studio/gallery/items/${item.id}/manifest.json`), null);
});

test('gallery listing follows every R2 delimiter page', async () => {
  class PagedR2 extends MockR2 {
    async list(options = {}) {
      const full = await super.list({ ...options, cursor: undefined });
      const offset = Number(options.cursor ?? 0);
      const page = full.delimitedPrefixes.slice(offset, offset + 1);
      const next = offset + page.length;
      return {
        ...full,
        delimitedPrefixes: page,
        truncated: next < full.delimitedPrefixes.length,
        cursor: next < full.delimitedPrefixes.length ? String(next) : undefined,
      };
    }
  }
  const r2 = new PagedR2();
  const targetEnv = env(r2);
  await publish(targetEnv, 'page-one');
  await publish(targetEnv, 'page-two');
  assert.equal((await listGalleryItems(targetEnv)).length, 2);
});
