#!/usr/bin/env bun
/**
 * Real browser acceptance for the deterministic Agent Studio canvas path.
 *
 * The script builds the checked-out frontend, starts a local Wrangler Worker,
 * and uses Playwright against that Worker. It creates a workspace through the
 * home page, seeds deterministic card panels through the local API (there is
 * no model call in this path), and then performs the user-visible canvas
 * actions: select, associate, disconnect, clear selection, pan, zoom, resize,
 * download, reload, and delete. It also uploads a real file, reads its preview
 * and downloaded bytes, imports a downloaded workspace export, and verifies
 * gallery publication and removal through the built application. Active HTML
 * must execute only inside an opaque preview, including mislabeled files.
 *
 * This is a browser/process integration test. It does not prove model
 * streaming, provider routing, or model-generated artifact quality; those
 * belong to the deterministic Worker/provider seams and their focused tests.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Locator,
  type Page,
} from 'playwright';
import { expect } from 'playwright/test';
import { z } from 'zod';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8787;
const HEALTH_TIMEOUT_MS = 30_000;
const STATE_TIMEOUT_MS = 10_000;

type WorkspaceViewport = {
  x: number;
  y: number;
  zoom: number;
};

type WorkspacePanelLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WorkspaceSnapshot = {
  viewport: WorkspaceViewport;
  panels: Array<{ id: string; layout?: WorkspacePanelLayout }>;
};

type BrowserPoint = {
  x: number;
  y: number;
};

type CanvasPoint = {
  position: BrowserPoint;
  absolute: BrowserPoint;
};

type AcceptanceOptions = {
  url?: string;
  port: number;
  noBuild: boolean;
  headed: boolean;
};

type ApiCallOptions<T> = {
  method?: string;
  body?: unknown;
  expectedStatus?: number;
  label: string;
  schema: z.ZodType<T>;
};

const HealthPayloadSchema = z.object({ ok: z.literal(true) }).passthrough();
const AcknowledgementPayloadSchema = z.object({}).passthrough();
const WorkspacePayloadSchema = z.object({
  state: z.object({
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
    panels: z.array(z.object({
      id: z.string(),
      layout: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).passthrough().optional(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
type WorkspacePayload = z.infer<typeof WorkspacePayloadSchema>;

function fail(message: string): never {
  throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function appPath(baseUrl: string, suffix: string): string {
  return new URL(suffix.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function applicationPath(baseUrl: string, suffix: string): string {
  const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
  return `${pathname}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function sanitizeFailure(error: Error): string {
  const message = error.message;
  return message
    .replace(/(?:https?:\/\/[^\s)]+|\?workspace=[^\s)&]+)/g, '[redacted]')
    .replace(/\/api\/workspaces\/[^/?\s)]+/g, '/api/workspaces/[workspace]')
    .replace(/\b(?:browser-source-cards|browser-target-cards|source-finding|related-finding)\b/g, '[fixture]')
    .replace(/\b[0-9a-f]{8,}\b/gi, '[id]');
}

async function apiCall<T>(
  page: Page,
  baseUrl: string,
  suffix: string,
  { method = 'GET', body, expectedStatus, label, schema }: ApiCallOptions<T>,
): Promise<T> {
  const path = applicationPath(baseUrl, suffix);
  const result = await page.evaluate(
    async ({ path: requestPath, method: requestMethod, body: requestBody }) => {
      const csrf = document.cookie
        .split('; ')
        .find((part) => part.startsWith('cail_csrf_agentstudio='))
        ?.split('=')[1];
      const headers: Record<string, string> = {};
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
      if (requestBody !== undefined) headers['Content-Type'] = 'application/json';
      const request: RequestInit = {
        method: requestMethod,
        headers,
        credentials: 'include',
      };
      if (requestBody !== undefined) request.body = JSON.stringify(requestBody);
      const response = await fetch(requestPath, request);
      return {
        status: response.status,
        payload: await response.json().catch(() => null),
      };
    },
    { path, method, body },
  );
  if (expectedStatus === undefined
    ? result.status < 200 || result.status >= 300
    : result.status !== expectedStatus) {
    fail(`${method} ${label} failed with HTTP ${result.status}`);
  }
  return schema.parse(result.payload);
}

function workspaceSnapshot(payload: WorkspacePayload): WorkspaceSnapshot {
  return {
    viewport: payload.state.viewport,
    panels: payload.state.panels,
  };
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(appPath(baseUrl, 'health'), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        try {
          HealthPayloadSchema.parse(await response.json());
          return;
        } catch {
          // The Worker can answer before its application health is ready.
        }
      }
    } catch {
      // The local Worker can take several seconds to bind its port.
    }
    await delay(250);
  }
  fail('Timed out waiting for local Worker health');
}

function startWorker(port: number): ChildProcess {
  return spawn(
    'bun',
    [
      'run',
      '--cwd',
      'cloudflare',
      'dev',
      '--port',
      String(port),
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'ignore',
    },
  );
}

async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker?.pid || worker.exitCode !== null) return;
  try {
    process.kill(-worker.pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolveExit) => worker.once('exit', () => resolveExit())),
    delay(10_000),
  ]);
  if (worker.exitCode === null) {
    try {
      process.kill(-worker.pid, 'SIGKILL');
    } catch {
      // The process group may have exited between the checks.
    }
  }
}

async function waitForStateChange(
  page: Page,
  baseUrl: string,
  workspaceId: string,
  predicate: (snapshot: WorkspaceSnapshot) => boolean,
  description: string,
): Promise<WorkspaceSnapshot> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}`, {
      label: 'read workspace state',
      schema: WorkspacePayloadSchema,
    });
    const snapshot = workspaceSnapshot(payload);
    if (predicate(snapshot)) return snapshot;
    await delay(100);
  }
  fail(`Timed out waiting for ${description}`);
}

function workspaceIdFromUrl(url: string): string {
  const workspaceId = new URL(url).searchParams.get('workspace');
  if (!workspaceId) fail('Workspace creation did not produce a workspace URL');
  return workspaceId;
}

function seedCards(page: Page, baseUrl: string, workspaceId: string): Promise<void> {
  const panels = [
    {
      id: 'browser-source-cards',
      type: 'cards',
      title: 'Source cards',
      items: [{
        id: 'source-finding',
        title: 'Source finding',
        subtitle: 'Deterministic browser fixture',
        description: 'This card is seeded through the local Worker API.',
        badge: 'Verified',
        metadata: { Source: 'local acceptance', Year: '2026' },
      }],
      layout: { x: 80, y: 80, width: 360, height: 260 },
    },
    {
      id: 'browser-target-cards',
      type: 'cards',
      title: 'Related cards',
      items: [{
        id: 'related-finding',
        title: 'Related finding',
        subtitle: 'Deterministic browser fixture',
        description: 'The second card supplies the association target.',
        badge: 'Linked',
        metadata: { Source: 'local acceptance', Year: '2026' },
      }],
      layout: { x: 560, y: 80, width: 360, height: 260 },
    },
  ] as const;
  return (async () => {
    for (const panel of panels) {
      await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}/panels`, {
        method: 'POST',
        body: { panel },
        label: 'create deterministic card panel',
        schema: AcknowledgementPayloadSchema,
      });
    }
    await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}/layout`, {
      method: 'PATCH',
      body: {
        panels: Object.fromEntries(panels.map((panel) => [panel.id, panel.layout])),
        viewport: { x: -220, y: -120, zoom: 0.95 },
      },
      label: 'set deterministic canvas layout',
      schema: AcknowledgementPayloadSchema,
    });
  })();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function panelLabel(title: string, type: string): RegExp {
  return new RegExp(`^${escapeRegExp(title)} \\(${escapeRegExp(type)} tile\\)(?:, selected)?$`);
}

function panelLocator(page: Page, title: string, type: string): Locator {
  return page.getByRole('group', { name: panelLabel(title, type) });
}

async function selectPanel(
  page: Page,
  title: string,
  type: string,
  modifier?: 'ControlOrMeta',
): Promise<void> {
  const panel = panelLocator(page, title, type);
  await expect(panel).toBeVisible();
  await panel.click({ modifiers: modifier ? [modifier] : [] });
}

function associationName(sourceTitle: string, targetTitle: string): RegExp {
  return new RegExp(`^Association between ${escapeRegExp(sourceTitle)} and ${escapeRegExp(targetTitle)}$`);
}

async function emptyCanvasPoint(page: Page, canvas: Locator): Promise<CanvasPoint> {
  const box = await canvas.boundingBox();
  if (!box) fail('Workspace canvas did not expose a browser bounding box');
  const position = await page.evaluate((bounds) => {
    const candidates = [
      [0.75, 0.5],
      [0.65, 0.5],
      [0.85, 0.5],
      [0.75, 0.7],
      [0.55, 0.75],
      [0.5, 0.5],
    ] as const;
    for (const [xFraction, yFraction] of candidates) {
      const x = bounds.x + bounds.width * xFraction;
      const y = bounds.y + bounds.height * yFraction;
      const target = document.elementFromPoint(x, y);
      const application = target?.closest('[role="application"]');
      const blocked = target?.closest('button, a, input, textarea, select, [contenteditable="true"], [role="group"], [role="heading"], .react-flow__node, .react-flow__edge');
      if (application && !blocked) {
        return { x: x - bounds.x, y: y - bounds.y };
      }
    }
    return null;
  }, box);
  if (!position) fail('Workspace canvas did not expose an empty browser point');
  return {
    position,
    absolute: { x: box.x + position.x, y: box.y + position.y },
  };
}

async function reactFlowViewport(page: Page): Promise<WorkspaceViewport> {
  const transform = await page.locator('.react-flow__viewport').getAttribute('style');
  const match = transform?.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\) scale\((-?[\d.]+)\)/);
  if (!match) fail('React Flow did not expose a numeric viewport transform');
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    zoom: Number(match[3]),
  };
}

async function settledReactFlowViewport(page: Page): Promise<WorkspaceViewport> {
  await delay(240);
  const first = await reactFlowViewport(page);
  await delay(40);
  const second = await reactFlowViewport(page);
  if (
    Math.abs(first.x - second.x) > 0.01
    || Math.abs(first.y - second.y) > 0.01
    || Math.abs(first.zoom - second.zoom) > 0.0001
  ) {
    fail('React Flow viewport was still moving after the animation boundary');
  }
  return second;
}

async function verifyFileAndSharingLifecycle(page: Page, baseUrl: string): Promise<void> {
  const note = '# Research note\n\nA durable artifact with café and 数字.\n';
  const binaryText = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
  const bomText = Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x69]);
  await page.getByLabel('Upload files to workspace').setInputFiles([{
    name: 'research.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(note),
  }, {
    name: 'encoded.txt', mimeType: 'application/octet-stream', buffer: binaryText,
  }, {
    name: 'bom.txt', mimeType: 'text/plain', buffer: bomText,
  }, {
    name: 'notes.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Name,Note\r\nAda,"first line\r\nsecond line"\r\nGrace,"comma, then ""quoted"""\r\n'),
  }]);
  await page.getByRole('button', { name: /^notes\.csv, .*File actions$/ }).click();
  await page.getByRole('menuitem', { name: 'Show on Canvas', exact: true }).click();
  await expect(page.getByRole('row', { name: 'Ada first line second line', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Grace comma, then "quoted"', exact: true })).toBeVisible();
  const fileActions = page.getByRole('button', { name: /^research\.md, .*File actions$/ });
  await fileActions.click();
  await page.getByRole('menuitem', { name: 'Show on Canvas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();

  await verifyCompactNavigation(page);

  await fileActions.click();
  const fileDownloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
  const fileDownload = await fileDownloadPromise;
  const filePath = await fileDownload.path();
  if (!filePath) fail('Workspace file download did not finish');
  expect(await readFile(filePath, 'utf8')).toBe(note);

  const exportPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace' }).click();
  const exported = await exportPromise;
  const exportPath = await exported.path();
  if (!exportPath) fail('Workspace export did not finish');
  const bundle = await readFile(exportPath);

  await page.getByRole('textbox', { name: 'Workspace description' }).fill('Private planning note: synthetic gallery boundary check');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /^Publish(?: to gallery)?$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to Gallery' });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Shared research');
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Local browser acceptance');
  const publicationPromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/publish')
  ));
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  const publication = await publicationPromise;
  if (publication.status() !== 201) fail('Workspace publication failed');
  const published = z.object({ item: z.object({ id: z.string() }) }).parse(await publication.json());
  await expect(page.getByRole('button', { name: /^Unpublish(?: from gallery)?$/ })).toBeVisible();

  const browser = page.context().browser();
  if (!browser) fail('Gallery acceptance requires a separate browser session');
  const otherContext = await browser.newContext({ acceptDownloads: true });
  const otherPage = await otherContext.newPage();
  let importedWorkspaceId: string | undefined;
  try {
    const galleryUrl = new URL(baseUrl);
    galleryUrl.searchParams.set('gallery', published.item.id);
    await otherPage.goto(galleryUrl.toString(), { waitUntil: 'networkidle' });
    await expect(otherPage.getByRole('heading', { name: 'Shared research', exact: true })).toBeVisible();
    await expect(otherPage.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();
    await apiCall(otherPage, baseUrl, `/api/gallery/${published.item.id}`, {
      label: 'read only chosen publication metadata from another session',
      schema: z.object({ item: z.object({
        title: z.literal('Shared research'),
        description: z.literal('Local browser acceptance'),
        prompt: z.never().optional(),
        state: z.object({
          sessionId: z.null(),
          workspace: z.object({
            name: z.literal('Shared research'),
            description: z.literal('Local browser acceptance'),
          }),
        }),
      }) }),
    });

    page.once('dialog', (confirmation) => void confirmation.accept());
    await page.getByRole('button', { name: /^Unpublish(?: from gallery)?$/ }).click();
    await expect(page.getByRole('button', { name: /^Publish(?: to gallery)?$/ })).toBeVisible();
    await apiCall(page, baseUrl, `/api/workspaces/${workspaceIdFromUrl(page.url())}/publish`, {
      method: 'DELETE', expectedStatus: 404, label: 'unpublish an already-unpublished workspace',
      schema: z.object({ error: z.object({ code: z.literal('not_found') }).passthrough() }).passthrough(),
    });
    await otherPage.reload({ waitUntil: 'networkidle' });
    await expect(otherPage.getByText('Gallery item not found', { exact: false })).toBeVisible();

    await otherPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await otherPage.getByLabel('Import workspace bundle').setInputFiles({
      name: exported.suggestedFilename(),
      mimeType: 'application/json',
      buffer: bundle,
    });
    await otherPage.waitForURL(/workspace=/);
    importedWorkspaceId = workspaceIdFromUrl(otherPage.url());
    if (importedWorkspaceId === workspaceIdFromUrl(page.url())) fail('Import reused the original workspace');
    await otherPage.reload({ waitUntil: 'networkidle' });
    await expect(otherPage.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();
    await expect(otherPage.getByRole('button', {
      name: associationName('Source cards', 'Related cards'),
    })).toHaveCount(1);
    for (const [name, bytes] of [['encoded.txt', binaryText], ['bom.txt', bomText]] as const) {
      await otherPage.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}, .*File actions$`) }).click();
      const downloadPromise = otherPage.waitForEvent('download');
      await otherPage.getByRole('menuitem', { name: 'Download', exact: true }).click();
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) fail('Imported file download did not finish');
      expect(await readFile(path)).toEqual(bytes);
    }
    otherPage.once('dialog', (confirmation) => void confirmation.accept());
    await otherPage.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(otherPage.getByRole('button', { name: 'Start blank' })).toBeVisible();
    importedWorkspaceId = undefined;
  } finally {
    if (importedWorkspaceId) {
      await apiCall(otherPage, baseUrl, `/api/workspaces/${importedWorkspaceId}`, {
        method: 'DELETE', label: 'cleanup imported workspace', schema: AcknowledgementPayloadSchema,
      });
    }
    await otherContext.close();
  }
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();
}

async function verifyCompactNavigation(page: Page): Promise<void> {
  const workspaceName = await page.getByRole('textbox', { name: 'Workspace name' }).inputValue();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await page.getByRole('button', { name: /^research\.md, .*File actions$/ }).click();
    await page.getByRole('menuitem', { name: 'Go to Tile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Back to home', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'What would you like to work on?' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(escapeRegExp(workspaceName)) }).click();
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveValue(workspaceName);
    await expect(page.getByRole('heading', { name: 'Research note', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function verifyFileExecutionBoundary(page: Page, baseUrl: string): Promise<void> {
  // Imported/generated file MIME is untrusted, including a file named .pdf.
  const html = '<h1>Working preview</h1><script>let access;try{parent.document.documentElement;access="parent-access"}catch{access="isolated"}document.body.dataset.boundary=access;</script>';
  const now = new Date().toISOString();
  const workspace = { id: 'fixture', name: 'File isolation', description: '', createdAt: now, updatedAt: now };
  const paths = ['preview.html', 'reported.pdf', 'unknown.bin'];
  const bundle = {
    version: 1, exportedAt: now, workspace,
    state: {
      sessionId: null, workspace,
      panels: paths.map((filePath, index) => ({
        id: `file-boundary-${index}`, type: index === 1 ? 'pdf' : 'file', filePath, title: filePath,
        layout: { x: index * 450, y: 0, width: 400, height: 300 },
      })),
      viewport: { x: 0, y: 0, zoom: 0.6 }, groups: [], connections: [],
    },
    messages: [], files: paths.map((path) => ({ path, contentType: 'text/html', encoding: 'utf8', content: html })),
  };
  const filePage = await page.context().newPage();
  let workspaceId: string | undefined;
  try {
    await filePage.goto(baseUrl, { waitUntil: 'networkidle' });
    await filePage.getByLabel('Import workspace bundle').setInputFiles({
      name: 'boundary.agent-studio.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await filePage.waitForURL(/workspace=/);
    workspaceId = workspaceIdFromUrl(filePage.url());
    const preview = filePage.frameLocator('iframe[title="preview.html"]');
    await expect(preview.getByRole('heading', { name: 'Working preview' })).toBeVisible();
    await expect(preview.locator('body')).toHaveAttribute('data-boundary', 'isolated');
    for (const filename of ['reported.pdf', 'unknown.bin']) {
      const downloadPromise = filePage.waitForEvent('download');
      await filePage.getByRole('link', { name: `Download ${filename}`, exact: true }).click();
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) fail('Unpreviewable file download did not finish');
      expect(await readFile(path, 'utf8')).toBe(html);
    }
  } finally {
    if (workspaceId) await apiCall(filePage, baseUrl, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE', label: 'cleanup file-boundary workspace', schema: AcknowledgementPayloadSchema,
    });
    await filePage.close();
  }
}

async function verifyLargeUpload(page: Page, baseUrl: string): Promise<void> {
  const uploadPage = await page.context().newPage();
  let workspaceId: string | undefined;
  try {
    await uploadPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await uploadPage.getByRole('button', { name: 'Start blank' }).click();
    await uploadPage.waitForURL(/workspace=/);
    workspaceId = workspaceIdFromUrl(uploadPage.url());
    // Both files fit the 25 MB per-file and 50 MB total product limits; the
    // combined bytes exceed the platform's 32 MiB serialized RPC limit.
    const files = [
      { name: 'large-a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(17 * 1024 * 1024, 65) },
      { name: 'large-b.txt', mimeType: 'text/plain', buffer: Buffer.alloc(17 * 1024 * 1024, 66) },
    ];
    const uploadResponse = uploadPage.waitForResponse((response) => (
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/upload')
    ));
    await uploadPage.getByLabel('Upload files to workspace').setInputFiles(files);
    if ((await uploadResponse).status() !== 201) fail('Valid large upload batch failed');
    await uploadPage.reload({ waitUntil: 'networkidle' });
    for (const file of files) {
      await uploadPage.getByRole('button', { name: new RegExp(`^${file.name.replace('.', '\\.')}.*File actions$`) }).click();
      const downloading = uploadPage.waitForEvent('download');
      await uploadPage.getByRole('menuitem', { name: 'Download', exact: true }).click();
      const downloaded = await (await downloading).path();
      if (!downloaded || !(await readFile(downloaded)).equals(file.buffer)) fail('Large upload bytes changed after reload');
    }
  } finally {
    if (workspaceId) await apiCall(uploadPage, baseUrl, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE', label: 'cleanup large-upload workspace', schema: AcknowledgementPayloadSchema,
    });
    await uploadPage.close();
  }
}

async function verifyConcurrentLayoutEdits(page: Page, baseUrl: string, workspaceId: string): Promise<void> {
  const first = await page.context().newPage();
  const second = await page.context().newPage();
  let holdNextLayout = false;
  let releaseLayout: (() => void) | undefined;
  const layoutCall = z.object({ method: z.literal('applyLayoutPatch') }).passthrough();
  // Delay one real client RPC; both clients still use the actual Worker/DO.
  await first.routeWebSocket('**/agents/**', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (holdNextLayout && layoutCall.safeParse(JSON.parse(message.toString())).success) {
        holdNextLayout = false;
        releaseLayout = () => server.send(message);
      } else {
        server.send(message);
      }
    });
  });
  try {
    await first.goto(page.url(), { waitUntil: 'networkidle' });
    await second.goto(page.url(), { waitUntil: 'networkidle' });
    const before = await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}`, {
      label: 'read layouts before concurrent edits', schema: WorkspacePayloadSchema,
    });
    const sourceBefore = before.state.panels.find((panel) => panel.id === 'browser-source-cards')?.layout;
    const targetBefore = before.state.panels.find((panel) => panel.id === 'browser-target-cards')?.layout;
    if (!sourceBefore || !targetBefore) fail('Concurrent-edit fixture has no layouts');
    holdNextLayout = true;
    await panelLocator(first, 'Source cards', 'cards').focus();
    await first.keyboard.press('ArrowLeft');
    await expect.poll(() => Boolean(releaseLayout)).toBe(true);

    await panelLocator(second, 'Related cards', 'cards').focus();
    await second.keyboard.press('ArrowRight');
    await waitForStateChange(page, baseUrl, workspaceId,
      (state) => state.panels.some((panel) => panel.id === 'browser-target-cards' && panel.layout?.x === targetBefore.x + 16),
      'the second client edit to persist');
    releaseLayout?.();
    releaseLayout = undefined;
    const after = await waitForStateChange(page, baseUrl, workspaceId,
      (state) => state.panels.some((panel) => panel.id === 'browser-source-cards' && panel.layout?.x === sourceBefore.x - 16),
      'the delayed first client edit to persist');
    expect(after.panels.find((panel) => panel.id === 'browser-target-cards')?.layout?.x).toBe(targetBefore.x + 16);
    await first.reload({ waitUntil: 'networkidle' });
    const reloaded = await apiCall(first, baseUrl, `/api/workspaces/${workspaceId}`, {
      label: 'read both edits after reload', schema: WorkspacePayloadSchema,
    });
    expect(reloaded.state.panels.find((panel) => panel.id === 'browser-source-cards')?.layout?.x).toBe(sourceBefore.x - 16);
    expect(reloaded.state.panels.find((panel) => panel.id === 'browser-target-cards')?.layout?.x).toBe(targetBefore.x + 16);
  } finally {
    releaseLayout?.();
    await first.close();
    await second.close();
  }
}

async function verifyContextualRetry(page: Page): Promise<void> {
  const chatPage = await page.context().newPage();
  await chatPage.setViewportSize({ width: 1440, height: 1000 });
  const requestSchema = z.object({
    type: z.literal('cf_agent_use_chat_request'),
    id: z.string(),
    init: z.object({ body: z.string() }),
  });
  const bodySchema = z.object({
    scopePanelIds: z.array(z.string()),
    messages: z.array(z.object({ id: z.string(), role: z.string() }).passthrough()),
  }).passthrough();
  const requests: Array<z.infer<typeof bodySchema>> = [];
  // Deliberately fail only the model boundary. App, React hooks, socket and
  // workspace state are real; no chat request reaches a paid provider.
  await chatPage.route('**/model-credential', (route) => route.fulfill({ status: 204 }));
  await chatPage.routeWebSocket('**/agents/**', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = requestSchema.safeParse(JSON.parse(message.toString()));
      if (!request.success) {
        server.send(message);
        return;
      }
      requests.push(bodySchema.parse(JSON.parse(request.data.init.body)));
      socket.send(JSON.stringify({
        type: 'cf_agent_use_chat_response', id: request.data.id,
        error: true, done: true, body: 'Deliberate browser test failure',
      }));
    });
  });
  try {
    await chatPage.goto(page.url(), { waitUntil: 'networkidle' });
    await selectPanel(chatPage, 'Source cards', 'cards');
    await chatPage.getByRole('button', { name: 'Chat about Source cards', exact: true }).click();
    const question = chatPage.getByRole('textbox', { name: 'Ask about Source cards', exact: true });
    await question.fill('Explain the source finding.');
    await question.press('Enter');
    const retry = chatPage.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeEnabled();
    expect(requests).toHaveLength(1);
    expect(requests[0].scopePanelIds).toEqual(['browser-source-cards']);

    await selectPanel(chatPage, 'Related cards', 'cards');
    await chatPage.getByRole('button', { name: 'Chat about Related cards', exact: true }).click();
    await expect(retry).toBeDisabled();
    expect(requests).toHaveLength(1);

    await selectPanel(chatPage, 'Source cards', 'cards');
    await chatPage.getByRole('button', { name: 'Chat about Source cards', exact: true }).click();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].scopePanelIds).toEqual(['browser-source-cards']);
    expect(requests[1].messages.filter((message) => message.role === 'user'))
      .toEqual(requests[0].messages.filter((message) => message.role === 'user'));
  } finally {
    await chatPage.close();
  }
}

async function verifyCompactNewResult(page: Page, baseUrl: string): Promise<void> {
  const compactPage = await page.context().newPage();
  let workspaceId: string | undefined;
  try {
    await compactPage.setViewportSize({ width: 390, height: 844 });
    await compactPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await compactPage.getByRole('button', { name: 'Start blank' }).click();
    await compactPage.waitForURL(/workspace=/);
    workspaceId = workspaceIdFromUrl(compactPage.url());
    await compactPage.getByRole('tab', { name: 'Chat', exact: true }).click();
    await apiCall(compactPage, baseUrl, `/api/workspaces/${workspaceId}/panels`, {
      method: 'POST', label: 'deliver a new result while the canvas is hidden',
      body: { panel: {
        id: 'compact-result', type: 'markdown', title: 'New research result', content: 'Ready to inspect.',
        layout: { x: 3600, y: -2400, width: 260, height: 180 },
      } },
      schema: AcknowledgementPayloadSchema,
    });
    await expect(compactPage.getByRole('heading', { name: 'New research result', includeHidden: true })).toBeAttached();
    // Let the existing 120ms autofocus debounce finish while Chat is active.
    await delay(240);
    await compactPage.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await expect(panelLocator(compactPage, 'New research result', 'markdown')).toBeInViewport({ ratio: 0.9 });
  } finally {
    if (workspaceId) await apiCall(compactPage, baseUrl, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE', label: 'cleanup compact result workspace', schema: AcknowledgementPayloadSchema,
    });
    await compactPage.close();
  }
}

async function runAcceptance(baseUrl: string, headed: boolean): Promise<void> {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  let applyLayoutPatchCalls = 0;
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      if (frame.payload.toString().includes('applyLayoutPatch')) applyLayoutPatchCalls += 1;
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  let workspaceId: string | undefined;
  let cleanupViaUi = false;
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Start blank' }).click();
    await page.waitForURL(/workspace=/);
    workspaceId = workspaceIdFromUrl(page.url());
    await expect(page.getByRole('status', { name: 'Chat status: Ready' })).toBeVisible();

    await seedCards(page, baseUrl, workspaceId);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Source finding' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Related finding' })).toBeVisible();

    const nameInput = page.getByRole('textbox', { name: 'Workspace name' });
    await nameInput.fill('Agent Studio browser acceptance');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(nameInput).toHaveValue('Agent Studio browser acceptance');

    await verifyConcurrentLayoutEdits(page, baseUrl, workspaceId);
    await verifyContextualRetry(page);
    await verifyCompactNewResult(page, baseUrl);
    await page.bringToFront();

    await selectPanel(page, 'Source cards', 'cards');
    await selectPanel(page, 'Related cards', 'cards', 'ControlOrMeta');
    const multiToolbar = page.getByRole('toolbar', { name: 'Actions for selected tiles' });
    await expect(multiToolbar).toBeVisible();

    const association = page.getByRole('button', {
      name: associationName('Source cards', 'Related cards'),
    });
    await page.getByRole('button', { name: 'Associate selected tiles' }).click();
    await expect(association).toHaveCount(1);

    await page.getByRole('button', { name: 'Disconnect selected tiles' }).click();
    await expect(association).toHaveCount(0);

    const canvas = page.getByRole('region', { name: /^Workspace canvas/ });
    const firstClearPoint = await emptyCanvasPoint(page, canvas);
    await canvas.click({ position: firstClearPoint.position });
    await expect(multiToolbar).toHaveCount(0);

    await selectPanel(page, 'Source cards', 'cards');
    await selectPanel(page, 'Related cards', 'cards', 'ControlOrMeta');
    await page.getByRole('button', { name: 'Associate selected tiles' }).click();
    await expect(association).toHaveCount(1);

    const stateBeforePan = workspaceSnapshot(
      await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}`, {
        label: 'read workspace before pan',
        schema: WorkspacePayloadSchema,
      }),
    );
    const panPoint = await emptyCanvasPoint(page, canvas);
    await canvas.focus();
    await page.keyboard.down('Space');
    try {
      await page.mouse.move(panPoint.absolute.x, panPoint.absolute.y);
      await page.mouse.down();
      await page.mouse.move(panPoint.absolute.x - 200, panPoint.absolute.y - 200, { steps: 10 });
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Space');
    }
    const stateAfterPan = await waitForStateChange(
      page,
      baseUrl,
      workspaceId,
      (snapshot) => snapshot.viewport.x !== stateBeforePan.viewport.x || snapshot.viewport.y !== stateBeforePan.viewport.y,
      'the user pan to persist',
    );
    if (
      stateAfterPan.viewport.x >= stateBeforePan.viewport.x ||
      stateAfterPan.viewport.y >= stateBeforePan.viewport.y
    ) {
      fail('Canvas pan did not move the viewport farther into negative coordinates');
    }

    const zoomLabel = page.getByLabel(/^Zoom \d+ percent$/);
    const zoomBeforeLabel = await zoomLabel.getAttribute('aria-label');
    const zoomBefore = await settledReactFlowViewport(page);
    const callsBeforeZoomOut = applyLayoutPatchCalls;
    await page.getByRole('button', { name: 'Zoom out' }).click();
    const zoomOut = await settledReactFlowViewport(page);
    if (applyLayoutPatchCalls - callsBeforeZoomOut !== 1) {
      fail('Zoom out did not coalesce its viewport write to one terminal patch');
    }
    if (zoomOut.zoom >= zoomBefore.zoom - 0.02) {
      fail('Zoom out did not complete its animation');
    }
    await expect(zoomLabel).not.toHaveAttribute('aria-label', zoomBeforeLabel ?? '');
    const callsBeforeZoomIn = applyLayoutPatchCalls;
    await page.getByRole('button', { name: 'Zoom in' }).click();
    const zoomIn = await settledReactFlowViewport(page);
    if (applyLayoutPatchCalls - callsBeforeZoomIn !== 1) {
      fail('Zoom in did not coalesce its viewport write to one terminal patch');
    }
    if (zoomIn.zoom <= zoomOut.zoom + 0.02) {
      fail('Zoom in did not complete its animation');
    }

    const callsBeforeReset = applyLayoutPatchCalls;
    await page.getByRole('button', { name: 'Reset zoom and position' }).click();
    const resetViewport = await settledReactFlowViewport(page);
    if (applyLayoutPatchCalls - callsBeforeReset !== 1) {
      fail('Reset view did not coalesce its viewport write to one terminal patch');
    }
    if (
      Math.abs(resetViewport.x - zoomIn.x) <= 0.01
      && Math.abs(resetViewport.y - zoomIn.y) <= 0.01
      && Math.abs(resetViewport.zoom - zoomIn.zoom) <= 0.0001
    ) {
      fail('Reset view did not complete its animation');
    }
    await expect(multiToolbar).toBeVisible();
    const secondClearPoint = await emptyCanvasPoint(page, canvas);
    await canvas.click({ position: secondClearPoint.position });
    await expect(multiToolbar).toHaveCount(0);

    await selectPanel(page, 'Source cards', 'cards');
    const singleToolbar = page.getByRole('toolbar', { name: 'Actions for Source cards' });
    await expect(singleToolbar).toBeVisible();
    const toolbarBeforeResize = await singleToolbar.boundingBox();
    if (!toolbarBeforeResize) fail('Selection toolbar did not expose a browser bounding box');

    const sourcePanel = panelLocator(page, 'Source cards', 'cards');
    await sourcePanel.focus();
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Alt+ArrowRight');
    }
    await waitForStateChange(
      page,
      baseUrl,
      workspaceId,
      (snapshot) => snapshot.panels.some((panel) => panel.id === 'browser-source-cards' && (panel.layout?.width ?? 0) > 360),
      'the resized card layout to persist',
    );
    const toolbarAfterResize = await singleToolbar.boundingBox();
    if (!toolbarAfterResize) fail('Selection toolbar disappeared after card resize');
    if (
      Math.abs(toolbarAfterResize.width - toolbarBeforeResize.width) > 1 ||
      Math.abs(toolbarAfterResize.height - toolbarBeforeResize.height) > 1
    ) {
      fail('Selection toolbar changed size when the card was resized');
    }

    await page.getByRole('button', { name: 'Download or export' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'JSON' }).click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== 'source-cards.json') {
      fail('Unexpected card download name');
    }
    const cardDownloadPath = await download.path();
    if (!cardDownloadPath) fail('Card download did not finish');
    expect(JSON.parse(await readFile(cardDownloadPath, 'utf8'))).toEqual([{
      id: 'source-finding', title: 'Source finding', subtitle: 'Deterministic browser fixture',
      description: 'This card is seeded through the local Worker API.', badge: 'Verified',
      metadata: { Source: 'local acceptance', Year: '2026' },
    }]);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Agent Studio browser acceptance');
    await expect(page.getByRole('heading', { name: 'Source finding' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Related finding' })).toBeVisible();
    await expect(association).toHaveCount(1);
    const persistedState = workspaceSnapshot(
      await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}`, {
        label: 'read workspace after reload',
        schema: WorkspacePayloadSchema,
      }),
    );
    const sourcePanelState = persistedState.panels.find((panel) => panel.id === 'browser-source-cards');
    if ((sourcePanelState?.layout?.width ?? 0) <= 360) fail('Card resize did not survive reload');

    // Delay the real refresh request. Back must remain usable, and its late
    // response must not pull the user back into a workspace they just left.
    const workspaceUrl = appPath(baseUrl, `api/workspaces/${workspaceId}`);
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolveRefresh) => { releaseRefresh = resolveRefresh; });
    await page.route(workspaceUrl, async (route) => {
      await refreshGate;
      await route.continue();
    });
    try {
      const refreshRequest = page.waitForRequest(workspaceUrl);
      await page.getByRole('button', { name: 'Refresh workspace' }).click();
      await refreshRequest;
      await page.getByRole('button', { name: 'Back to home' }).click();
      const lateResponse = page.waitForResponse(workspaceUrl);
      releaseRefresh();
      await lateResponse;
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('textbox', { name: 'What would you like to work on?' })).toBeVisible();
    } finally {
      releaseRefresh();
      await page.unroute(workspaceUrl);
    }
    await page.getByRole('button', { name: /^Agent Studio browser acceptance/ }).click();
    await page.waitForURL(/workspace=/);
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Agent Studio browser acceptance');

    await verifyFileAndSharingLifecycle(page, baseUrl);
    await verifyFileExecutionBoundary(page, baseUrl);
    await verifyLargeUpload(page, baseUrl);

    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(page.getByRole('button', { name: 'Start blank' })).toBeVisible();
    cleanupViaUi = true;
    console.log('[browser] canvas persistence, file bytes, export/import, gallery lifecycle, preview isolation, reload, and UI cleanup passed');
  } finally {
    if (workspaceId && !cleanupViaUi) {
      try {
        await apiCall(page, baseUrl, `/api/workspaces/${workspaceId}`, {
          method: 'DELETE',
          label: 'cleanup workspace',
          schema: AcknowledgementPayloadSchema,
        });
      } catch {
        // Preserve the original browser failure without printing an identifier.
      }
    }
    await context.close();
    await browser.close();
  }
}

function parseArgs(argv: string[]): AcceptanceOptions {
  const options: AcceptanceOptions = {
    url: process.env.AGENT_STUDIO_BROWSER_URL,
    port: Number(process.env.AGENT_STUDIO_BROWSER_PORT ?? DEFAULT_PORT),
    noBuild: false,
    headed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--url') {
      options.url = argv[++index];
    } else if (argument === '--port') {
      options.port = Number(argv[++index]);
    } else if (argument === '--no-build') {
      options.noBuild = true;
    } else if (argument === '--headed') {
      options.headed = true;
    } else {
      fail(`Unknown browser acceptance option: ${argument}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    fail('Browser acceptance port must be an integer between 1 and 65535');
  }
  return options;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  let worker: ChildProcess | undefined;
  let baseUrl = options.url;
  try {
    if (!baseUrl) {
      if (!options.noBuild) {
        const build = spawnSync('bun', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
        if (build.status !== 0) fail('Frontend build failed before browser acceptance');
      }
      worker = startWorker(options.port);
      baseUrl = `http://127.0.0.1:${options.port}/agent-studio/`;
    }
    await waitForHealth(baseUrl);
    await runAcceptance(baseUrl, options.headed);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? sanitizeFailure(error) : 'unknown browser acceptance failure';
    console.error(`[browser] acceptance failed: ${message}`);
    return 1;
  } finally {
    await stopWorker(worker);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
