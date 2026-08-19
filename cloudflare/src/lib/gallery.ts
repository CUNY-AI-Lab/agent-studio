import { z } from 'zod';
import type { GalleryItem, GalleryItemFull } from '../domain/gallery';
import type { WorkspaceRecord, WorkspaceState } from '../domain/workspace';
import type { Env } from '../env';
import {
  deleteByPrefix,
  getGalleryFileKey,
  getGalleryPrefix,
  getMimeType,
} from './files';
import { timingSafeEqual } from './csrf';
import { nextR2Cursor } from './r2-pagination';

export class GalleryError extends Error {
  constructor(message: string, readonly status: 403 | 404) {
    super(message);
  }
}

function galleryManifestKey(id: string): string {
  return `${getGalleryPrefix(id)}manifest.json`;
}

function galleryStateKey(id: string): string {
  return `${getGalleryPrefix(id)}state.json`;
}

function galleryOwnerKey(id: string): string {
  return `${getGalleryPrefix(id)}owner.json`;
}

interface GalleryOwnerRecord {
  tag: string;
}

interface GalleryListOptions {
  prefix: string;
  delimiter: string;
  limit?: number;
  cursor?: string;
}

interface GalleryItemsPage {
  items: GalleryItem[];
  nextCursor?: string;
}

async function galleryOwnerRecord(env: Env, sessionId: string): Promise<GalleryOwnerRecord> {
  return {
    tag: await galleryOwnerTag(sessionId, env.SESSION_SECRET),
  };
}

async function ownerRecordMatches(env: Env, record: GalleryOwnerRecord, sessionId: string): Promise<boolean> {
  const tag = z.string().safeParse(record.tag).data;
  return tag !== undefined
    && timingSafeEqual(tag, await galleryOwnerTag(sessionId, env.SESSION_SECRET));
}

function publicGalleryItem(item: GalleryItem): GalleryItem {
  const { authorId: _legacyOwner, ...publicItem } = item;
  return publicItem;
}

async function listGalleryIds(env: Env): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const listOptions: GalleryListOptions = {
      prefix: getGalleryPrefix(),
      delimiter: '/',
    };
    if (cursor) listOptions.cursor = cursor;
    const listing = await env.WORKSPACE_FILES.list(listOptions);
    for (const prefix of listing.delimitedPrefixes) {
      const id = prefix.slice(getGalleryPrefix().length).replace(/\/$/, '');
      if (id) ids.add(id);
    }
    cursor = nextR2Cursor(listing, 'gallery listing');
  } while (cursor);
  return [...ids];
}

export async function listGalleryItemsPage(
  env: Env,
  options: { cursor?: string; limit?: number } = {},
): Promise<GalleryItemsPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const listOptions: GalleryListOptions = {
    prefix: getGalleryPrefix(),
    delimiter: '/',
    limit,
  };
  if (options.cursor) listOptions.cursor = options.cursor;
  const listing = await env.WORKSPACE_FILES.list(listOptions);
  const nextCursor = nextR2Cursor(listing, 'gallery page');
  const items = await Promise.all(listing.delimitedPrefixes.map(async (prefix) => {
    const id = prefix.slice(getGalleryPrefix().length).replace(/\/$/, '');
    if (!id) return null;
    const object = await env.WORKSPACE_FILES.get(galleryManifestKey(id));
    return object ? publicGalleryItem(await object.json<GalleryItem>()) : null;
  }));
  const result: GalleryItemsPage = {
    items: items.filter((item): item is GalleryItem => Boolean(item)),
  };
  if (nextCursor) result.nextCursor = nextCursor;
  return result;
}

/**
 * Opaque keyed owner tag. Tags live in a private owner record; the public
 * manifest contains no stable author identifier.
 */
export async function galleryOwnerTag(sessionId: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`gallery-owner:${sessionId}`),
  );
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listGalleryItems(env: Env): Promise<GalleryItem[]> {
  const ids = await listGalleryIds(env);
  const items = await Promise.all(
    ids.map(async (id) => {
      const object = await env.WORKSPACE_FILES.get(galleryManifestKey(id));
      if (!object) return null;
      return publicGalleryItem(await object.json<GalleryItem>());
    })
  );

  return items
    .filter((item): item is GalleryItem => Boolean(item))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

export async function getGalleryItem(env: Env, id: string): Promise<GalleryItemFull | null> {
  const [manifest, state] = await Promise.all([
    env.WORKSPACE_FILES.get(galleryManifestKey(id)),
    env.WORKSPACE_FILES.get(galleryStateKey(id)),
  ]);

  if (!manifest || !state) return null;

  return {
    ...publicGalleryItem(await manifest.json<GalleryItem>()),
    state: await state.json<WorkspaceState>(),
  };
}

export async function publishWorkspace(args: {
  env: Env;
  sessionId: string;
  workspace: WorkspaceRecord;
  state: WorkspaceState;
  title: string;
  description: string;
  operationId: string;
  files: Array<{ path: string; isDirectory: boolean }>;
  readFile: (filePath: string) => Promise<{
    contentType: string;
    data: ArrayBuffer;
  } | null>;
}): Promise<GalleryItem> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${args.sessionId}:${args.workspace.id}:${args.operationId}`),
  );
  const id = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
  const existingManifest = await args.env.WORKSPACE_FILES.get(galleryManifestKey(id));
  if (existingManifest) {
    const existingOwner = await args.env.WORKSPACE_FILES.get(galleryOwnerKey(id));
    if (!existingOwner || !(await ownerRecordMatches(
      args.env,
      await existingOwner.json<GalleryOwnerRecord>(),
      args.sessionId,
    ))) {
      throw new GalleryError('Not authorized to replace this gallery item', 403);
    }
    // The manifest is written last, so its presence marks a complete publish.
    // A retry with the same idempotency key returns that committed result
    // without touching files or risking rollback of the existing item.
    return publicGalleryItem(await existingManifest.json<GalleryItem>());
  }
  const shareablePanelCount = args.state.panels.filter(
    (panel) => panel.type !== 'chat' && panel.type !== 'fileTree' && !('filePath' in panel)
  ).length;
  const fileCount = args.files.filter((file) => !file.isDirectory).length;

  const item: GalleryItem = {
    id,
    title: args.title,
    description: args.description,
    prompt: args.workspace.description,
    publishedAt: new Date().toISOString(),
    artifactCount: shareablePanelCount + fileCount,
  };

  const fileUploads = args.files
    .filter((file) => !file.isDirectory)
    .map(async (file) => {
      const content = await args.readFile(file.path);
      if (!content) {
        throw new Error(`Failed to publish missing file: ${file.path}`);
      }

      await args.env.WORKSPACE_FILES.put(getGalleryFileKey(id, file.path), content.data, {
        httpMetadata: { contentType: content.contentType || getMimeType(file.path) },
      });
    });

  // §3¾ defense-in-depth: an inline `type:'preview'` panel (content, no
  // filePath) carries active HTML that the public gallery preview route serves
  // top-level. We intentionally KEEP the content rather than dropping it here: a
  // live HTML preview is the legitimate published-workspace feature, so stripping
  // it would break sharing a working preview. The containment is the served CSP
  // (`sandbox allow-scripts`, no allow-same-origin in previewServingHeaders),
  // which forces an opaque origin so the served script can't reach same-origin
  // state even on a direct top-level open. See lib/file-serving.ts §3¾.
  try {
    const uploadResults = await Promise.allSettled(fileUploads);
    const failedUpload = uploadResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedUpload) {
      throw failedUpload.reason;
    }
    const publishedState = {
      ...args.state,
      sessionId: null,
      workspace: args.state.workspace
        ? { ...args.state.workspace, id: '' }
        : args.state.workspace,
    };
    await args.env.WORKSPACE_FILES.put(
      galleryStateKey(id),
      JSON.stringify(publishedState, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
    await args.env.WORKSPACE_FILES.put(
      galleryOwnerKey(id),
      JSON.stringify(await galleryOwnerRecord(args.env, args.sessionId)),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
    );
    await args.env.WORKSPACE_FILES.put(
      galleryManifestKey(id),
      JSON.stringify(item, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
  } catch (error) {
    await deleteByPrefix(args.env, getGalleryPrefix(id)).catch(() => undefined);
    throw error;
  }

  return item;
}

export async function cloneGalleryItem(args: {
  env: Env;
  galleryId: string;
  sessionId: string;
  workspaceId: string;
}): Promise<GalleryItemFull> {
  const item = await getGalleryItem(args.env, args.galleryId);
  if (!item) {
    throw new GalleryError('Gallery item not found', 404);
  }

  return item;
}

export async function unpublishGalleryItem(env: Env, galleryId: string, sessionId: string): Promise<void> {
  const [manifestObject, ownerObject] = await Promise.all([
    env.WORKSPACE_FILES.get(galleryManifestKey(galleryId)),
    env.WORKSPACE_FILES.get(galleryOwnerKey(galleryId)),
  ]);
  if (!manifestObject) {
    throw new GalleryError('Gallery item not found', 404);
  }
  const authorized = ownerObject
    ? await ownerRecordMatches(env, await ownerObject.json<GalleryOwnerRecord>(), sessionId)
    : false;
  if (!authorized) {
    throw new GalleryError('Not authorized to unpublish this item', 403);
  }

  await deleteByPrefix(env, getGalleryPrefix(galleryId));
}

/**
 * Move gallery-item ownership from one session id to another (first-login
 * migration): every private owner record matching `fromSessionId` is rewritten
 * for `toSessionId` so unpublish rights follow the user into their subject
 * namespace. Legacy public owner tags are converted on contact. Items authored
 * by anyone else are untouched. Idempotent.
 * Returns the number of manifests rewritten.
 */
export async function reassignGalleryAuthor(
  env: Env,
  fromSessionId: string,
  toSessionId: string
): Promise<number> {
  const ids = await listGalleryIds(env);
  const legacyFromTag = await galleryOwnerTag(fromSessionId, env.SESSION_SECRET);
  let reassigned = 0;
  for (const id of ids) {
    const [manifestObject, ownerObject] = await Promise.all([
      env.WORKSPACE_FILES.get(galleryManifestKey(id)),
      env.WORKSPACE_FILES.get(galleryOwnerKey(id)),
    ]);
    if (!manifestObject) continue;
    const item = await manifestObject.json<GalleryItem>();
    const owner = ownerObject ? await ownerObject.json<GalleryOwnerRecord>() : null;
    const authorId = z.string().min(1).safeParse(item.authorId).data;
    const legacyMatches = authorId !== undefined
      && timingSafeEqual(authorId, legacyFromTag);
    const matches = owner
      ? await ownerRecordMatches(env, owner, fromSessionId)
        // Retry a prior attempt that switched the private owner but failed
        // before removing the matching public legacy tag from the manifest.
        || (legacyMatches && await ownerRecordMatches(env, owner, toSessionId))
      : legacyMatches;
    if (!matches) continue;
    const next = publicGalleryItem(item);
    await env.WORKSPACE_FILES.put(
      galleryOwnerKey(id),
      JSON.stringify(await galleryOwnerRecord(env, toSessionId)),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
    );
    await env.WORKSPACE_FILES.put(
      galleryManifestKey(id),
      JSON.stringify(next, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
    reassigned += 1;
  }
  return reassigned;
}
