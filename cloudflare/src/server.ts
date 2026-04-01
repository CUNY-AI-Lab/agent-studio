import { getAgentByName, routeAgentRequest } from 'agents';
import { Hono } from 'hono';
import { z } from 'zod';
import { WorkspaceAgent } from './agent/workspace-agent';
import type { WorkspaceFileInfo, WorkspacePanel } from './domain/workspace';
import type { Env } from './env';
import {
  cloneGalleryItem,
  getGalleryItem,
  listGalleryItems,
  publishWorkspace as publishGalleryWorkspace,
  unpublishGalleryItem,
} from './lib/gallery';
import { createWorkspaceExportBundle } from './lib/export';
import { decodeWorkspaceImportFile, parseWorkspaceImportBundle } from './lib/import';
import { clearWorkspaceDownloads, getWorkspaceDownloads } from './lib/downloads';
import {
  deleteWorkspaceFiles,
  getMimeType,
  listGalleryFilesRecursive,
  readGalleryFile,
  sanitizeRelativePath,
} from './lib/files';
import { createOpaqueId, createWorkspaceAgentName } from './lib/ids';
import { requireSession, sessionMiddleware } from './lib/session';
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

const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
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
  Variables: { sessionId: string };
}>();

function getWorkspaceAgent(env: Env, sessionId: string, workspaceId: string) {
  return getAgentByName<Env, WorkspaceAgent>(
    env.WorkspaceAgent,
    createWorkspaceAgentName(sessionId, workspaceId)
  );
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

function previewHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Embedder-Policy': 'unsafe-none',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh",
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net",
      "img-src 'self' data: blob: https: http:",
      "connect-src 'self' https: http:",
      "frame-ancestors 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

app.use('/api/*', sessionMiddleware);

app.get('/health', (c) => c.json({ ok: true, service: 'agent-studio' }));

app.get('/api/session', (c) => c.json({ sessionId: requireSession(c) }));

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
    headers: previewHeaders(),
  });
});

app.get('/api/gallery/:id/files/*', async (c) => {
  const galleryId = c.req.param('id');
  const filePath = c.req.path.split(`/api/gallery/${galleryId}/files/`)[1] || '';
  const object = await readGalleryFile(c.env, galleryId, filePath);
  if (!object) {
    return c.json({ error: 'Gallery file not found' }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': object.httpMetadata?.contentType || getMimeType(filePath),
      'Content-Length': object.size.toString(),
      'Cache-Control': 'private, max-age=3600',
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

  await putWorkspace(c.env, sessionId, workspace);
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);

  const galleryFiles = await listGalleryFilesRecursive(c.env, sourceGalleryId);
  await Promise.all(
    galleryFiles
      .filter((file) => !file.isDirectory)
      .map(async (file) => {
        const object = await readGalleryFile(c.env, sourceGalleryId, file.path);
        if (!object) return;
        await agent.writeWorkspaceFileContent(
          sanitizeRelativePath(file.path),
          await object.arrayBuffer(),
          object.httpMetadata?.contentType || getMimeType(file.path)
        );
      })
  );
  await agent.replaceWorkspaceState(item.state, workspace, sessionId);

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
  const body = createWorkspaceSchema.parse(await c.req.json().catch(() => ({})));
  const workspace = createDefaultWorkspace({
    id: createOpaqueId(),
    name: body.name,
    description: body.description,
  });

  await putWorkspace(c.env, sessionId, workspace);
  const agent = await getWorkspaceAgent(c.env, sessionId, workspace.id);
  await agent.syncWorkspace(workspace, sessionId);

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
  };

  let agent: Awaited<ReturnType<typeof getWorkspaceAgent>> | null = null;

  try {
    await putWorkspace(c.env, sessionId, workspace);
    agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
    await agent.syncWorkspace(workspace, sessionId);
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
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agentName = createWorkspaceAgentName(sessionId, workspaceId);
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
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
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const state = await agent.getSnapshot();
  const panel = state.panels.find((candidate) => candidate.id === c.req.param('panelId'));
  if (!panel || panel.type !== 'preview' || panel.filePath || !panel.content) {
    return c.json({ error: 'Preview panel not found' }, 404);
  }

  return new Response(panel.content, {
    status: 200,
    headers: previewHeaders(),
  });
});

app.delete('/api/workspaces/:id/downloads', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  await clearWorkspaceDownloads(c.env, sessionId, workspaceId);
  return c.json({ success: true });
});

app.get('/api/workspaces/:id/downloads', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const downloads = await getWorkspaceDownloads(c.env, sessionId, workspaceId);
  return c.json({ downloads });
});

app.get('/api/workspaces/:id/runtime', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const runtime = await agent.getRuntimeInfo();

  return c.json({ runtime });
});

app.get('/api/workspaces/:id/observability', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const observability = await agent.getObservability();

  return c.json({ observability });
});

app.post('/api/workspaces/:id/runtime/execute', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const body = runtimeExecuteSchema.parse(await c.req.json().catch(() => ({})));
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const execution = await agent.executeCode(body.code);

  return c.json({ execution });
});

app.patch('/api/workspaces/:id', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const patch = patchWorkspaceSchema.parse(await c.req.json().catch(() => ({})));
  const nextWorkspace = {
    ...workspace,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    updatedAt: new Date().toISOString(),
  };

  await putWorkspace(c.env, sessionId, nextWorkspace);
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(nextWorkspace, sessionId);

  return c.json({ workspace: nextWorkspace });
});

app.get('/api/workspaces/:id/export', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
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
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const body = publishWorkspaceSchema.parse(await c.req.json().catch(() => ({})));
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
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
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  await agent.clearWorkspaceFiles();
  await deleteWorkspaceFiles(c.env, sessionId, workspaceId);
  await deleteWorkspace(c.env, sessionId, workspaceId);
  return c.json({ success: true });
});

app.get('/api/workspaces/:id/files', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const dir = c.req.query('dir') || '';
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const files = listDirectoryEntries(await agent.getWorkspaceFiles(), dir);
  return c.json({ files });
});

app.get('/api/workspaces/:id/files/*', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const file = await agent.readWorkspaceFileContent(filePath);
  if (!file) {
    return c.json({ error: 'File not found' }, 404);
  }

  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': file.contentType || getMimeType(filePath),
      'Content-Length': file.data.byteLength.toString(),
      'Cache-Control': 'no-store',
    },
  });
});

app.put('/api/workspaces/:id/files/*', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  const body = await c.req.arrayBuffer();
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  await agent.writeWorkspaceFileContent(filePath, body, c.req.header('content-type') || undefined);
  return c.json({ success: true, filePath });
});

app.delete('/api/workspaces/:id/files/*', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const filePath = c.req.path.split(`/api/workspaces/${workspaceId}/files/`)[1] || '';
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  await agent.deleteWorkspaceFileContent(filePath);
  return c.json({ success: true, filePath });
});

app.post('/api/workspaces/:id/upload', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

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
    const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
    await agent.syncWorkspace(workspace, sessionId);
    uploaded = await Promise.all(
      files.map(async (file) => {
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
          throw new Error(`${file.name} exceeds the 25 MB upload limit`);
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
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const panel = body?.panel as WorkspacePanel | undefined;
  if (!panel || typeof panel !== 'object' || typeof panel.id !== 'string' || typeof panel.type !== 'string') {
    return c.json({ error: 'Invalid panel payload' }, 400);
  }
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const state = await agent.addPanel(panel);

  return c.json({ success: true, state });
});

app.delete('/api/workspaces/:id/panels/:panelId', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const state = await agent.removePanel(c.req.param('panelId'));

  return c.json({ success: true, state });
});

app.patch('/api/workspaces/:id/layout', async (c) => {
  const sessionId = requireSession(c);
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspace(c.env, sessionId, workspaceId);
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }

  const patch = layoutSchema.parse(await c.req.json().catch(() => ({})));
  const agent = await getWorkspaceAgent(c.env, sessionId, workspaceId);
  await agent.syncWorkspace(workspace, sessionId);
  const state = await agent.applyLayoutPatch(patch);

  return c.json({ success: true, state });
});

export { WorkspaceAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }
    return app.fetch(request, env, ctx);
  },
};
