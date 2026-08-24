#!/usr/bin/env bun
/**
 * Real browser acceptance for the deterministic Agent Studio canvas path.
 *
 * The script builds the checked-out frontend, starts a local Wrangler Worker,
 * and uses Playwright against that Worker. It creates a workspace through the
 * home page, seeds deterministic card panels through the local API (there is
 * no model call in this path), and then performs the user-visible canvas
 * actions: select, associate, disconnect, clear selection, pan, zoom, resize,
 * download, reload, and delete.
 *
 * This is a browser/process integration test. It does not prove model
 * streaming, provider routing, or model-generated artifact quality; those
 * belong to the deterministic Worker/provider seams and their focused tests.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
      layout: z.object({ width: z.number(), height: z.number() }).passthrough().optional(),
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
  { method = 'GET', body, label, schema }: ApiCallOptions<T>,
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
  if (result.status < 200 || result.status >= 300) {
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
  modifier?: 'Meta',
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
      const blocked = target?.closest('button, a, input, textarea, select, [contenteditable="true"], [role="group"], [role="heading"]');
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

async function runAcceptance(baseUrl: string, headed: boolean): Promise<void> {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  let workspaceId: string | undefined;
  let cleanupViaUi = false;
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Start blank' }).click();
    await page.waitForURL(/workspace=/);
    workspaceId = workspaceIdFromUrl(page.url());

    await seedCards(page, baseUrl, workspaceId);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Source finding' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Related finding' })).toBeVisible();

    const nameInput = page.getByRole('textbox', { name: 'Workspace name' });
    await nameInput.fill('Agent Studio browser acceptance');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(nameInput).toHaveValue('Agent Studio browser acceptance');

    await selectPanel(page, 'Source cards', 'cards');
    await selectPanel(page, 'Related cards', 'cards', 'Meta');
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
    await selectPanel(page, 'Related cards', 'cards', 'Meta');
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
      stateAfterPan.viewport.x >= stateBeforePan.viewport.x &&
      stateAfterPan.viewport.y >= stateBeforePan.viewport.y
    ) {
      fail('Canvas pan did not move the viewport farther into negative coordinates');
    }

    const zoomLabel = page.getByLabel(/^Zoom \d+ percent$/);
    const zoomBefore = await zoomLabel.getAttribute('aria-label');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoomLabel).not.toHaveAttribute('aria-label', zoomBefore ?? '');
    await page.getByRole('button', { name: 'Zoom in' }).click();

    await page.getByRole('button', { name: 'Reset zoom and position' }).click();
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

    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(page.getByRole('button', { name: 'Start blank' })).toBeVisible();
    cleanupViaUi = true;
    console.log('[browser] visible workspace creation, cards, title save, association, disconnect, clear selection, pan, zoom, keyboard resize, download, reload, and UI cleanup passed');
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
