import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getGalleryItem,
  listGalleryItemsPage,
  publishWorkspace,
  reassignGalleryAuthor,
  unpublishGalleryItem,
} from '../src/lib/gallery.ts';
import { listGalleryFilesRecursive } from '../src/lib/files.ts';
import { MockR2, seedGalleryItem } from './helpers/env.mjs';

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

function env(r2) {
  return {
    WORKSPACE_FILES: r2,
    SESSION_SECRET: 's'.repeat(32),
  };
}

async function publish(targetEnv, operationId) {
  return publishWorkspace({
    env: targetEnv,
    sessionId: SESSION,
    workspace: WORKSPACE,
    state: STATE,
    title: 'Shared item',
    description: 'Description',
    operationId,
    files: [],
    readFile: async () => null,
  });
}

test('publish retries are idempotent and shared records contain no owner identifier', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const first = await publish(targetEnv, 'operation-one');
  const second = await publish(targetEnv, 'operation-one');
  assert.equal(second.id, first.id);
  assert.equal(r2.keysWithPrefix('agent-studio/gallery/items/').filter((key) => key.endsWith('manifest.json')).length, 1);
  const manifest = await (await r2.get(`agent-studio/gallery/items/${first.id}/manifest.json`)).json();
  assert.equal('authorId' in manifest, false);
  assert.equal('prompt' in manifest, false);
  const publishedState = await (await r2.get(`agent-studio/gallery/items/${first.id}/state.json`)).json();
  assert.deepEqual(publishedState.workspace, {
    id: '',
    name: first.title,
    description: first.description,
    createdAt: first.publishedAt,
    updatedAt: first.publishedAt,
  });
  assert.equal('authorId' in await getGalleryItem(targetEnv, first.id), false);
  assert.equal('prompt' in await getGalleryItem(targetEnv, first.id), false);
  assert.ok(await r2.get(`agent-studio/gallery/items/${first.id}/owner.json`));
});

test('gallery reads project legacy manifests and workspace metadata into the public shape', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const galleryId = 'legacy-redaction';
  const publishedAt = '2026-08-01T00:00:00.000Z';
  await r2.put(
    `agent-studio/gallery/items/${galleryId}/manifest.json`,
    JSON.stringify({
      id: galleryId,
      title: 'Public title',
      description: 'Public description',
      prompt: 'PRIVATE_PROMPT_SENTINEL',
      authorId: 'PRIVATE_OWNER_SENTINEL',
      privateMetadata: 'PRIVATE_MANIFEST_SENTINEL',
      publishedAt,
      artifactCount: 1,
    }),
  );
  await r2.put(
    `agent-studio/gallery/items/${galleryId}/state.json`,
    JSON.stringify({
      sessionId: 'PRIVATE_SESSION_SENTINEL',
      workspace: {
        id: 'PRIVATE_WORKSPACE_SENTINEL',
        name: 'Private workspace name',
        description: 'PRIVATE_WORKSPACE_SENTINEL',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
        galleryId: 'PRIVATE_GALLERY_SENTINEL',
        model: 'PRIVATE_MODEL_SENTINEL',
      },
      panels: [{ id: 'artifact', type: 'markdown', content: 'SYNTHETIC_ARTIFACT' }],
      viewport: { x: 1, y: 2, zoom: 0.5 },
      groups: [{ id: 'group', panelIds: ['artifact'] }],
      connections: [],
      privateState: 'PRIVATE_STATE_SENTINEL',
    }),
  );

  const expected = {
    id: galleryId,
    title: 'Public title',
    description: 'Public description',
    publishedAt,
    artifactCount: 1,
  };
  const item = await getGalleryItem(targetEnv, galleryId);
  assert.deepEqual(item, {
    ...expected,
    state: {
      sessionId: null,
      workspace: {
        id: '',
        name: expected.title,
        description: expected.description,
        createdAt: publishedAt,
        updatedAt: publishedAt,
      },
      panels: [{ id: 'artifact', type: 'markdown', content: 'SYNTHETIC_ARTIFACT' }],
      viewport: { x: 1, y: 2, zoom: 0.5 },
      groups: [{ id: 'group', panelIds: ['artifact'] }],
      connections: [],
    },
  });
  assert.deepEqual(await listGalleryItemsPage(targetEnv), { items: [expected] });

  // Reads project old records without a migration or storage rewrite.
  const persistedManifest = await (await r2.get(`agent-studio/gallery/items/${galleryId}/manifest.json`)).json();
  const persistedState = await (await r2.get(`agent-studio/gallery/items/${galleryId}/state.json`)).json();
  assert.equal(persistedManifest.prompt, 'PRIVATE_PROMPT_SENTINEL');
  assert.equal(persistedState.workspace.description, 'PRIVATE_WORKSPACE_SENTINEL');
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

test('a retry clears artifacts left by a failed publish cleanup before committing', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const operationId = 'cleanup-retry';
  const originalPut = r2.put.bind(r2);
  const originalDelete = r2.delete.bind(r2);
  let failStatePut = true;
  let failCleanupDelete = true;
  r2.put = async (key, value, options = {}) => {
    if (failStatePut && key.endsWith('/state.json')) {
      failStatePut = false;
      throw new Error('injected state write failure');
    }
    return originalPut(key, value, options);
  };
  r2.delete = async (keys) => {
    if (failCleanupDelete) {
      failCleanupDelete = false;
      throw new Error('injected cleanup failure');
    }
    return originalDelete(keys);
  };

  await assert.rejects(
    publishWorkspace({
      env: targetEnv,
      sessionId: SESSION,
      workspace: WORKSPACE,
      state: STATE,
      title: 'Retry me',
      description: 'First attempt fails',
      operationId,
      files: [{ path: 'stale.md', isDirectory: false }],
      readFile: async () => ({
        contentType: 'text/markdown; charset=utf-8',
        data: new TextEncoder().encode('stale').buffer,
      }),
    }),
  );

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${SESSION}:${WORKSPACE.id}:${operationId}`),
  );
  const galleryId = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(
    r2.keysWithPrefix(`agent-studio/gallery/items/${galleryId}/files/`),
    [`agent-studio/gallery/items/${galleryId}/files/stale.md`],
    'failure injection must leave a stale artifact for the retry to clean',
  );

  await publish(targetEnv, operationId);
  assert.deepEqual(
    await listGalleryFilesRecursive(targetEnv, galleryId),
    [],
    'a successful retry must not expose the prior attempt\'s file',
  );
  assert.deepEqual(
    r2.keysWithPrefix(`agent-studio/gallery/items/${galleryId}/`).sort(),
    [
      `agent-studio/gallery/items/${galleryId}/manifest.json`,
      `agent-studio/gallery/items/${galleryId}/owner.json`,
      `agent-studio/gallery/items/${galleryId}/state.json`,
    ],
  );
});

test('private owner records authorize unpublish without exposing an owner identifier', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const item = await publish(targetEnv, 'private-owner');
  await unpublishGalleryItem(targetEnv, item.id, SESSION);
  assert.equal(await r2.get(`agent-studio/gallery/items/${item.id}/manifest.json`), null);
});

test('gallery listing returns a cursor for the next R2 delimiter page', async () => {
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
  const firstItem = await publish(targetEnv, 'page-one');
  const secondItem = await publish(targetEnv, 'page-two');
  const firstPage = await listGalleryItemsPage(targetEnv, { limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await listGalleryItemsPage(targetEnv, {
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, undefined);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map((item) => item.id).sort(),
    [firstItem.id, secondItem.id].sort(),
  );
});

test('gallery reassignment skips malformed legacy author ids', async () => {
  const r2 = new MockR2();
  const targetEnv = env(r2);
  const galleryId = 'c'.repeat(24);
  seedGalleryItem(r2, galleryId, null);
  const result = await reassignGalleryAuthor(targetEnv, SESSION, 'd'.repeat(32));
  assert.equal(result, 0);
  const manifest = await (await r2.get(`agent-studio/gallery/items/${galleryId}/manifest.json`)).json();
  assert.equal(manifest.authorId, null);
  assert.equal(await r2.get(`agent-studio/gallery/items/${galleryId}/owner.json`), null);
});
