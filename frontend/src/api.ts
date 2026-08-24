import type {
  DownloadRequest,
  GalleryItem,
  GalleryItemFull,
  WorkspaceFileInfo,
  WorkspaceRecord,
  WorkspaceResponse,
} from './types';
import { parseCailAuthErrorEnvelope } from '@cuny-ai-lab/cail-identity';
import { appPath } from './base-path';
import { z } from 'zod';

type CanonicalApiError = {
  code?: string;
  message?: string;
};

const canonicalErrorPayloadSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});

const CAIL_TOOLS_ORIGIN = 'https://tools.ailab.gc.cuny.edu';
const AGENT_STUDIO_PATH = '/agent-studio';

/**
 * An error whose message was minted by this API layer for the user to read —
 * either the worker's canonical error copy or our own full-sentence fallback.
 * UI error banners show an ApiError's message verbatim; any other thrown value
 * (network TypeError, library exception) gets per-action fallback copy instead.
 */
export class ApiError extends Error {}

function canonicalApiErrorFromPayload<T>(payload: T): CanonicalApiError | null {
  const parsed = canonicalErrorPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.error : null;
}

/**
 * CAIL 401 handling (see docs/security-and-operations.md). When an
 * Agent-owned response carries the strict cail-identity
 * `authentication_required` envelope, redirect the browser to the standalone
 * Doorway at the current Agent Studio path so the user re-authenticates and
 * returns here. Returns true when it handled (and is redirecting).
 */
export function handleAuthRequired<T>(status: number, payload: T): boolean {
  if (status !== 401) return false;
  const nested = parseCailAuthErrorEnvelope(payload)?.error ?? null;
  if (nested?.code !== 'authentication_required') return false;

  const currentPath = `${window.location.pathname}${window.location.search}`;
  const returnPath = window.location.pathname === AGENT_STUDIO_PATH
    || window.location.pathname.startsWith(`${AGENT_STUDIO_PATH}/`)
    ? currentPath
    : `${AGENT_STUDIO_PATH}${window.location.search}`;
  window.location.assign(`${CAIL_TOOLS_ORIGIN}${returnPath}`);
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
 * We read it here and echo it in X-CSRF-Token on every mutation,
 * sensitive workspace read, and as the WebSocket connect token. A sibling tool
 * is same-origin but, being outside our path prefix, never sees the cookie —
 * which is what isolates siblings (the origin check alone cannot).
 */
export const CSRF_HEADER = 'X-CSRF-Token';

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
    // Consume the body once so the canonical CAIL authentication envelope can
    // trigger the same safe redirect as every other JSON API response. Never
    // include the upstream body in the thrown bootstrap error.
    const { payload } = await readResponseError(response);
    if (handleAuthRequired(response.status, payload)) {
      throw new ApiError('Sign in to continue.');
    }
    throw new ApiError("Agent Studio couldn't start. Reload the page and try again.");
  }
  const token = readCookie(CSRF_COOKIE_NAME);
  if (!token) {
    throw new ApiError("Agent Studio couldn't start. Reload the page and try again.");
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

/**
 * Fetch a session-scoped route after the single-flight bootstrap has
 * established the browser's session and CSRF cookie.
 *
 * Gallery listing/detail are safe reads and do not need the CSRF header, but
 * they still traverse the worker's session middleware. Waiting here prevents
 * a first gallery request from racing /api/session and minting a second
 * anonymous session cookie.
 */
async function sessionFetch(input: string, init: RequestInit = {}): Promise<Response> {
  await ensureCsrfToken();
  return fetch(appPath(input), { ...init, credentials: 'include' });
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

  const payload = await response.clone().json().catch(() => null);
  const code = canonicalApiErrorFromPayload(payload)?.code;
  if (code !== 'csrf_token_invalid' && code !== 'csrf_token_missing') {
    return response;
  }

  response = await send(await requestCsrfToken());
  return response;
}

/**
 * fetch() wrapper for state-changing calls: ensures the CSRF token and attaches
 * it as X-CSRF-Token (merged with any caller-supplied headers). All mutating API
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
 * Read a failed response's canonical CAIL error envelope. Returns the parsed
 * payload (for auth-required detection) and the nested error message. Falls
 * back to a status string when the body isn't JSON or carries no canonical
 * message. Shared by
 * parseJson and fetchWorkspaceExport so their error extraction can't drift.
 * Reads the body exactly once.
 */
async function readResponseError(
  response: Response,
): Promise<{ payload: unknown; message: string }> {
  const payload = await response.json().catch(() => null);
  const message = canonicalApiErrorFromPayload(payload)?.message;
  return {
    payload,
    message: z.string().safeParse(message).data?.trim()
      ? z.string().parse(message)
      : "That didn't work. Try again.",
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const { payload, message } = await readResponseError(response);
    if (handleAuthRequired(response.status, payload)) {
      // Redirecting to the standalone Doorway; reject with a benign message so callers stop.
      throw new ApiError('Sign in to continue.');
    }
    throw new ApiError(message);
  }
  const payload = await response.json();
  // SAFETY: each caller selects the response type for a fixed Worker route;
  // this helper never crosses an external origin or accepts caller-provided JSON.
  return payload as T;
}

/** Refresh the short-lived gateway credential stored by a workspace agent. */
export async function refreshModelCredential(workspaceId: string): Promise<void> {
  const response = await mutatingFetch(`/api/workspaces/${workspaceId}/model-credential`, {
    method: 'POST',
  });
  if (response.ok) {
    if (response.status !== 204) {
      throw new ApiError("That didn't work. Try again.");
    }
    return;
  }

  const { payload, message } = await readResponseError(response);
  if (handleAuthRequired(response.status, payload)) {
    throw new ApiError('Sign in to continue.');
  }
  throw new ApiError(message);
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
  default: string;
}

export class ModelsQuotaError extends ApiError {}
export class ModelsAuthError extends ApiError {}
/** A 5xx from the catalog route — including the 502 the worker mints for
 * config/secret drift. Typed so the UI can surface a broken deployment
 * instead of silently hiding the picker. */
export class ModelsUnavailableError extends ApiError {}

export async function fetchModels(): Promise<ModelCatalog> {
  const response = await fetch(appPath('/api/models'), { credentials: 'include' });
  if (response.status === 401) {
    const { payload, message } = await readResponseError(response);
    if (handleAuthRequired(response.status, payload)) {
      throw new ModelsAuthError('Your sign-in expired. Sign in again to load models.');
    }
    throw new ApiError(message);
  }
  if (response.status === 429) {
    const { message } = await readResponseError(response);
    throw new ModelsQuotaError(message);
  }
  if (response.status >= 500) {
    const { message } = await readResponseError(response);
    throw new ModelsUnavailableError(message);
  }
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
    const response = await sessionFetch(`/api/gallery?${query}`);
    const payload = await parseJson<{ items: GalleryItem[]; nextCursor?: string }>(response);
    items.push(...payload.items);
    cursor = payload.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new ApiError("Couldn't load the gallery. Try again.");
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
  const response = await sessionFetch(`/api/gallery/${galleryId}`);
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

export async function fetchWorkspaceExport(workspaceId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await readingFetch(`/api/workspaces/${workspaceId}/export`);
  if (!response.ok) {
    // Keep export aligned with the other protected workspace reads. If the
    // session expires while a download is being prepared, send the user
    // through the canonical sign-in recovery path instead of leaving them
    // with an opaque download failure.
    const { payload, message } = await readResponseError(response);
    if (handleAuthRequired(response.status, payload)) {
      throw new ApiError('Sign in to continue.');
    }
    throw new ApiError(message);
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
