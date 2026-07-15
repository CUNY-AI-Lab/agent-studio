import { getWorkspaceFileUrl, getGalleryFileUrl } from '../api';
import { fetchWorkspaceFile } from '../api';
import { useEffect, useState } from 'react';
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

/** Resolve protected workspace bytes through the CSRF header, never a URL token. */
export function useFileObjectUrl(
  source: FileSource,
  filePath: string,
  cacheKey?: string | null,
): string | null {
  const publicUrl = source.kind === 'gallery'
    ? withCacheKey(getGalleryFileUrl(source.id, filePath), cacheKey)
    : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (source.kind === 'gallery') {
      setObjectUrl(null);
      return;
    }
    let active = true;
    let created: string | null = null;
    void fetchWorkspaceFile(source.id, filePath)
      .then(async (response) => {
        if (!response.ok) throw new Error(`File request failed with ${response.status}`);
        created = URL.createObjectURL(await response.blob());
        if (active) setObjectUrl(created);
        else URL.revokeObjectURL(created);
      })
      .catch(() => {
        if (active) setObjectUrl(null);
      });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [source.kind, source.id, filePath, cacheKey]);

  return publicUrl ?? objectUrl;
}

export async function downloadFileSource(
  source: FileSource,
  filePath: string,
  filename: string,
): Promise<void> {
  const response = source.kind === 'workspace'
    ? await fetchWorkspaceFile(source.id, filePath)
    : await fetch(getGalleryFileUrl(source.id, filePath));
  if (!response.ok) throw new Error(`File request failed with ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function openFileSource(source: FileSource, filePath: string): Promise<void> {
  const response = source.kind === 'workspace'
    ? await fetchWorkspaceFile(source.id, filePath)
    : await fetch(getGalleryFileUrl(source.id, filePath));
  if (!response.ok) throw new Error(`File request failed with ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
