import { getWorkspacePrefix } from './files';
import type { Env } from '../env';

export interface DownloadRequest {
  filename: string;
  data: unknown;
  format: 'csv' | 'json' | 'txt';
}

function getDownloadsKey(sessionId: string, workspaceId: string): string {
  return `${getWorkspacePrefix(sessionId, workspaceId)}downloads.json`;
}

export async function getWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<DownloadRequest[]> {
  const object = await env.WORKSPACE_FILES.get(getDownloadsKey(sessionId, workspaceId));
  if (!object) return [];

  try {
    const parsed = await object.json<DownloadRequest[]>();
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function putWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
  downloads: DownloadRequest[]
): Promise<void> {
  await env.WORKSPACE_FILES.put(
    getDownloadsKey(sessionId, workspaceId),
    JSON.stringify(downloads, null, 2),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
  );
}

export async function addWorkspaceDownload(
  env: Env,
  sessionId: string,
  workspaceId: string,
  download: DownloadRequest
): Promise<void> {
  const downloads = await getWorkspaceDownloads(env, sessionId, workspaceId);
  downloads.push(download);
  await putWorkspaceDownloads(env, sessionId, workspaceId, downloads);
}

export async function clearWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  await putWorkspaceDownloads(env, sessionId, workspaceId, []);
}
