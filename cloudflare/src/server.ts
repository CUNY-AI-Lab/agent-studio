import { getAgentByName, routeAgentRequest } from 'agents';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { WorkspaceAgent } from './agent/workspace-agent';
import { MigrationRegistry } from './migration-registry';
import type { WorkspaceFileInfo, WorkspacePanel, WorkspaceRecord } from './domain/workspace';
import { validateAgentStudioConfig, type Env } from './env';
import {
  cloneGalleryItem,
  GalleryError,
  getGalleryItem,
  listGalleryItemsPage,
  publishWorkspace as publishGalleryWorkspace,
  unpublishGalleryItem,
} from './lib/gallery';
import { createWorkspaceExportBundle } from './lib/export';
import { decodeWorkspaceImportFile, panelSchema, parseWorkspaceImportBundle } from './lib/import';
import { clearWorkspaceDownloads, getWorkspaceDownloads } from './lib/downloads';
import {
  deleteByPrefix,
  deleteWorkspaceFiles,
  getMimeType,
  getRuntimeFilesPrefix,
  listGalleryFilesRecursive,
  readGalleryFile,
  sanitizeRelativePath,
} from './lib/files';
import {
  createOpaqueId,
  createWorkspaceAgentName,
  isValidGalleryId,
  isValidWorkspaceId,
} from './lib/ids';
import {
  fetchCailModels,
  ModelCatalogAuthError,
  ModelCatalogQuotaError,
} from './lib/cail-models';
import {
  layoutPatchSchema,
  patchWorkspaceSchema,
  runtimeCodeSchema,
} from './lib/workspace-validation';
import {
  cailGatewayJwt,
  requireSession,
  sessionMiddleware,
  type SessionVariables,
} from './lib/session';
import {
  csrfMiddleware,
  csrfReadMiddleware,
  mintCsrfToken,
  setCsrfCookie,
  wsAgentCsrfValid,
  wsAgentSessionIdFromPath,
  wsOriginAllowed,
} from './lib/csrf';
import { rateLimitMiddleware } from './lib/rate-limit';
import { stripBasePath } from './lib/base-path';
import { canonicalError } from './lib/error-envelope';
import { isAllowedUpload } from './lib/upload-validation';
import { fileServingHeaders, previewServingHeaders } from './lib/file-serving';
import {
  createDefaultWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  putWorkspace,
  updateWorkspaceWithRetry,
} from './lib/workspaces';

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Untitled Workspace'),
  description: z.string().max(2000).optional(),
});


const publishWorkspaceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  operationId: z.uuid().optional(),
});

const runtimeExecuteSchema = z.object({ code: runtimeCodeSchema });

const MAX_IMPORT_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILE_COUNT = 500;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 50;
const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;

const app = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

type AppVariables = SessionVariables & { workspace?: WorkspaceRecord };

type AppContext = Context<{
  Bindings: Env;
  Variables: AppVariables;
}>;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

function jsonError(
  c: AppContext,
  status: ErrorStatus,
  code: string,
  message: string,
  options: Parameters<typeof canonicalError>[2] = {},
) {
  return c.json(canonicalError(code, message, options), status);
}

// Validation failures are client errors: routes validate with zod .parse and
// rely on this mapping instead of try/catch at every call site. The outer
// boundary middleware resumes after Hono maps the throw and remains the single
// request-event emitter.
app.onError((error, c) => {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return c.json(canonicalError('invalid_request', 'Invalid request body'), 400);
  }
  if (error instanceof GalleryError) {
    return c.json(canonicalError(error.status === 404 ? 'not_found' : 'forbidden', error.message), error.status);
  }
  if (error instanceof ModelCatalogAuthError) {
    return c.json(canonicalError('authentication_required', 'Model catalog authentication failed', { type: 'authentication_error', retryable: false }), 502);
  }
  if (error instanceof ModelCatalogQuotaError) {
    return c.json(canonicalError('quota_exceeded', error.message, { type: 'rate_limit_error', retryable: false }), 429);
  }
  return c.json(canonicalError('internal_error', 'Internal error', { type: 'api_error', retryable: true }), 500);
});

// AS-3-6 boundary checks. `import` is a literal POST sub-route of
// /api/workspaces, not a workspace id, so it is exempt from id-shape validation.
async function validateWorkspaceIdParam(
  c: AppContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  const id = c.req.param('id') ?? '';
  if (id === 'import') return next();
  if (!isValidWorkspaceId(id)) {
    return jsonError(c, 400, 'invalid_workspace_id', 'Invalid workspace id');
  }
  return next();
}

async function validateGalleryIdParam(
  c: AppContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  if (!isValidGalleryId(c.req.param('id') ?? '')) {
    return jsonError(c, 400, 'invalid_gallery_id', 'Invalid gallery id');
  }
  return next();
}

function getWorkspaceAgent(env: Env, sessionId: string, workspaceId: string) {
  // workers-types v5 adds facet-only private members to its generic DO stub.
  // The current Agents SDK runtime accepts this namespace, but its public
  // helper declaration still models the pre-facet structural constraint.
  const getWorkspaceByName = getAgentByName as unknown as (
    namespace: DurableObjectNamespace<WorkspaceAgent>,
    name: string,
  ) => Promise<DurableObjectStub<WorkspaceAgent>>;
  return getWorkspaceByName(
    env.WorkspaceAgent,
    createWorkspaceAgentName(sessionId, workspaceId)
  );
}

/**
 * Push the caller's verified gateway JWT into the workspace DO so its model
 * calls (which run over the client WebSocket, where request headers are
 * unavailable) can authenticate to the model proxy. No-op when anonymous.
 */
async function primeAgentCredential(
  c: AppContext,
  agent: Awaited<ReturnType<typeof getWorkspaceAgent>>
): Promise<void> {
  const jwt = cailGatewayJwt(c);
  if (jwt) {
    await agent.setCailCredential(jwt);
  }
}

async function requireWorkspace(
  c: AppContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id') ?? '';
  if (workspaceId === 'import' && c.req.method === 'POST') return next();
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return jsonError(c, 404, 'not_found', 'Workspace not found');
  }
  c.set('workspace', workspace);
  return next();
}

async function syncedWorkspaceAgent(
  c: AppContext,
  workspace: WorkspaceRecord,
  options: { primeCredential?: boolean } = {},
): Promise<{
  sessionId: string;
  workspaceId: string;
  agent: Awaited<ReturnType<typeof getWorkspaceAgent>>;
}> {
  const sessionId = requireSession(c);
  const workspaceId = workspace.id;
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  // Every HTTP route is already behind verified session middleware. Prime by
  // default so an authenticated first request can use a mutation RPC without
  // relying on an earlier workspace GET to have initialized the DO identity.
  if (options.primeCredential !== false) {
    await primeAgentCredential(c, agent);
  }
  return { sessionId, workspaceId, agent };
}

function loadedWorkspace(c: AppContext): WorkspaceRecord {
  const workspace = c.get('workspace');
  if (!workspace) {
    throw new Error('loadedWorkspace: workspace not loaded');
  }
  return workspace;
}

function listDirectoryEntries(files: WorkspaceFileInfo[], dir = ''): WorkspaceFileInfo[] {
  const relativeDir = dir ? sanitizeRelativePath(dir) : '';
  return files
    .filter((file) => {
      const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      return parent === relativeDir;
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
}

app.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
});

app.use('/api/*', sessionMiddleware);
// CSRF enforcement runs after sessionMiddleware (it keys the fallback token by
// the session id that middleware sets) and before rate limiting / handlers, so
// a forged state-changing request is rejected with 403 before it does any work.
// Safe methods pass through this mutation gate — sensitive workspace GET/HEAD
// requests are covered by the path-specific read gate immediately below.
app.use('/api/*', csrfMiddleware);
app.use('/api/workspaces', csrfReadMiddleware);
app.use('/api/workspaces/:id', csrfReadMiddleware);
app.use('/api/workspaces/:id/*', csrfReadMiddleware);
// Rate limiting runs after sessionMiddleware because it keys by the session id
// that middleware sets. /health stays outside /api/* and is never limited.
app.use('/api/*', rateLimitMiddleware);

// AS-3-6: validate the :id path param shape at the route boundary before it is
// interpolated into any R2 key. No traversal risk (R2 does not normalize ".."),
// but a malformed id still yields a malformed key and a wasted round-trip.
// `/api/workspaces/import` is a literal sub-route, not an :id, so exempt it.
app.use('/api/workspaces/:id', validateWorkspaceIdParam);
app.use('/api/workspaces/:id/*', validateWorkspaceIdParam);
app.use('/api/workspaces/:id', requireWorkspace);
app.use('/api/workspaces/:id/*', requireWorkspace);
app.use('/api/gallery/:id', validateGalleryIdParam);
app.use('/api/gallery/:id/*', validateGalleryIdParam);

app.get('/health', async (c) => {
  const config = await validateAgentStudioConfig(c.env);
  if (!config.ok) {
    return c.json(
      {
        ok: false,
        service: 'agent-studio',
        ...canonicalError(
          config.errorCode,
          'Service unavailable: invalid configuration',
          { type: 'api_error', retryable: false },
        ),
      },
      503
    );
  }
  return c.json({ ok: true, service: 'agent-studio' });
});

// The session bootstrap the frontend hits first also delivers the per-session
// CSRF token (rule 3). Per the 2026-07-05 delivery amendment the token is
// delivered ONLY via a path-scoped Set-Cookie (cail_csrf_agentstudio) — never
// in the response body, because a same-origin sibling / user-content script
// could `fetch()` this endpoint and read a body-delivered token. The page reads
// the cookie (scoped to our path) and echoes it in X-CAIL-CSRF on every mutation
// and as the WebSocket connect token. The body carries only the session id.
app.get('/api/session', async (c) => {
  const sessionId = requireSession(c);
  const csrfToken = await mintCsrfToken(
    sessionId,
    c.env.SESSION_SECRET,
    c.get('cailIdentity') ? 'subject' : 'anonymous',
  );
  setCsrfCookie(c, csrfToken);
  return c.json({ sessionId });
});

app.get('/api/models', async (c) => {
  requireSession(c);
  const { models } = await fetchCailModels({
    env: c.env,
    identityJwt: cailGatewayJwt(c),
  });
  const recommended = models.find((model) => model.recommended) ?? models[0];
  return c.json({
    models,
    default: recommended.id,
  });
});

app.get('/api/workspaces', async (c) => {
  const sessionId = requireSession(c);
  const workspaces = await listWorkspaces(c.env, sessionId);
  return c.json({ workspaces });
});

app.get('/api/gallery', async (c) => {
  const cursor = c.req.query('cursor') || undefined;
  if (cursor && cursor.length > 2048) {
    return jsonError(c, 400, 'invalid_cursor', 'Invalid gallery cursor');
  }
  const requestedLimit = Number(c.req.query('limit') || 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return jsonError(c, 400, 'invalid_limit', 'Gallery page limit must be between 1 and 100');
  }
  return c.json(await listGalleryItemsPage(c.env, { cursor, limit: requestedLimit }));
});

app.get('/api/gallery/:id', async (c) => {
  const item = await getGalleryItem(c.env, c.req.param('id'));
  if (!item) {
    return jsonError(c, 404, 'not_found', 'Gallery item not found');
  }
  return c.json({ item });
});

app.get('/api/gallery/:id/panels/:panelId/preview', async (c) => {
  const item = await getGalleryItem(c.env, c.req.param('id'));
  if (!item) {
    return jsonError(c, 404, 'not_found', 'Gallery item not found');
  }

  const panel = item.state.panels.find((candidate) => candidate.id === c.req.param('panelId'));
  if (!panel || panel.type !== 'preview' || panel.filePath || !panel.content) {
    return jsonError(c, 404, 'not_found', 'Preview panel not found');
  }

  return new Response(panel.content, {
    status: 200,
    headers: previewServingHeaders(),
  });
});

app.get('/api/gallery/:id/files/*', async (c) => {
  const galleryId = c.req.param('id');
  const filePath = c.req.path.split(`/api/gallery/${galleryId}/files/`)[1] || '';
  const object = await readGalleryFile(c.env, galleryId, filePath);
  if (!object) {
    return jsonError(c, 404, 'not_found', 'Gallery file not found');
  }

  const contentType = object.httpMetadata?.contentType || getMimeType(filePath);
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'private, max-age=3600',
      ...fileServingHeaders(contentType),
    },
  });
});

app.post('/api/gallery/:id', async (c) => {
  const sessionId = requireSession(c);
  const sourceGalleryId = c.req.param('id');
  const workspaceId = createOpaqueId();
  const item = await cloneGalleryItem({
    env: c.env,
    galleryId: sourceGalleryId,
    sessionId,
    workspaceId,
  });

  const now = new Date().toISOString();
  const workspace = createDefaultWorkspace({
    id: workspaceId,
    name: item.title,
    description: `Cloned from gallery: ${item.description}`,
  });
  workspace.createdAt = now;
  workspace.updatedAt = now;

  let agent: Awaited<ReturnType<typeof getWorkspaceAgent>> | null = null;

  try {
    agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
    await agent.syncWorkspace(workspace, sessionId);
    await primeAgentCredential(c, agent);

    // Copy only the published file OBJECTS (a listed file that is missing from
    // R2 is a genuine integrity failure). Panel `filePath`s that dangle — a
    // reference to a file deleted before publish — are tolerated: the panel
    // simply won't resolve its file, exactly as on the source workspace.
    // Consume each R2 body before the next read so at most one connection is
    // open at a time (Workers caps ~6 simultaneous open connections).
    const galleryFiles = await listGalleryFilesRecursive(c.env, sourceGalleryId);
    const missingPaths: string[] = [];
    for (const file of galleryFiles) {
      if (file.isDirectory) continue;
      const filePath = sanitizeRelativePath(file.path);
      const object = await readGalleryFile(c.env, sourceGalleryId, filePath);
      if (!object) {
        missingPaths.push(filePath);
        continue;
      }
      await agent.writeWorkspaceFileContent(
        filePath,
        await object.arrayBuffer(),
        object.httpMetadata?.contentType || getMimeType(filePath)
      );
    }
    if (missingPaths.length > 0) {
      throw new Error(`Gallery item ${sourceGalleryId} is missing file(s): ${missingPaths.join(', ')}`);
    }
    await agent.replaceWorkspaceState(item.state, workspace, sessionId);
    // Commit marker last: list/get routes cannot observe a half-cloned
    // workspace while files and state are still being copied.
    await putWorkspace(c.env, sessionId, workspace);
  } catch (error) {
    if (agent) {
      await agent.destroyWorkspaceState().catch(() => undefined);
    }
    await deleteWorkspaceFiles(c.env, sessionId, workspaceId).catch(() => undefined);
    await deleteByPrefix(c.env, getRuntimeFilesPrefix(sessionId, workspaceId))
      .catch(() => undefined);
    await deleteWorkspace(c.env, sessionId, workspaceId).catch(() => undefined);
    throw error;
  }

  return c.json({ workspaceId, workspace }, 201);
});

app.delete('/api/gallery/:id', async (c) => {
  const sessionId = requireSession(c);
  await unpublishGalleryItem(c.env, c.req.param('id'), sessionId);

  const galleryId = c.req.param('id');
  const workspaces = await listWorkspaces(c.env, sessionId);
  await Promise.all(workspaces.map(async (workspace) => {
    if (workspace.galleryId !== galleryId) return;
    // CAS rewrite (V2): the record came from the listWorkspaces read above, so
    // a blind put would revert a concurrent PATCH. Re-check the galleryId on
    // the fresh read; skip when another writer already cleared or changed it.
    const result = await updateWorkspaceWithRetry(c.env, sessionId, workspace.id, (current) =>
      current.galleryId === galleryId
        ? { ...current, galleryId: undefined, updatedAt: new Date().toISOString() }
        : null
    );
    // not-found: the workspace was deleted concurrently — nothing to rewrite.
    if (!result.ok && result.reason === 'conflict') {
      throw new Error(`Conflicting concurrent update while clearing galleryId on workspace ${workspace.id}`);
    }
  }));

  return c.json({ success: true });
});

app.post('/api/workspaces', async (c) => {
  const sessionId = requireSession(c);
  // Empty/malformed body -> `{}` -> name.default() -> 201 "Untitled Workspace".
  const body = createWorkspaceSchema.parse(await c.req.json());
  const workspace = createDefaultWorkspace({
    id: createOpaqueId(),
    name: body.name,
    description: body.description,
  });

  let agent: Awaited<ReturnType<typeof getWorkspaceAgent>> | null = null;
  try {
    agent = await getWorkspaceAgent(c.env, sessionId, workspace.id);
    await agent.syncWorkspace(workspace, sessionId);
    await primeAgentCredential(c, agent);
    await putWorkspace(c.env, sessionId, workspace);
  } catch (error) {
    if (agent) await agent.destroyWorkspaceState().catch(() => undefined);
    await deleteByPrefix(c.env, getRuntimeFilesPrefix(sessionId, workspace.id))
      .catch(() => undefined);
    throw error;
  }

  return c.json({ workspace }, 201);
});

app.post('/api/workspaces/import', async (c) => {
  const sessionId = requireSession(c);
  const form = await c.req.formData();
  const bundleFile = form.get('bundle');
  if (!(bundleFile instanceof File)) {
    return jsonError(c, 400, 'invalid_request', 'No workspace bundle provided');
  }
  if (bundleFile.size > MAX_IMPORT_BUNDLE_BYTES) {
    return jsonError(c, 400, 'payload_too_large', 'Workspace bundle exceeds the 50 MB import limit');
  }

  let bundle;
  try {
    bundle = parseWorkspaceImportBundle(JSON.parse(await bundleFile.text()));
  } catch (error) {
    return jsonError(c, 400, 'invalid_bundle', error instanceof Error ? error.message : 'Invalid workspace bundle');
  }
  if (bundle.files.length > MAX_IMPORT_FILE_COUNT) {
    return jsonError(c, 400, 'payload_too_large', `Workspace bundle exceeds the ${MAX_IMPORT_FILE_COUNT} file import limit`);
  }
  let decodedFiles: Array<{
    path: string;
    data: string | Uint8Array;
    contentType: string;
  }>;
  try {
    decodedFiles = bundle.files.map((file) => ({
      path: sanitizeRelativePath(file.path),
      data: decodeWorkspaceImportFile(file),
      contentType: file.contentType,
    }));
  } catch {
    return jsonError(c, 400, 'invalid_bundle', 'Workspace bundle contains an invalid file');
  }

  const workspaceId = createOpaqueId();
  const now = new Date().toISOString();
  const workspace = {
    id: workspaceId,
    name: bundle.workspace.name.trim() || 'Imported Workspace',
    description: bundle.workspace.description,
    createdAt: now,
    updatedAt: now,
    // Preserve a per-workspace model override across the export/import round-trip.
    ...(bundle.workspace.model ? { model: bundle.workspace.model } : {}),
  };

  let agent: Awaited<ReturnType<typeof getWorkspaceAgent>> | null = null;

  try {
    agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
    await agent.syncWorkspace(workspace, sessionId);
    await primeAgentCredential(c, agent);
    // Consume writes sequentially: RuntimeWorkspace/R2 has a bounded
    // connection budget, and Promise.all over the 500-file import ceiling can
    // otherwise produce a partial, ambiguous fan-out failure.
    for (const file of decodedFiles) {
      await agent.writeWorkspaceFileContent(file.path, file.data, file.contentType);
    }

    await agent.replaceWorkspaceState(bundle.state, workspace, sessionId);
    await agent.persistMessages(bundle.messages);
    // The R2 record is the visibility/commit marker for list/get routes.
    await putWorkspace(c.env, sessionId, workspace);
  } catch {
    if (agent) {
      await agent.destroyWorkspaceState().catch(() => undefined);
    }
    await deleteWorkspaceFiles(c.env, sessionId, workspaceId).catch(() => undefined);
    await deleteByPrefix(c.env, getRuntimeFilesPrefix(sessionId, workspaceId))
      .catch(() => undefined);
    await deleteWorkspace(c.env, sessionId, workspaceId).catch(() => undefined);
    return jsonError(c, 400, 'import_failed', 'Workspace import failed');
  }

  return c.json({ workspaceId, workspace }, 201);
});

app.get('/api/workspaces/:id', async (c) => {
  const workspace = loadedWorkspace(c);
  const sessionId = requireSession(c);
  const workspaceId = workspace.id;
  const agentName = createWorkspaceAgentName(sessionId, workspaceId);
  const { agent } = await syncedWorkspaceAgent(c, workspace, { primeCredential: true });
  const [state, messages, files, runtime] = await Promise.all([
    agent.getSnapshot(),
    agent.getMessages(),
    agent.getWorkspaceFiles(),
    agent.getRuntimeInfo(),
  ]);
  const downloads = await getWorkspaceDownloads(c.env, sessionId, workspaceId);

  return c.json({
    workspace,
    state,
    messages,
    files,
    downloads,
    runtime,
    agent: {
      className: 'WorkspaceAgent',
      name: agentName,
    },
  });
});

app.get('/api/workspaces/:id/panels/:panelId/preview', async (c) => {
  const workspace = loadedWorkspace(c);
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.getSnapshot();
  const panel = state.panels.find((candidate) => candidate.id === c.req.param('panelId'));
  if (!panel || panel.type !== 'preview' || panel.filePath || !panel.content) {
    return jsonError(c, 404, 'not_found', 'Preview panel not found');
  }

  return new Response(panel.content, {
    status: 200,
    headers: previewServingHeaders(),
  });
});

app.delete('/api/workspaces/:id/downloads', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = loadedWorkspace(c).id;

  await clearWorkspaceDownloads(c.env, sessionId, workspaceId);
  return c.json({ success: true });
});

app.get('/api/workspaces/:id/downloads', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = loadedWorkspace(c).id;

  const downloads = await getWorkspaceDownloads(c.env, sessionId, workspaceId);
  return c.json({ downloads });
});

app.get('/api/workspaces/:id/runtime', async (c) => {
  const workspace = loadedWorkspace(c);
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const runtime = await agent.getRuntimeInfo();

  return c.json({ runtime });
});

app.post('/api/workspaces/:id/runtime/execute', async (c) => {
  const workspace = loadedWorkspace(c);

  // Empty/malformed body -> `{}` -> zod (code required) -> 400.
  const body = runtimeExecuteSchema.parse(await c.req.json());
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const execution = await agent.executeCode(body.code);

  return c.json({ execution });
});

app.patch('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);

  // Empty/malformed body -> `{}` -> all-optional patch -> 200 no-op.
  const parsed = patchWorkspaceSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_request', 'Invalid workspace update');
  }
  const patch = parsed.data;

  // CAS retry so two concurrent field edits don't clobber each other (A12).
  const result = await updateWorkspaceWithRetry(c.env, sessionId, workspace.id, (current) => ({
    ...current,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    updatedAt: new Date().toISOString(),
  }));
  if (!result.ok) {
    return result.reason === 'not-found'
      ? jsonError(c, 404, 'not_found', 'Workspace not found')
      : jsonError(c, 409, 'conflict', 'Conflicting concurrent update; retry', { retryable: true });
  }
  await syncedWorkspaceAgent(c, result.workspace);

  return c.json({ workspace: result.workspace });
});

app.get('/api/workspaces/:id/export', async (c) => {
  const workspace = loadedWorkspace(c);
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const [state, messages, files] = await Promise.all([
    agent.getSnapshot(),
    agent.getMessages(),
    agent.getWorkspaceFiles(),
  ]);

  const bundle = await createWorkspaceExportBundle({
    workspace,
    state,
    messages,
    files,
    readFile: (filePath) => agent.readWorkspaceFileContent(filePath),
  });

  const filename = `${workspace.name || 'workspace'}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'workspace';

  return new Response(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.agent-studio.json"`,
      'Cache-Control': 'no-store',
    },
  });
});

app.post('/api/workspaces/:id/publish', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);

  // Empty/malformed body -> `{}` -> zod (title required) -> 400.
  const body = publishWorkspaceSchema.parse(await c.req.json());
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const [state, files] = await Promise.all([
    agent.getSnapshot(),
    agent.getWorkspaceFiles(),
  ]);

  const item = await publishGalleryWorkspace({
    env: c.env,
    sessionId,
    workspace,
    state,
    title: body.title,
    description: body.description,
    // A missing operation id is a new publish intent; never derive identity
    // from user-controlled title or description text.
    operationId: body.operationId ?? crypto.randomUUID(),
    files,
    readFile: (filePath) => agent.readWorkspaceFileContent(filePath),
  });

  // CAS stamp (V2): the record was captured at request start, so a blind put
  // here would revert a PATCH (e.g. a model override) that landed while the
  // gallery item was being published.
  const result = await updateWorkspaceWithRetry(c.env, sessionId, workspace.id, (current) => {
    // One live publication per workspace. Concurrent distinct publish intents
    // race on this CAS; the loser observes the winner's id, makes no metadata
    // change, and compensates its deterministic gallery object below.
    if (current.galleryId && current.galleryId !== item.id) return null;
    return {
      ...current,
      galleryId: item.id,
      updatedAt: new Date().toISOString(),
    };
  });
  if (!result.ok || result.workspace.galleryId !== item.id) {
    try {
      await unpublishGalleryItem(c.env, item.id, sessionId);
    } catch {
      throw new Error('publish_outcome_unknown: workspace stamp failed and gallery rollback was not confirmed');
    }
    return !result.ok && result.reason === 'not-found'
      ? jsonError(c, 404, 'not_found', 'Workspace not found')
      : jsonError(c, 409, 'conflict', 'Conflicting concurrent update; retry', { retryable: true });
  }
  await agent.syncWorkspace(result.workspace, sessionId);

  return c.json({ item, workspace: result.workspace }, 201);
});

app.delete('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  // The destructive RPC fences writers and fails loud before the R2 records
  // are removed.
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.destroyWorkspaceState();
  await deleteWorkspaceFiles(c.env, sessionId, workspaceId);
  // Runtime files live under a separate prefix the sessions-prefix delete
  // misses. This authoritative cleanup fails loud so deletion stays retryable.
  await deleteByPrefix(c.env, getRuntimeFilesPrefix(sessionId, workspaceId));
  await deleteWorkspace(c.env, sessionId, workspaceId);
  return c.json({ success: true });
});

app.get('/api/workspaces/:id/files', async (c) => {
  const workspace = loadedWorkspace(c);

  const dir = c.req.query('dir') || '';
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const files = listDirectoryEntries(await agent.getWorkspaceFiles(), dir);
  return c.json({ files });
});

app.get('/api/workspaces/:id/files/*', async (c) => {
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const file = await agent.readWorkspaceFileContent(filePath);
  if (!file) {
    return jsonError(c, 404, 'not_found', 'File not found');
  }

  const contentType = file.contentType || getMimeType(filePath);
  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': file.data.byteLength.toString(),
      'Cache-Control': 'no-store',
      ...fileServingHeaders(contentType),
    },
  });
});

app.put('/api/workspaces/:id/files/*', async (c) => {
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  // Defense-in-depth: reject active/disallowed types (e.g. .html/.svg) at the
  // write door. Insufficient alone — the agent's write_file tool bypasses this
  // HTTP route — which is why the file-serving sandbox headers are the real
  // containment (see lib/file-serving.ts). Strip any `; charset=` parameter so
  // the bare MIME is matched against the allowlist (mirrors /upload's File.type).
  const putContentType = c.req.header('content-type')?.split(';', 1)[0]?.trim() || undefined;
  const uploadVerdict = isAllowedUpload({ name: filePath, type: putContentType });
  if (!uploadVerdict.allowed) {
    return jsonError(c, 400, 'invalid_upload', uploadVerdict.reason || 'File type not allowed');
  }
  const declaredLength = Number(c.req.header('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_FILE_BYTES) {
    return jsonError(c, 413, 'payload_too_large', 'File exceeds the 25 MB upload limit');
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_FILE_BYTES) {
    return jsonError(c, 413, 'payload_too_large', 'File exceeds the 25 MB upload limit');
  }
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  await agent.writeWorkspaceFileContent(filePath, body, c.req.header('content-type') || undefined);
  return c.json({ success: true, filePath });
});

app.delete('/api/workspaces/:id/files/*', async (c) => {
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  await agent.deleteWorkspaceFileContent(filePath);
  return c.json({ success: true, filePath });
});

app.post('/api/workspaces/:id/upload', async (c) => {
  const workspace = loadedWorkspace(c);

  const form = await c.req.formData();
  const files = form.getAll('files').filter((item): item is File => item instanceof File);
  if (files.length === 0) {
    return jsonError(c, 400, 'invalid_request', 'No files provided');
  }
  if (files.length > MAX_UPLOAD_FILE_COUNT) {
    return jsonError(c, 400, 'payload_too_large', `Upload limit is ${MAX_UPLOAD_FILE_COUNT} files per request`);
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
    return jsonError(c, 400, 'payload_too_large', 'Upload request exceeds the 50 MB total limit');
  }

  // Phase 1: validate all files before writing any of them.
  const paths: string[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      return jsonError(c, 400, 'payload_too_large', `${file.name} exceeds the 25 MB upload limit`);
    }
    const verdict = isAllowedUpload(file);
    if (!verdict.allowed) {
      return jsonError(c, 400, 'invalid_upload', `${file.name}: ${verdict.reason}`);
    }
    try {
      paths.push(sanitizeRelativePath(file.name.trim()));
    } catch {
      return jsonError(c, 400, 'invalid_upload', `${file.name}: Invalid file path`);
    }
  }

  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const originals = new Map<string, Awaited<ReturnType<typeof agent.readWorkspaceFileContent>>>();
  for (const filePath of new Set(paths)) {
    originals.set(filePath, await agent.readWorkspaceFileContent(filePath));
  }
  try {
    const uploaded = [];
    for (const [index, file] of files.entries()) {
      const filePath = paths[index];
      await agent.writeWorkspaceFileContent(filePath, await file.arrayBuffer(), file.type || undefined);
      uploaded.push({
        name: filePath.split('/').pop() || filePath,
        path: filePath,
        size: file.size,
      });
    }
    return c.json({ success: true, files: uploaded }, 201);
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const [filePath, original] of originals) {
      try {
        if (original) {
          await agent.writeWorkspaceFileContent(filePath, original.data, original.contentType);
        } else {
          await agent.deleteWorkspaceFileContent(filePath);
        }
      } catch {
        rollbackFailures.push(filePath);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error('upload_outcome_unknown: rollback did not complete');
    }
    throw error;
  }
});

app.post('/api/workspaces/:id/panels', async (c) => {
  const workspace = loadedWorkspace(c);

  // Shape-validate the panel with the same discriminated-union schema the
  // import path uses (lib/import.ts panelSchema) — a single source of truth so a
  // third divergent copy can't drift. Rejects unknown types and unshaped fields
  // (400) instead of the old `typeof id/type === 'string'` check, which let an
  // attacker plant an arbitrary `type:'preview'` panel with a `<script>` content
  // body. The served CSP (previewServingHeaders) is the real containment; this
  // trims the inject surface as defense-in-depth.
  // Empty/malformed body -> `null` -> `null?.panel` (undefined) -> 400.
  const body = await c.req.json<{ panel?: unknown } | null>();
  const parsed = panelSchema.safeParse(body?.panel);
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_request', 'Invalid panel payload');
  }
  const panel = parsed.data as WorkspacePanel;
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.addPanel(panel);

  return c.json({ success: true, state });
});

app.delete('/api/workspaces/:id/panels/:panelId', async (c) => {
  const workspace = loadedWorkspace(c);

  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.removePanel(c.req.param('panelId'));

  return c.json({ success: true, state });
});

app.patch('/api/workspaces/:id/layout', async (c) => {
  const workspace = loadedWorkspace(c);

  // Empty/malformed body -> `{}` -> all-optional patch -> 200 no-op.
  const patch = layoutPatchSchema.parse(await c.req.json());
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.applyLayoutPatch(patch);

  return c.json({ success: true, state });
});

export { MigrationRegistry, WorkspaceAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const mountedRequest = stripBasePath(request, env.CAIL_BASE_PATH);
    if (!mountedRequest) {
      return new Response('Not Found', { status: 404 });
    }
    request = mountedRequest;
    const pathname = new URL(request.url).pathname;
    const config = await validateAgentStudioConfig(env);
    if (!config.ok && pathname !== '/health') {
      return Response.json(
        canonicalError(config.errorCode, 'Service unavailable: invalid configuration', {
          type: 'api_error',
          retryable: false,
        }),
        { status: 503 }
      );
    }

    // All external paths enter the Worker first. Static and SPA requests are
    // explicitly delegated only after the configured mount has been stripped;
    // root-absolute sibling paths can never fall through to the asset binding.
    if (
      pathname !== '/health'
      && !pathname.startsWith('/api/')
      && pathname !== '/api'
      && !pathname.startsWith('/agents/')
      && pathname !== '/agents'
    ) {
      return env.ASSETS.fetch(request);
    }
    // Origin-check the /agents/* WebSocket upgrade BEFORE routeAgentRequest
    // accepts it (rule 4): the browser does not enforce same-origin on WS
    // handshakes, and the connection-lifetime identity JWT means an origin
    // mistake at accept time is unrecoverable. A present-but-mismatched Origin
    // is rejected here; the per-connection CSRF token gate then runs inside the
    // Durable Object on connect (see WorkspaceAgent.onConnect).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (!wsOriginAllowed(request, env.CAIL_CANONICAL_ORIGIN)) {
        return new Response('Forbidden: cross-origin WebSocket upgrade', { status: 403 });
      }
      // Reject an unauthenticated /agents/* socket at the edge, before routeAgentRequest
      // instantiates the DO — the SDK sends the full persisted state on connect BEFORE the
      // DO's onConnect can close the socket, so the token must be checked here (A2).
      const wsPath = pathname;
      if (
        wsAgentSessionIdFromPath(wsPath)
        && !(await wsAgentCsrfValid(request, env.SESSION_SECRET, env.CAIL_REQUIRE_IDENTITY === 'true'))
      ) {
        return new Response('Forbidden: missing or invalid connection token', { status: 403 });
      }
    }
    const routeRequest = routeAgentRequest as unknown as (
      request: Request,
      routeEnv: Env,
    ) => Promise<Response | null>;
    const agentResponse = await routeRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }
    return app.fetch(request, env, ctx);
  },
};
