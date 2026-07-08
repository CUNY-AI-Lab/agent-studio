import type { WorkspaceFileInfo } from '../domain/workspace';
import type { Env } from '../env';

const APP_PREFIX = 'agent-studio';

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid file path');
  }
  return normalized;
}

export function sanitizeRelativePath(path: string): string {
  return normalizeRelativePath(path);
}

export function toRuntimePath(filePath: string): string {
  return `/${sanitizeRelativePath(filePath)}`;
}

export function getWorkspaceFilesPrefix(sessionId: string, workspaceId: string): string {
  return `${APP_PREFIX}/sessions/${sessionId}/workspaces/${workspaceId}/files/`;
}

export function getWorkspacePrefix(sessionId: string, workspaceId: string): string {
  return `${APP_PREFIX}/sessions/${sessionId}/workspaces/${workspaceId}/`;
}

export function getGalleryPrefix(galleryId?: string): string {
  return galleryId
    ? `${APP_PREFIX}/gallery/items/${galleryId}/`
    : `${APP_PREFIX}/gallery/items/`;
}

export function getGalleryFilesPrefix(galleryId: string): string {
  return `${getGalleryPrefix(galleryId)}files/`;
}

export function getWorkspaceFileKey(sessionId: string, workspaceId: string, filePath: string): string {
  return `${getWorkspaceFilesPrefix(sessionId, workspaceId)}${normalizeRelativePath(filePath)}`;
}

export function getGalleryFileKey(galleryId: string, filePath: string): string {
  return `${getGalleryFilesPrefix(galleryId)}${normalizeRelativePath(filePath)}`;
}

function getRelativePath(prefix: string, key: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

async function listFilesUnderPrefix(env: Env, basePrefix: string, dir = ''): Promise<WorkspaceFileInfo[]> {
  const relativeDir = normalizeRelativePath(dir);
  const prefix = `${basePrefix}${relativeDir ? `${relativeDir}/` : ''}`;
  const listing = await env.WORKSPACE_FILES.list({ prefix, delimiter: '/' });

  const directories = listing.delimitedPrefixes.map((nextPrefix) => {
    const relativePath = getRelativePath(basePrefix, nextPrefix).replace(/\/$/, '');
    return {
      name: relativePath.split('/').pop() || relativePath,
      path: relativePath,
      isDirectory: true,
    } satisfies WorkspaceFileInfo;
  });

  const files = listing.objects.map((object) => {
    const relativePath = getRelativePath(basePrefix, object.key);
    return {
      name: relativePath.split('/').pop() || relativePath,
      path: relativePath,
      isDirectory: false,
      size: object.size,
      uploadedAt: object.uploaded?.toISOString(),
      modifiedAt: object.uploaded?.toISOString(),
      etag: object.etag,
    } satisfies WorkspaceFileInfo;
  });

  return [...directories, ...files].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

async function listFilesUnderPrefixRecursive(env: Env, basePrefix: string, dir = ''): Promise<WorkspaceFileInfo[]> {
  const entries = await listFilesUnderPrefix(env, basePrefix, dir);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => listFilesUnderPrefixRecursive(env, basePrefix, entry.path))
  );
  return [...entries, ...nested.flat()];
}

export async function listWorkspaceFiles(
  env: Env,
  sessionId: string,
  workspaceId: string,
  dir = ''
): Promise<WorkspaceFileInfo[]> {
  return listFilesUnderPrefix(env, getWorkspaceFilesPrefix(sessionId, workspaceId), dir);
}

export async function listWorkspaceFilesRecursive(
  env: Env,
  sessionId: string,
  workspaceId: string,
  dir = ''
): Promise<WorkspaceFileInfo[]> {
  return listFilesUnderPrefixRecursive(env, getWorkspaceFilesPrefix(sessionId, workspaceId), dir);
}

export async function listGalleryFiles(
  env: Env,
  galleryId: string,
  dir = ''
): Promise<WorkspaceFileInfo[]> {
  return listFilesUnderPrefix(env, getGalleryFilesPrefix(galleryId), dir);
}

export async function listGalleryFilesRecursive(
  env: Env,
  galleryId: string,
  dir = ''
): Promise<WorkspaceFileInfo[]> {
  return listFilesUnderPrefixRecursive(env, getGalleryFilesPrefix(galleryId), dir);
}

export async function readWorkspaceFile(
  env: Env,
  sessionId: string,
  workspaceId: string,
  filePath: string
): Promise<R2ObjectBody | null> {
  return env.WORKSPACE_FILES.get(getWorkspaceFileKey(sessionId, workspaceId, filePath));
}

export async function readGalleryFile(
  env: Env,
  galleryId: string,
  filePath: string
): Promise<R2ObjectBody | null> {
  return env.WORKSPACE_FILES.get(getGalleryFileKey(galleryId, filePath));
}

export async function deleteWorkspaceFiles(env: Env, sessionId: string, workspaceId: string): Promise<void> {
  const prefix = getWorkspacePrefix(sessionId, workspaceId);
  await deleteByPrefix(env, prefix);
}

export async function deleteByPrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const listing = await env.WORKSPACE_FILES.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await env.WORKSPACE_FILES.delete(listing.objects.map((object) => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

export function getMimeType(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  const ext = dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}
