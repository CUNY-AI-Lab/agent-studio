import { getAgentByName, routeAgentRequest } from 'agents';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { WorkspaceAgent } from './agent/workspace-agent';
import type { WorkspaceFileInfo, WorkspacePanel, WorkspaceRecord } from './domain/workspace';
import type { Env } from './env';
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
  deleteWorkspaceFiles,
  getMimeType,
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
import { fetchCailModels, ModelCatalogAuthError } from './lib/cail-models';
import { resolveCailModelName } from './lib/cail-model';
import { patchWorkspaceSchema } from './lib/workspace-validation';
import { cailIdentityJwt, requireSession, sessionMiddleware, type SessionVariables } from './lib/session';
import { csrfMiddleware, deriveCsrfToken, setCsrfCookie, wsOriginAllowed } from './lib/csrf';
import { rateLimitMiddleware } from './lib/rate-limit';
import { isAllowedUpload } from './lib/upload-validation';
import { fileServingHeaders, previewServingHeaders } from './lib/file-serving';
import {
  createDefaultWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  putWorkspace,
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

/**
 * Read a JSON request body, substituting `fallback` when the body is absent or
 * unparseable (empty body, wrong content-type, malformed JSON — all of which
 * make `c.req.json()` throw). Collapses the six hand-rolled
 * `await c.req.json().catch(() => …)` sites into one place.
 *
 * Rule-5 posture note (2026-07-06): this is a deliberately-kept fallback, not a
 * fail-loud read. It exists because the routes that use it hand off to zod
 * immediately, and the observable malformed-body behavior differs per route by
 * design — see server-routes.test.mjs "malformed request body" block, which
 * pins every case:
 *   - POST /api/workspaces        -> `{}` -> createWorkspaceSchema's
 *                                    name.default() -> 201 "Untitled Workspace".
 *                                    The default-name UX is the load-bearing
 *                                    reason the swallow can't become fail-loud
 *                                    here without a sanctioned 201->400 change.
 *   - PATCH /api/workspaces/:id   -> `{}` -> all-optional patch -> 200 no-op.
 *   - PATCH …/layout              -> `{}` -> all-optional patch -> 200 no-op.
 *   - POST …/runtime/execute      -> `{}` -> zod (code required) -> 400.
 *   - POST …/publish              -> `{}` -> zod (title required) -> 400.
 *   - POST …/panels               -> `null` -> `null?.panel` -> 400.
 * The three 400 cases are already fail-loud via zod; the three 2xx cases are
 * behavior we preserve. Any future edit that changes a case fails those tests.
 */
async function safeJson<T>(c: Context, fallback: T): Promise<T> {
  return c.req.json<T>().catch(() => fallback);
}

const app = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

type AppVariables = SessionVariables & {
  workspace?: WorkspaceRecord;
};

type AppContext = Context<{
  Bindings: Env;
  Variables: AppVariables;
}>;

// Validation failures are client errors: routes validate with zod .parse and
// rely on this mapping instead of try/catch at every call site.
app.onError((error, c) => {
  if (error instanceof z.ZodError) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (error instanceof GalleryError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof ModelCatalogAuthError) {
    return c.json({ error: 'Model catalog authentication failed' }, 502);
  }
  console.error('Unhandled route error', { path: c.req.path, error });
  return c.json({ error: 'Internal error' }, 500);
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
  return getAgentByName<Env, WorkspaceAgent>(
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
  if (workspaceId === 'import') return next();
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
  return c.get('workspace') as WorkspaceRecord;
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

function stateFilePaths(panels: WorkspacePanel[]): string[] {
  return panels.flatMap((panel) => (
    'filePath' in panel && typeof panel.filePath === 'string' && panel.filePath
      ? [panel.filePath]
      : []
  ));
}

app.use('/api/*', sessionMiddleware);
// CSRF enforcement runs after sessionMiddleware (it keys the fallback token by
// the session id that middleware sets) and before rate limiting / handlers, so
// a forged state-changing request is rejected with 403 before it does any work.
// Safe methods (GET/HEAD) pass through untouched — see lib/csrf.ts.
app.use('/api/*', csrfMiddleware);
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

app.get('/health', (c) => c.json({ ok: true, service: 'agent-studio' }));

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
  const { models, source } = await fetchCailModels({
    env: c.env,
    identityJwt: cailIdentityJwt(c),
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

    const galleryFiles = await listGalleryFilesRecursive(c.env, sourceGalleryId);
    const expectedPaths = new Set([
      ...galleryFiles.filter((file) => !file.isDirectory).map((file) => file.path),
      ...stateFilePaths(item.state.panels),
    ]);
    const fileReads = await Promise.all(
      [...expectedPaths].map(async (filePath) => ({
        filePath,
        object: await readGalleryFile(c.env, sourceGalleryId, filePath),
      }))
    );
    const missingPaths = fileReads
      .filter(({ object }) => !object)
      .map(({ filePath }) => filePath);
    if (missingPaths.length > 0) {
      throw new Error(`Gallery item ${sourceGalleryId} is missing file(s): ${missingPaths.join(', ')}`);
    }

    await Promise.all(
      fileReads.map(async ({ filePath, object }) => {
        await agent!.writeWorkspaceFileContent(
          sanitizeRelativePath(filePath),
          await object!.arrayBuffer(),
          object!.httpMetadata?.contentType || getMimeType(filePath)
        );
      })
    );
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

  const workspaces = await listWorkspaces(c.env, sessionId);
  await Promise.all(workspaces.map(async (workspace) => {
    if (workspace.galleryId !== c.req.param('id')) return;
    const nextWorkspace = { ...workspace, galleryId: undefined, updatedAt: new Date().toISOString() };
    await putWorkspace(c.env, sessionId, nextWorkspace);
  }));

  return c.json({ success: true });
});

app.post('/api/workspaces', async (c) => {
  const sessionId = requireSession(c);
  // Empty/malformed body -> `{}` -> name.default() -> 201 "Untitled Workspace".
  const body = createWorkspaceSchema.parse(await safeJson(c, {}));
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
  const body = runtimeExecuteSchema.parse(await safeJson(c, {}));
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const execution = await agent.executeCode(body.code);

  return c.json({ execution });
});

app.patch('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);

  // Empty/malformed body -> `{}` -> all-optional patch -> 200 no-op.
  const parsed = patchWorkspaceSchema.safeParse(await safeJson(c, {}));
  if (!parsed.success) {
    return c.json({ error: 'Invalid workspace update' }, 400);
  }
  const patch = parsed.data;
  const nextWorkspace = {
    ...workspace,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    updatedAt: new Date().toISOString(),
  };

  await putWorkspace(c.env, sessionId, nextWorkspace);
  await syncedWorkspaceAgent(c, nextWorkspace);

  return c.json({ workspace: nextWorkspace });
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
  const body = publishWorkspaceSchema.parse(await safeJson(c, {}));
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

  const nextWorkspace = {
    ...workspace,
    galleryId: item.id,
    updatedAt: new Date().toISOString(),
  };
  await putWorkspace(c.env, sessionId, nextWorkspace);
  await agent.syncWorkspace(nextWorkspace, sessionId);

  return c.json({ item, workspace: nextWorkspace }, 201);
});

app.delete('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspace = loadedWorkspace(c);
  const workspaceId = workspace.id;

  const { agent } = await syncedWorkspaceAgent(c, workspace);
  await agent.clearWorkspaceFiles();
  await deleteWorkspaceFiles(c.env, sessionId, workspaceId);
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

  let uploaded: Array<{ name: string; path: string; size: number }>;
  try {
    const { agent } = await syncedWorkspaceAgent(c, workspace);
    uploaded = await Promise.all(
      files.map(async (file) => {
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
          throw new Error(`${file.name} exceeds the 25 MB upload limit`);
        }
        const verdict = isAllowedUpload(file);
        if (!verdict.allowed) {
          throw new Error(`${file.name}: ${verdict.reason}`);
        }

        const filePath = sanitizeRelativePath(file.name.trim());
        await agent.writeWorkspaceFileContent(filePath, await file.arrayBuffer(), file.type || undefined);
        return {
          name: filePath.split('/').pop() || filePath,
          path: filePath,
          size: file.size,
        };
      })
    );
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Upload failed',
    }, 400);
  }

  return c.json({ success: true, files: uploaded }, 201);
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
  const body = await safeJson<{ panel?: unknown } | null>(c, null);
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
  const patch = layoutSchema.parse(await safeJson(c, {}));
  const { agent } = await syncedWorkspaceAgent(c, workspace);
  const state = await agent.applyLayoutPatch(patch);

  return c.json({ success: true, state });
});

export { WorkspaceAgent };
export { MigrationRegistry } from './migration-registry';

// AS-3-10 deploy-footgun guard. CAIL_API_BASE ships as a `.invalid` placeholder
// and CAIL_REQUIRE_IDENTITY defaults false — both intentional for local dev. On
// the first request we warn loudly (once) if the placeholder was never replaced,
// so a real deploy that forgot to set the model proxy is obvious in the logs. We
// warn rather than throw: throwing would break local dev where the placeholder
// is expected.
let cailConfigChecked = false;
function checkCailConfigOnce(env: Env): void {
  if (cailConfigChecked) return;
  cailConfigChecked = true;
  const base = env.CAIL_API_BASE ?? '';
  if (base.includes('REPLACE') || base.includes('.invalid')) {
    console.warn(
      `[startup] CAIL_API_BASE is still a placeholder (${base}); the CAIL model ` +
        `proxy is unreachable. Set a real CAIL_API_BASE before deploying. ` +
        `(Expected in local dev; a deploy footgun in production.)`,
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    checkCailConfigOnce(env);
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
    }
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }
    return app.fetch(request, env, ctx);
  },
};
