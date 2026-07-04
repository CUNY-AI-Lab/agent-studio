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

/**
 * CAIL 401 handling (see cail-gateway docs/INTEGRATION.md §2). When the SSO
 * gate / model proxy returns `authentication_required`, redirect the browser
 * to /login?rt=<current-path> so the user re-authenticates and returns here.
 * Same-origin paths only. Returns true when it handled (and is redirecting).
 */
export function handleAuthRequired(status: number, payload: unknown): boolean {
  if (status !== 401) return false;
  const error = typeof payload === 'object' && payload !== null
    ? (payload as { error?: unknown }).error
    : undefined;
  if (error !== 'authentication_required') return false;

  const loginUrl = typeof payload === 'object' && payload !== null
    ? (payload as { login_url?: unknown }).login_url
    : undefined;
  const base = typeof loginUrl === 'string' && loginUrl.startsWith('/') ? loginUrl : '/login';
  const rt = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`${base}?rt=${encodeURIComponent(rt)}`);
  return true;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed with ${response.status}` }));
    if (handleAuthRequired(response.status, payload)) {
      // Redirecting to /login; reject with a benign message so callers stop.
      throw new Error('Authentication required');
    }
    const message = typeof payload === 'object' && payload !== null
      ? ((payload as { message?: string; error?: string }).message
        ?? (payload as { error?: string }).error)
      : undefined;
    throw new Error(message || `Request failed with ${response.status}`);
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

export type ModelTier = 'recommended' | 'advanced';
export type ModelStatus = 'active' | 'deprecated' | 'retiring';

export interface ModelCatalogEntry {
  id: string;
  recommended: boolean;
  tier: ModelTier;
  status: ModelStatus;
  sunset: string | null;
  capabilities: string[];
  contextLength: number | null;
  registryUrl: string | null;
  name: string | null;
  description: string | null;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  source: 'proxy' | 'fallback';
  default: string;
}

export async function fetchModels(): Promise<ModelCatalog> {
  const response = await fetch('/api/models', { credentials: 'include' });
  return parseJson<ModelCatalog>(response);
}

/** Strip the `@cf/vendor/` prefix so the picker shows a short model name. */
export function modelDisplayName(id: string): string {
  return id.split('/').pop() || id;
}

export interface ModelOption {
  id: string;
  /** Visible option text (short name, ' (default)', ' — retiring <date>'). */
  label: string;
  /** Full option title attribute: id plus context length when known. */
  title: string;
}

export interface ModelPickerView {
  /** The model that is actually in effect (override ?? catalog default). */
  effectiveModel: string;
  /** Options for the recommended tier (shown ungrouped, above the disclosure). */
  recommended: ModelOption[];
  /** Options for the advanced tier (rendered inside an "Other models" optgroup). */
  advanced: ModelOption[];
  /** Sunset note for the effective model when it is retiring; else null. */
  effectiveRetiringNote: string | null;
}

function buildOption(entry: ModelCatalogEntry, catalogDefault: string): ModelOption {
  const base = entry.name?.trim() ? entry.name.trim() : modelDisplayName(entry.id);
  let label = base;
  if (entry.id === catalogDefault) {
    label += ' (default)';
  }
  if (entry.status === 'retiring' && entry.sunset) {
    label += ` — retiring ${entry.sunset}`;
  }
  const title =
    entry.contextLength != null ? `${entry.id} · ${entry.contextLength} tokens` : entry.id;
  return { id: entry.id, label, title };
}

/**
 * Partition the catalog into the picker's recommended/advanced groups, honoring
 * the override and the contract's visibility rules:
 *  - effective model = workspace override ?? catalog default (data[0]).
 *  - deprecated models are hidden unless they are the currently-selected model.
 *  - a stored override that dropped from the catalog is kept selectable,
 *    prepended into the group matching its tier (or recommended by default).
 */
export function buildModelPickerView(
  catalog: ModelCatalog,
  override: string | undefined
): ModelPickerView {
  const catalogDefault = catalog.default;
  const effectiveModel = override ?? catalogDefault;

  const recommended: ModelOption[] = [];
  const advanced: ModelOption[] = [];
  let effectiveInCatalog = false;
  let effectiveRetiringNote: string | null = null;

  for (const entry of catalog.models) {
    const isEffective = entry.id === effectiveModel;
    if (isEffective) {
      effectiveInCatalog = true;
      if (entry.status === 'retiring') {
        effectiveRetiringNote = entry.sunset
          ? `This model is retiring on ${entry.sunset}.`
          : 'This model is retiring.';
      }
    }
    // Deprecated models are excluded from the picker unless currently selected.
    if (entry.status === 'deprecated' && !isEffective) {
      continue;
    }
    const option = buildOption(entry, catalogDefault);
    (entry.tier === 'advanced' ? advanced : recommended).push(option);
  }

  // Keep a stored override selectable even if it dropped from the catalog.
  if (!effectiveInCatalog) {
    recommended.unshift({
      id: effectiveModel,
      label: modelDisplayName(effectiveModel),
      title: effectiveModel,
    });
  }

  return { effectiveModel, recommended, advanced, effectiveRetiringNote };
}

export async function updateWorkspace(
  workspaceId: string,
  input: { name?: string; description?: string; model?: string }
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
