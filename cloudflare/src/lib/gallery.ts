import type { GalleryItem, GalleryItemFull } from '../domain/gallery';
import type { WorkspaceRecord, WorkspaceState } from '../domain/workspace';
import type { Env } from '../env';
import {
  deleteByPrefix,
  getGalleryFileKey,
  getGalleryPrefix,
  getMimeType,
} from './files';

function galleryManifestKey(id: string): string {
  return `${getGalleryPrefix(id)}manifest.json`;
}

function galleryStateKey(id: string): string {
  return `${getGalleryPrefix(id)}state.json`;
}

export async function listGalleryItems(env: Env): Promise<GalleryItem[]> {
  const listing = await env.WORKSPACE_FILES.list({ prefix: getGalleryPrefix(), delimiter: '/' });
  const items = await Promise.all(
    listing.delimitedPrefixes.map(async (prefix) => {
      const id = prefix.slice(getGalleryPrefix().length).replace(/\/$/, '');
      if (!id) return null;
      const object = await env.WORKSPACE_FILES.get(galleryManifestKey(id));
      if (!object) return null;
      return object.json<GalleryItem>();
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
    ...(await manifest.json<GalleryItem>()),
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
  files: Array<{ path: string; isDirectory: boolean }>;
  readFile: (filePath: string) => Promise<{
    contentType: string;
    data: ArrayBuffer;
  } | null>;
}): Promise<GalleryItem> {
  const id = crypto.randomUUID().slice(0, 10);
  const shareablePanelCount = args.state.panels.filter(
    (panel) => panel.type !== 'chat' && panel.type !== 'fileTree' && !('filePath' in panel)
  ).length;
  const fileCount = args.files.filter((file) => !file.isDirectory).length;

  const item: GalleryItem = {
    id,
    title: args.title,
    description: args.description,
    prompt: args.workspace.description,
    authorId: args.sessionId,
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
  await Promise.all([
    args.env.WORKSPACE_FILES.put(
      galleryManifestKey(id),
      JSON.stringify(item, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    ),
    args.env.WORKSPACE_FILES.put(
      galleryStateKey(id),
      JSON.stringify(args.state, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    ),
    ...fileUploads,
  ]);

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
    throw new Error('Gallery item not found');
  }

  return item;
}

export async function unpublishGalleryItem(env: Env, galleryId: string, sessionId: string): Promise<void> {
  const item = await getGalleryItem(env, galleryId);
  if (!item) {
    throw new Error('Gallery item not found');
  }
  if (item.authorId !== sessionId) {
    throw new Error('Not authorized to unpublish this item');
  }

  await deleteByPrefix(env, getGalleryPrefix(galleryId));
}

/**
 * Move gallery-item ownership from one session id to another (first-login
 * migration): every manifest authored by `fromSessionId` is rewritten to
 * `toSessionId` so unpublish rights follow the user into their subject
 * namespace. Items authored by anyone else are untouched. Idempotent.
 * Returns the number of manifests rewritten.
 */
export async function reassignGalleryAuthor(
  env: Env,
  fromSessionId: string,
  toSessionId: string
): Promise<number> {
  const items = await listGalleryItems(env);
  let reassigned = 0;
  for (const item of items) {
    if (item.authorId !== fromSessionId) continue;
    const next: GalleryItem = { ...item, authorId: toSessionId };
    await env.WORKSPACE_FILES.put(
      galleryManifestKey(item.id),
      JSON.stringify(next, null, 2),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
    reassigned += 1;
  }
  return reassigned;
}
