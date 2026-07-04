import { getWorkspaceFileUrl, getGalleryFileUrl } from '../api';
import type { WorkspaceFileInfo } from '../types';

export type FileSource =
  | { kind: 'workspace'; id: string }
  | { kind: 'gallery'; id: string };

export function getFileUrl(source: FileSource, filePath: string): string {
  return source.kind === 'workspace'
    ? getWorkspaceFileUrl(source.id, filePath)
    : getGalleryFileUrl(source.id, filePath);
}

export function withCacheKey(url: string, cacheKey?: string | null): string {
  if (!cacheKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(cacheKey)}`;
}

export function getWorkspaceFileCacheKey(
  workspaceFiles: WorkspaceFileInfo[] | undefined,
  filePath: string
): string | null {
  const file = workspaceFiles?.find((entry) => !entry.isDirectory && entry.path === filePath);
  if (!file) return null;
  return file.etag || file.modifiedAt || file.uploadedAt || (typeof file.size === 'number' ? String(file.size) : null);
}
