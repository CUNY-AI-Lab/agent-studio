import type {
  DownloadRequest,
  GalleryItem,
  GalleryItemFull,
  WorkspaceFileInfo,
  WorkspaceObservabilitySnapshot,
  WorkspaceRecord,
  WorkspaceResponse,
  WorkspaceRuntimeExecution,
} from './types';

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed with ${response.status}` }));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function encodePath(filePath: string): string {
  return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function parseFilename(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }
  const simpleMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return simpleMatch?.[1] || fallback;
}

export async function fetchWorkspaces(): Promise<WorkspaceRecord[]> {
  const response = await fetch('/api/workspaces', { credentials: 'include' });
  const payload = await parseJson<{ workspaces: WorkspaceRecord[] }>(response);
  return payload.workspaces;
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
}): Promise<WorkspaceRecord> {
  const response = await fetch('/api/workspaces', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await parseJson<{ workspace: WorkspaceRecord }>(response);
  return payload.workspace;
}

export async function importWorkspaceBundle(file: File): Promise<{ workspaceId: string; workspace: WorkspaceRecord }> {
  const formData = new FormData();
  formData.append('bundle', file, file.name);
  const response = await fetch('/api/workspaces/import', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  return parseJson<{ workspaceId: string; workspace: WorkspaceRecord }>(response);
}

export async function updateWorkspace(
  workspaceId: string,
  input: { name?: string; description?: string }
): Promise<WorkspaceRecord> {
  const response = await fetch(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await parseJson<{ workspace: WorkspaceRecord }>(response);
  return payload.workspace;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const response = await fetch(`/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  await parseJson<{ success: boolean }>(response);
}

export async function fetchGalleryItems(): Promise<GalleryItem[]> {
  const response = await fetch('/api/gallery', { credentials: 'include' });
  const payload = await parseJson<{ items: GalleryItem[] }>(response);
  return payload.items;
}

export async function cloneGalleryItem(galleryId: string): Promise<{ workspaceId: string; workspace: WorkspaceRecord }> {
  const response = await fetch(`/api/gallery/${galleryId}`, {
    method: 'POST',
    credentials: 'include',
  });
  return parseJson<{ workspaceId: string; workspace: WorkspaceRecord }>(response);
}

export async function fetchGalleryItem(galleryId: string): Promise<GalleryItemFull> {
  const response = await fetch(`/api/gallery/${galleryId}`, {
    credentials: 'include',
  });
  const payload = await parseJson<{ item: GalleryItemFull }>(response);
  return payload.item;
}

export async function publishWorkspace(
  workspaceId: string,
  input: { title: string; description: string }
): Promise<{ item: GalleryItem; workspace: WorkspaceRecord }> {
  const response = await fetch(`/api/workspaces/${workspaceId}/publish`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJson<{ item: GalleryItem; workspace: WorkspaceRecord }>(response);
}

export async function unpublishGalleryItem(galleryId: string): Promise<void> {
  const response = await fetch(`/api/gallery/${galleryId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  await parseJson<{ success: boolean }>(response);
}

export async function fetchWorkspace(workspaceId: string): Promise<WorkspaceResponse> {
  const response = await fetch(`/api/workspaces/${workspaceId}`, {
    credentials: 'include',
  });
  return parseJson<WorkspaceResponse>(response);
}

export async function fetchWorkspaceObservability(workspaceId: string): Promise<WorkspaceObservabilitySnapshot> {
  const response = await fetch(`/api/workspaces/${workspaceId}/observability`, {
    credentials: 'include',
  });
  const payload = await parseJson<{ observability: WorkspaceObservabilitySnapshot }>(response);
  return payload.observability;
}

export async function fetchWorkspaceExport(workspaceId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/workspaces/${workspaceId}/export`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed with ${response.status}` }));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return {
    blob: await response.blob(),
    filename: parseFilename(response.headers.get('Content-Disposition'), `workspace-${workspaceId}.agent-studio.json`),
  };
}

export async function fetchWorkspaceFiles(workspaceId: string): Promise<WorkspaceFileInfo[]> {
  const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
    credentials: 'include',
  });
  const payload = await parseJson<{ files: WorkspaceFileInfo[] }>(response);
  return payload.files;
}

export async function fetchWorkspaceDownloads(workspaceId: string): Promise<DownloadRequest[]> {
  const response = await fetch(`/api/workspaces/${workspaceId}/downloads`, {
    credentials: 'include',
  });
  const payload = await parseJson<{ downloads: DownloadRequest[] }>(response);
  return payload.downloads;
}

export async function clearWorkspaceDownloads(workspaceId: string): Promise<void> {
  const response = await fetch(`/api/workspaces/${workspaceId}/downloads`, {
    method: 'DELETE',
    credentials: 'include',
  });
  await parseJson<{ success: boolean }>(response);
}

export function getWorkspaceFileUrl(workspaceId: string, filePath: string): string {
  return `/api/workspaces/${workspaceId}/files/${encodePath(filePath)}`;
}

export function getGalleryFileUrl(galleryId: string, filePath: string): string {
  return `/api/gallery/${galleryId}/files/${encodePath(filePath)}`;
}

export function getWorkspacePanelPreviewUrl(workspaceId: string, panelId: string): string {
  return `/api/workspaces/${workspaceId}/panels/${encodeURIComponent(panelId)}/preview`;
}

export function getGalleryPanelPreviewUrl(galleryId: string, panelId: string): string {
  return `/api/gallery/${galleryId}/panels/${encodeURIComponent(panelId)}/preview`;
}

export async function uploadWorkspaceFiles(workspaceId: string, files: FileList | File[]): Promise<void> {
  const formData = new FormData();
  Array.from(files).forEach((file) => {
    formData.append('files', file, file.webkitRelativePath || file.name);
  });
  const response = await fetch(`/api/workspaces/${workspaceId}/upload`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  await parseJson<{ success: boolean }>(response);
}

export async function deleteWorkspaceFile(workspaceId: string, filePath: string): Promise<void> {
  const response = await fetch(getWorkspaceFileUrl(workspaceId, filePath), {
    method: 'DELETE',
    credentials: 'include',
  });
  await parseJson<{ success: boolean }>(response);
}

export async function executeWorkspaceRuntime(
  workspaceId: string,
  code: string
): Promise<WorkspaceRuntimeExecution> {
  const response = await fetch(`/api/workspaces/${workspaceId}/runtime/execute`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const payload = await parseJson<{ execution: WorkspaceRuntimeExecution }>(response);
  return payload.execution;
}
