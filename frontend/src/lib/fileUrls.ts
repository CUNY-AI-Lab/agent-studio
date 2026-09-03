import { getWorkspaceFileUrl, getGalleryFileUrl } from '../api';
import { fetchWorkspaceFile } from '../api';
import { downloadBlob } from './download';
import { useEffect, useState } from 'react';
import type { WorkspaceFileInfo } from '../types';
import { z } from 'zod';

export interface FileObjectUrlState {
  url: string | null;
  blob: Blob | null;
  error: string | null;
}

export type WorkspaceFileFetcher = (workspaceId: string, filePath: string) => Promise<Response>;

export type FileSource =
  | { kind: 'workspace'; id: string }
  | { kind: 'gallery'; id: string };

export type FileDownloadHandler = (
  source: FileSource,
  filePath: string,
  filename: string,
) => void;

type FileSourceFetcher = (source: FileSource, filePath: string) => Promise<Response>;

const fetchFileSource: FileSourceFetcher = (source, filePath) => source.kind === 'workspace'
  ? fetchWorkspaceFile(source.id, filePath)
  : fetch(getGalleryFileUrl(source.id, filePath));

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
  const size = z.number().safeParse(file.size).data;
  return file.etag || file.modifiedAt || file.uploadedAt || (size !== undefined ? String(size) : null);
}

/**
 * Resolve protected workspace bytes through the CSRF header, never a URL token.
 *
 * A failed fetch surfaces as `error` — it must never leave the consumer stuck
 * on a loading state that is indistinguishable from a real pending request.
 */
export function useFileObjectUrl(
  source: FileSource,
  filePath: string,
  cacheKey?: string | null,
  fetcher: WorkspaceFileFetcher = fetchWorkspaceFile,
): FileObjectUrlState {
  const galleryUrl = source.kind === 'gallery'
    ? withCacheKey(getGalleryFileUrl(source.id, filePath), cacheKey)
    : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source.kind === 'gallery') {
      setObjectUrl(null);
      setBlob(null);
      setError(null);
      return;
    }
    let active = true;
    let created: string | null = null;
    setObjectUrl(null);
    setBlob(null);
    setError(null);
    void fetcher(source.id, filePath)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load file (${response.status})`);
        const fetchedBlob = await response.blob();
        if (!active) return;
        created = URL.createObjectURL(fetchedBlob);
        setBlob(fetchedBlob);
        setObjectUrl(created);
      })
      .catch((fetchError) => {
        if (active) {
          setObjectUrl(null);
          setBlob(null);
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to load file');
        }
      });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [source.kind, source.id, filePath, cacheKey, fetcher]);

  return { url: galleryUrl ?? objectUrl, blob: galleryUrl ? null : blob, error: galleryUrl ? null : error };
}

export async function downloadFileSource(
  source: FileSource,
  filePath: string,
  filename: string,
  fetcher: FileSourceFetcher = fetchFileSource,
): Promise<void> {
  const response = await fetcher(source, filePath);
  if (!response.ok) throw new Error(`File request failed with ${response.status}`);
  downloadBlob(await response.blob(), filename);
}
