import { getAgentByName, routeAgentRequest } from 'agents';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { WorkspaceAgent } from './agent/workspace-agent';
import type { WorkspaceFileInfo, WorkspacePanel, WorkspaceRecord } from './domain/workspace';
import { validateAgentStudioConfig, type AgentStudioConfigValidation, type Env } from './env';
import {
  cloneGalleryItem,
  GalleryError,
  getGalleryItem,
  listGalleryItems,
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
import { resolveCailModelName } from './lib/cail-model';
import { patchWorkspaceSchema } from './lib/workspace-validation';
import {
  cailIdentityJwt,
  requireSession,
  sessionMiddleware,
  type SessionVariables,
} from './lib/session';
import {
  csrfMiddleware,
  csrfReadMiddleware,
  deriveCsrfToken,
  setCsrfCookie,
  wsAgentCsrfValid,
  wsAgentSessionIdFromPath,
  wsOriginAllowed,
} from './lib/csrf';
import { rateLimitMiddleware } from './lib/rate-limit';
import {
  correlationFromHeaders,
  LOG_PRODUCT,
  logBoundaryEvent,
  STUDIO_EVENTS,
  studioLogger,
  withOutboundCorrelation,
  type CailCorrelation,
} from './lib/logging';
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
});

const runtimeExecuteSchema = z.object({
  code: z.string().trim().min(1).max(100_000),
});

const MAX_IMPORT_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILE_COUNT = 500;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 50;

const layoutSchema = z.object({
  panels: z.record(
    z.string(),
    z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    })
  ).optional(),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      panelIds: z.array(z.string()),
      color: z.string().optional(),
    })
  ).optional(),
  connections: z.array(
    z.object({
      id: z.string(),
      sourceId: z.string(),
      targetId: z.string(),
    })
  ).optional(),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number(),
  }).optional(),
});

const app = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

type AppVariables = SessionVariables & {
  workspace?: WorkspaceRecord;
  /** Correlation adopted (or minted) at the request boundary — see the boundary-log middleware. */
  logCorrelation?: CailCorrelation;
  /** Epoch ms when the boundary-log middleware first saw this request. */
  logStartedAt?: number;
};

type AppContext = Context<{
  Bindings: Env;
  Variables: AppVariables;
}>;

/**
 * The CLASSIFIED route label for the boundary log event: the matched route
 * PATTERN (e.g. `/api/workspaces/:id/files/*`), never the raw path — raw
 * paths carry workspace ids and filenames, which are content, not metadata.
 * Middleware registrations match with method 'ALL'; the final handler's
 * registration carries the real method, so scan from the end.
 */
function classifiedRoute(c: AppContext): string {
  const matched = c.req.matchedRoutes;
  for (let i = matched.length - 1; i >= 0; i -= 1) {
    const route = matched[i];
    if (route.method !== 'ALL' && route.path !== '*' && route.path !== '/*') {
      return route.path;
    }
  }
  return 'unmatched';
}

/** Emit the one wide boundary event for this request (fleet logging standard). */
function emitBoundaryEvent(c: AppContext, status: number, errorType?: string): void {
  logBoundaryEvent(studioLogger(c.env), {
    correlation: c.get('logCorrelation') ?? correlationFromHeaders(c.req.raw),
    method: c.req.method,
    route: classifiedRoute(c),
    status,
    durationMs: Date.now() - (c.get('logStartedAt') ?? Date.now()),
    subject: c.get('cailIdentity')?.subject,
    ...(errorType ? { errorType } : {}),
  });
}

// Validation failures are client errors: routes validate with zod .parse and
// rely on this mapping instead of try/catch at every call site. Each mapped
// response also emits the request's wide boundary event (thrown errors skip
// the boundary middleware's post-`next()` emit, so this is the only emitter
// on the throw path — never a double log).
app.onError((error, c) => {
  const respond = (response: Response, errorCode: string) => {
    emitBoundaryEvent(c, response.status, errorCode);
    return response;
  };
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return respond(c.json({ error: 'Invalid request body' }, 400), 'invalid_request');
  }
  if (error instanceof GalleryError) {
    return respond(c.json({ error: error.message }, error.status), 'gallery_error');
  }
  if (error instanceof ModelCatalogAuthError) {
    return respond(c.json({ error: 'Model catalog authentication failed' }, 502), 'upstream_auth_failed');
  }
  if (error instanceof ModelCatalogQuotaError) {
    return respond(c.json({ error: 'quota_exceeded', message: error.message }, 429), 'quota_exceeded');
  }
  return respond(c.json({ error: 'Internal error' }, 500), 'internal_error');
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
    return c.json({ error: 'Invalid workspace id' }, 400);
  }
  return next();
}

async function validateGalleryIdParam(
  c: AppContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  if (!isValidGalleryId(c.req.param('id') ?? '')) {
    return c.json({ error: 'Invalid gallery id' }, 400);
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
 * Push the caller's verified CAIL identity JWT into the workspace DO so its
 * model calls (which run over the client WebSocket, where the gateway header
 * is unavailable) can authenticate to the model proxy. No-op when anonymous.
 */
async function primeAgentCredential(
  c: AppContext,
  agent: Awaited<ReturnType<typeof getWorkspaceAgent>>
): Promise<void> {
  const jwt = cailIdentityJwt(c);
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
    return c.json({ error: 'Workspace not found' }, 404);
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
  if (options.primeCredential) {
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

// ONE wide event per unit of work at the HTTP boundary (fleet logging
// standard, 2026-07-11). Registered before every other middleware so the
// timer covers the whole request and the correlation ids exist for the rest
// of the chain. Correlation is adopted from the gateway's `traceparent` /
// `X-CAIL-Request-Id` when present, minted otherwise ("adopt, never
// regenerate"). Runs on '*' so /health and unmatched routes are covered too.
// Success path emits here after `next()`; thrown errors bypass this emit and
// are logged exactly once by app.onError above.
app.use('*', async (c, next) => {
  c.set('logCorrelation', correlationFromHeaders(c.req.raw));
  c.set('logStartedAt', Date.now());
  await next();
  emitBoundaryEvent(c, c.res.status);
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

app.get('/health', (c) => {
  const config = validateAgentStudioConfig(c.env);
  if (!config.ok) {
    return c.json(
      { ok: false, service: 'agent-studio', error: 'configuration_invalid', errorCode: config.errorCode },
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
  const csrfToken = await deriveCsrfToken(sessionId, c.env.SESSION_SECRET);
  setCsrfCookie(c, csrfToken);
  return c.json({ sessionId });
});

app.get('/api/models', async (c) => {
  requireSession(c);
  const correlation = c.get('logCorrelation') ?? correlationFromHeaders(c.req.raw);
  const { models, source } = await fetchCailModels({
    env: c.env,
    identityJwt: cailIdentityJwt(c),
    // fetchCailModels only calls this adapter with a URL string; its public
    // injection type is the wider platform fetch overload.
    fetchImpl: withOutboundCorrelation(fetch, correlation) as typeof fetch,
  });
  const recommended = models.find((model) => model.recommended) ?? models[0];
  return c.json({
    models,
    source,
    default: recommended?.id ?? resolveCailModelName(c.env),
  });
});

app.get('/api/workspaces', async (c) => {
  const sessionId = requireSession(c);
  const workspaces = await listWorkspaces(c.env, sessionId);
  return c.json({ workspaces });
});

app.get('/api/gallery', async (c) => {
  const items = await listGalleryItems(c.env);
  return c.json({ items });
});

app.get('/api/gallery/:id', async (c) => {
  const item = await getGalleryItem(c.env, c.req.param('id'));
  if (!item) {
    return c.json({ error: 'Gallery item not found' }, 404);
  }
  return c.json({ item });
});

app.get('/api/gallery/:id/panels/:panelId/preview', async (c) => {
  const item = await getGalleryItem(c.env, c.req.param('id'));
  if (!item) {
    return c.json({ error: 'Gallery item not found' }, 404);
  }

  const panel = item.state.panels.find((candidate) => candidate.id === c.req.param('panelId'));
  if (!panel || panel.type !== 'preview' || panel.filePath || !panel.content) {
    return c.json({ error: 'Preview panel not found' }, 404);
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
    return c.json({ error: 'Gallery file not found' }, 404);
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
    await putWorkspace(c.env, sessionId, workspace);
    ({ agent } = await syncedWorkspaceAgent(c, workspace, { primeCredential: true }));

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
  } catch (error) {
    if (agent) {
      await agent.clearWorkspaceFiles().catch(() => undefined);
    }
    await deleteWorkspaceFiles(c.env, sessionId, workspaceId).catch(() => undefined);
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

  await putWorkspace(c.env, sessionId, workspace);
  await syncedWorkspaceAgent(c, workspace, { primeCredential: true });

  return c.json({ workspace }, 201);
});

app.post('/api/workspaces/import', async (c) => {
  const sessionId = requireSession(c);
  const form = await c.req.formData();
  const bundleFile = form.get('bundle');
  if (!(bundleFile instanceof File)) {
    return c.json({ error: 'No workspace bundle provided' }, 400);
  }
  if (bundleFile.size > MAX_IMPORT_BUNDLE_BYTES) {
    return c.json({ error: 'Workspace bundle exceeds the 50 MB import limit' }, 400);
  }

  let bundle;
  try {
    bundle = parseWorkspaceImportBundle(JSON.parse(await bundleFile.text()));
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Invalid workspace bundle',
    }, 400);
  }
  if (bundle.files.length > MAX_IMPORT_FILE_COUNT) {
    return c.json({ error: `Workspace bundle exceeds the ${MAX_IMPORT_FILE_COUNT} file import limit` }, 400);
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
    await putWorkspace(c.env, sessionId, workspace);
    ({ agent } = await syncedWorkspaceAgent(c, workspace, { primeCredential: true }));
    await Promise.all(
      bundle.files.map((file) => agent!.writeWorkspaceFileContent(
        sanitizeRelativePath(file.path),
        decodeWorkspaceImportFile(file),
        file.contentType
      ))
    );

    await agent.replaceWorkspaceState(bundle.state, workspace, sessionId);
    await agent.persistMessages(bundle.messages);
  } catch (error) {
    if (agent) {
      await agent.clearWorkspaceFiles().catch(() => undefined);
    }
    await deleteWorkspace(c.env, sessionId, workspaceId);
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to import workspace',
    }, 400);
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
    return c.json({ error: 'Preview panel not found' }, 404);
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

app.get('/api/workspaces/:id/observability', async (c) => {
  const workspace = loadedWorkspace(c);
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const observability = await agent.getObservability();

  return c.json({ observability });
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
    return c.json({ error: 'Invalid workspace update' }, 400);
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
      ? c.json({ error: 'Workspace not found' }, 404)
      : c.json({ error: 'Conflicting concurrent update; retry' }, 409);
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
    files,
    readFile: (filePath) => agent.readWorkspaceFileContent(filePath),
  });

  // CAS stamp (V2): the record was captured at request start, so a blind put
  // here would revert a PATCH (e.g. a model override) that landed while the
  // gallery item was being published.
  const result = await updateWorkspaceWithRetry(c.env, sessionId, workspace.id, (current) => ({
    ...current,
    galleryId: item.id,
    updatedAt: new Date().toISOString(),
  }));
  if (!result.ok) {
    return result.reason === 'not-found'
      ? c.json({ error: 'Workspace not found' }, 404)
      : c.json({ error: 'Conflicting concurrent update; retry' }, 409);
  }
  await agent.syncWorkspace(result.workspace, sessionId);

  return c.json({ item, workspace: result.workspace }, 201);
});

app.delete('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  // Delete must not depend on hydration: syncWorkspace would run legacy
  // hydration, so a workspace with an unreadable legacy file could never be
  // deleted. Clear the runtime best-effort, then drop the R2 records.
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.clearWorkspaceFiles().catch(() => undefined);
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
    return c.json({ error: 'File not found' }, 404);
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
    return c.json({ error: uploadVerdict.reason || 'File type not allowed' }, 400);
  }
  const body = await c.req.arrayBuffer();
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
    return c.json({ error: 'No files provided' }, 400);
  }
  if (files.length > MAX_UPLOAD_FILE_COUNT) {
    return c.json({ error: `Upload limit is ${MAX_UPLOAD_FILE_COUNT} files per request` }, 400);
  }

  // Phase 1: validate all files before writing any of them.
  for (const file of files) {
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      return c.json({ error: `${file.name} exceeds the 25 MB upload limit` }, 400);
    }
    const verdict = isAllowedUpload(file);
    if (!verdict.allowed) {
      return c.json({ error: `${file.name}: ${verdict.reason}` }, 400);
    }
  }

  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const written: string[] = [];
  try {
    const uploaded = [];
    for (const file of files) {
      const filePath = sanitizeRelativePath(file.name.trim());
      await agent.writeWorkspaceFileContent(filePath, await file.arrayBuffer(), file.type || undefined);
      written.push(filePath);
      uploaded.push({
        name: filePath.split('/').pop() || filePath,
        path: filePath,
        size: file.size,
      });
    }
    return c.json({ success: true, files: uploaded }, 201);
  } catch (error) {
    await Promise.all(
      written.map((filePath) => agent.deleteWorkspaceFileContent(filePath).catch(() => undefined))
    );
    return c.json({
      error: error instanceof Error ? error.message : 'Upload failed',
    }, 400);
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
    return c.json({ error: 'Invalid panel payload' }, 400);
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
  const patch = layoutSchema.parse(await c.req.json());
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.applyLayoutPatch(patch);

  return c.json({ success: true, state });
});

export { WorkspaceAgent };
export { MigrationRegistry } from './migration-registry';

// AS-3-10 deploy-footgun guard. Several intentionally permissive local-dev
// defaults are unsafe on the shared production host. Warn loudly once so a
// deploy that missed its injected model proxy, identity gate, or cookie base
// path is obvious in logs. Those optional settings remain warnings; the
// required SESSION_SECRET is validated separately and fails startup traffic.
let cailConfigChecked = false;
function checkCailConfigOnce(env: Env, config: AgentStudioConfigValidation): void {
  if (cailConfigChecked) return;
  cailConfigChecked = true;
  const base = env.CAIL_API_BASE ?? '';
  const logConfigInvalid = (errorType: string) => studioLogger(env).emit(
    STUDIO_EVENTS.STARTUP_CONFIG_INVALID,
    {
      product_id: LOG_PRODUCT,
      terminal: { outcome: 'denied', reason: 'denied' },
      error_type: errorType,
    },
  );
  if (!config.ok) {
    logConfigInvalid(config.errorCode);
  }
  if (base.includes('REPLACE') || base.includes('.invalid')) {
    logConfigInvalid('cail_api_base_placeholder');
  }
  if (env.CAIL_REQUIRE_IDENTITY !== 'true') {
    logConfigInvalid('identity_not_required');
  }
  if (!env.CAIL_BASE_PATH || !env.CAIL_BASE_PATH.trim()) {
    const sharedHost = Boolean(env.CAIL_CANONICAL_ORIGIN);
    logConfigInvalid(sharedHost ? 'shared_host_base_path_missing' : 'base_path_missing');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = validateAgentStudioConfig(env);
    checkCailConfigOnce(env, config);
    if (!config.ok && new URL(request.url).pathname !== '/health') {
      return Response.json(
        { error: 'Service unavailable: invalid configuration', errorCode: config.errorCode },
        { status: 503 }
      );
    }
    // Origin-check the /agents/* WebSocket upgrade BEFORE routeAgentRequest
    // accepts it (rule 4): the browser does not enforce same-origin on WS
    // handshakes, and the connection-lifetime identity JWT means an origin
    // mistake at accept time is unrecoverable. A present-but-mismatched Origin
    // is rejected here; the per-connection CSRF token gate then runs inside the
    // Durable Object on connect (see WorkspaceAgent.onConnect).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // These 403s never reach the Hono boundary middleware, so they emit
      // their own auth.denied wide event (route label, never the raw path).
      const denyUpgrade = (errorCode: string, body: string): Response => {
        logBoundaryEvent(studioLogger(env), {
          correlation: correlationFromHeaders(request),
          method: request.method,
          route: 'agents/ws-upgrade',
          status: 403,
          durationMs: 0,
          errorType: errorCode,
        });
        return new Response(body, { status: 403 });
      };
      if (!wsOriginAllowed(request, env.CAIL_CANONICAL_ORIGIN)) {
        return denyUpgrade('ws_origin_mismatch', 'Forbidden: cross-origin WebSocket upgrade');
      }
      // Reject an unauthenticated /agents/* socket at the edge, before routeAgentRequest
      // instantiates the DO — the SDK sends the full persisted state on connect BEFORE the
      // DO's onConnect can close the socket, so the token must be checked here (A2).
      const wsPath = new URL(request.url).pathname;
      if (wsAgentSessionIdFromPath(wsPath) && !(await wsAgentCsrfValid(request, env.SESSION_SECRET))) {
        return denyUpgrade('ws_csrf_invalid', 'Forbidden: missing or invalid connection token');
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
