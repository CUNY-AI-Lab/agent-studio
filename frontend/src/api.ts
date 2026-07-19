import type {
  DownloadRequest,
  GalleryItem,
  GalleryItemFull,
  WorkspaceFileInfo,
  WorkspaceObservabilitySnapshot,
  WorkspaceRecord,
  WorkspaceResponse,
} from './types';
import { appPath } from './base-path';

/**
 * CAIL 401 handling (see docs/security-and-operations.md). When the SSO
 * gate or model gateway returns `authentication_required`, redirect the browser
 * to /login?rt=<current-path> so the user re-authenticates and returns here.
 * Same-origin paths only. Returns true when it handled (and is redirecting).
 */
export function handleAuthRequired(status: number, payload: unknown): boolean {
  if (status !== 401) return false;
  const envelope = typeof payload === 'object' && payload !== null
    ? (payload as { error?: unknown }).error
    : undefined;
  const nested = typeof envelope === 'object' && envelope !== null
    ? envelope as { code?: unknown; cail?: { login_url?: unknown } }
    : null;
  const code = nested?.code ?? envelope;
  if (code !== 'authentication_required') return false;

  const loginUrl = nested?.cail?.login_url ?? (typeof payload === 'object' && payload !== null
    ? (payload as { login_url?: unknown }).login_url
    : undefined);
  const base = typeof loginUrl === 'string' && loginUrl.startsWith('/') ? loginUrl : '/login';
  const rt = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`${base}?rt=${encodeURIComponent(rt)}`);
  return true;
}

/**
 * Per-session CSRF capability (fleet contract §3¾ rule 3). The worker signs a
 * short-lived, nonce-bearing token and delivers it via a path-scoped cookie on the
 * /api/session bootstrap GET (the 2026-07-05 delivery amendment: the token must
 * NOT appear in any response body, so a same-origin sibling / user-content
 * script that `fetch()`es our endpoints can't read it). Browser JavaScript
 * cannot read the Set-Cookie response header. The cookie itself is deliberately
 * non-HttpOnly; its Path scopes document.cookie visibility to our own pages.
 * We read it here and echo it in X-CAIL-CSRF on every mutation,
 * sensitive workspace read, and as the WebSocket connect token. A sibling tool
 * is same-origin but, being outside our path prefix, never sees the cookie —
 * which is what isolates siblings (the origin check alone cannot).
 */
export const CSRF_HEADER = 'X-CAIL-CSRF';

/** Cookie the worker delivers the token in (must match cloudflare/src/lib/csrf.ts). */
export const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';

let csrfTokenPromise: Promise<string> | null = null;

/** Read a cookie value from document.cookie, or null if absent. */
function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

async function requestCsrfToken(): Promise<string> {
  // Hit the bootstrap GET so the worker sets the cookie, then read it. The JSON
  // body no longer carries the token (the amendment forbids it); the path-scoped
  // cookie is the only delivery channel.
  const response = await fetch(appPath('/api/session'), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Session bootstrap failed with ${response.status}`);
  }
  const token = readCookie(CSRF_COOKIE_NAME);
  if (!token) {
    throw new Error('Session bootstrap did not set the CSRF cookie');
  }
  return token;
}

/**
 * Resolve the CSRF token. If the cookie is already present (set by a prior
 * bootstrap this page load) it is used without a round-trip; otherwise
 * /api/session is fetched once to set it, and the result is cached. A failed
 * fetch/read is not cached, so a transient error can be retried on the next
 * mutation. Callers that mutate must await this and send the token.
 */
export function ensureCsrfToken(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE_NAME);
  if (existing) return Promise.resolve(existing);
  if (!csrfTokenPromise) {
    csrfTokenPromise = requestCsrfToken().catch((error) => {
      csrfTokenPromise = null;
      throw error;
    });
  }
  return csrfTokenPromise;
}

/** Synchronous cookie read of the CSRF token (null if the bootstrap has not run). */
export function csrfTokenFromCookie(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

async function protectedFetch(input: string, init: RequestInit): Promise<Response> {
  const baseHeaders = new Headers(init.headers);
  const send = (token: string) => {
    const headers = new Headers(baseHeaders);
    headers.set(CSRF_HEADER, token);
    return fetch(appPath(input), { ...init, credentials: 'include', headers });
  };

  let response = await send(await ensureCsrfToken());
  if (response.status !== 403) return response;

  const payload = await response.clone().json().catch(() => null) as {
    error?: string | { code?: string };
  } | null;
  const code = typeof payload?.error === 'object' ? payload.error.code : payload?.error;
  if (code !== 'csrf_token_invalid' && code !== 'csrf_token_missing') {
    return response;
  }

  response = await send(await requestCsrfToken());
  return response;
}

/**
 * fetch() wrapper for state-changing calls: ensures the CSRF token and attaches
 * it as X-CAIL-CSRF (merged with any caller-supplied headers). All mutating API
 * helpers below route through this so no mutation can forget the header.
 */
export async function mutatingFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return protectedFetch(input, init);
}

/** fetch() wrapper for sensitive workspace reads. */
export async function readingFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return protectedFetch(input, init);
}

/**
 * Read a failed response's JSON error envelope. Returns the parsed payload (for
 * auth-required detection) and the extracted message, mirroring the worker's
 * `{ error }` shape (and tolerating a `{ message }` variant). Falls back to a
 * status string when the body isn't JSON or carries neither field. Shared by
 * parseJson and fetchWorkspaceExport so their error extraction can't drift.
 * Reads the body exactly once.
 */
async function readResponseError(
  response: Response,
): Promise<{ payload: unknown; message: string }> {
  const payload = await response.json().catch(() => ({ error: `Request failed with ${response.status}` }));
  const error = typeof payload === 'object' && payload !== null
    ? (payload as { error?: unknown }).error
    : undefined;
  const message = typeof error === 'object' && error !== null
    ? (error as { message?: string }).message
    : typeof payload === 'object' && payload !== null
      ? ((payload as { message?: string }).message ?? (typeof error === 'string' ? error : undefined))
      : undefined;
  return { payload, message: message || `Request failed with ${response.status}` };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const { payload, message } = await readResponseError(response);
    if (handleAuthRequired(response.status, payload)) {
      // Redirecting to /login; reject with a benign message so callers stop.
      throw new Error('Authentication required');
    }
    throw new Error(message);
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
  const response = await readingFetch('/api/workspaces');
  const payload = await parseJson<{ workspaces: WorkspaceRecord[] }>(response);
  return payload.workspaces;
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
}): Promise<WorkspaceRecord> {
  const response = await mutatingFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await parseJson<{ workspace: WorkspaceRecord }>(response);
  return payload.workspace;
}

export async function importWorkspaceBundle(file: File): Promise<{ workspaceId: string; workspace: WorkspaceRecord }> {
  const formData = new FormData();
  formData.append('bundle', file, file.name);
  const response = await mutatingFetch('/api/workspaces/import', {
    method: 'POST',
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
  source: 'gateway';
  default: string;
}

export class ModelsQuotaError extends Error {}

export async function fetchModels(): Promise<ModelCatalog> {
  const response = await fetch(appPath('/api/models'), { credentials: 'include' });
  if (response.status === 429) {
    const { message } = await readResponseError(response);
    throw new ModelsQuotaError(message);
  }
  return parseJson<ModelCatalog>(response);
}

/** Show the final segment of a curated public model alias. */
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
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await parseJson<{ workspace: WorkspaceRecord }>(response);
  return payload.workspace;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });
  await parseJson<{ success: boolean }>(response);
}

export async function fetchGalleryItems(): Promise<GalleryItem[]> {
  const items: GalleryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(appPath(`/api/gallery?${query}`), { credentials: 'include' });
    const payload = await parseJson<{ items: GalleryItem[]; nextCursor?: string }>(response);
    items.push(...payload.items);
    cursor = payload.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error('Gallery pagination cursor repeated');
      seenCursors.add(cursor);
    }
  } while (cursor);
  return items.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

export async function cloneGalleryItem(galleryId: string): Promise<{ workspaceId: string; workspace: WorkspaceRecord }> {
  const response = await mutatingFetch(`/api/gallery/${galleryId}`, {
    method: 'POST',
  });
  return parseJson<{ workspaceId: string; workspace: WorkspaceRecord }>(response);
}

export async function fetchGalleryItem(galleryId: string): Promise<GalleryItemFull> {
  const response = await fetch(appPath(`/api/gallery/${galleryId}`), {
    credentials: 'include',
  });
  const payload = await parseJson<{ item: GalleryItemFull }>(response);
  return payload.item;
}

export async function publishWorkspace(
  workspaceId: string,
  input: { title: string; description: string; operationId: string }
): Promise<{ item: GalleryItem; workspace: WorkspaceRecord }> {
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJson<{ item: GalleryItem; workspace: WorkspaceRecord }>(response);
}

export async function unpublishGalleryItem(galleryId: string): Promise<void> {
  const response = await mutatingFetch(`/api/gallery/${galleryId}`, {
    method: 'DELETE',
  });
  await parseJson<{ success: boolean }>(response);
}

export async function fetchWorkspace(workspaceId: string): Promise<WorkspaceResponse> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}`);
  return parseJson<WorkspaceResponse>(response);
}

export async function fetchWorkspaceObservability(workspaceId: string): Promise<WorkspaceObservabilitySnapshot> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}/observability`);
  const payload = await parseJson<{ observability: WorkspaceObservabilitySnapshot }>(response);
  return payload.observability;
}

export async function fetchWorkspaceExport(workspaceId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}/export`);
  if (!response.ok) {
    // Same error extraction as parseJson (via readResponseError). Export does
    // NOT route 401s through handleAuthRequired: it returns a Blob and runs from
    // an already-authenticated workspace view, so a login redirect mid-download
    // is worse than surfacing the error. That divergence is deliberate.
    const { message } = await readResponseError(response);
    throw new Error(message);
  }

  return {
    blob: await response.blob(),
    filename: parseFilename(response.headers.get('Content-Disposition'), `workspace-${workspaceId}.agent-studio.json`),
  };
}

export async function fetchWorkspaceFiles(workspaceId: string): Promise<WorkspaceFileInfo[]> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}/files`);
  const payload = await parseJson<{ files: WorkspaceFileInfo[] }>(response);
  return payload.files;
}

export async function fetchWorkspaceDownloads(workspaceId: string): Promise<DownloadRequest[]> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}/downloads`);
  const payload = await parseJson<{ downloads: DownloadRequest[] }>(response);
  return payload.downloads;
}

export async function clearWorkspaceDownloads(workspaceId: string): Promise<void> {
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}/downloads`, {
    method: 'DELETE',
  });
  await parseJson<{ success: boolean }>(response);
}

export function getWorkspaceFileUrl(workspaceId: string, filePath: string): string {
  return appPath(`/api/workspaces/${workspaceId}/files/${encodePath(filePath)}`);
}

export function getGalleryFileUrl(galleryId: string, filePath: string): string {
  return appPath(`/api/gallery/${galleryId}/files/${encodePath(filePath)}`);
}

export function getWorkspacePanelPreviewUrl(workspaceId: string, panelId: string): string {
  return appPath(`/api/workspaces/${workspaceId}/panels/${encodeURIComponent(panelId)}/preview`);
}

export function getGalleryPanelPreviewUrl(galleryId: string, panelId: string): string {
  return appPath(`/api/gallery/${galleryId}/panels/${encodeURIComponent(panelId)}/preview`);
}

export function fetchWorkspaceFile(workspaceId: string, filePath: string): Promise<Response> {
  return readingFetch(`/api/workspaces/${workspaceId}/files/${encodePath(filePath)}`);
}

export function fetchWorkspacePanelPreview(workspaceId: string, panelId: string): Promise<Response> {
  return readingFetch(`/api/workspaces/${workspaceId}/panels/${encodeURIComponent(panelId)}/preview`);
}

export async function uploadWorkspaceFiles(workspaceId: string, files: FileList | File[]): Promise<void> {
  const formData = new FormData();
  Array.from(files).forEach((file) => {
    formData.append('files', file, file.webkitRelativePath || file.name);
  });
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}/upload`, {
    method: 'POST',
    body: formData,
  });
  await parseJson<{ success: boolean }>(response);
}
