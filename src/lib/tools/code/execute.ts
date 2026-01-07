import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as vm from 'vm';
import * as fs from 'fs';
import * as path from 'path';
import { lookup } from 'dns/promises';
import * as net from 'net';
import { PDFParse } from 'pdf-parse';
import { minimatch } from 'minimatch';
import { XMLParser } from 'fast-xml-parser';
import type { ToolContext } from '../types';
import type { UIPanel, Table, ChartData, CardsData } from '../../storage';

// Panel update type for streaming to client
export interface PanelUpdate {
  action: 'add' | 'update' | 'remove';
  panel: UIPanel;
  data?: {
    table?: Table;
    chart?: ChartData;
    cards?: CardsData;
    content?: string;
  };
}

// Skills directory location
const SKILLS_DIR = path.join(process.cwd(), 'src/lib/skills');
const FETCH_TIMEOUT_MS = 30000;
const VM_TIMEOUT_MS = 30000;
const ASYNC_TIMEOUT_MS = 120000;
const SANDBOX_TIMER_LIMIT_MS = 120000;

// Python venv path - computed lazily to avoid Turbopack static analysis
function getPythonBin(): string {
  const venv = process.env.PYTHON_VENV_PATH || `${process.cwd()}/.venv`;
  return `${venv}/bin/python3`;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function normalizeHostForIp(host: string): string {
  const normalized = host.toLowerCase();
  const debracketed = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
  const zoneIndex = debracketed.indexOf('%');
  return zoneIndex >= 0 ? debracketed.slice(0, zoneIndex) : debracketed;
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost') return true;

  const hostForIp = normalizeHostForIp(normalized);

  const ipVersion = net.isIP(hostForIp);
  if (ipVersion === 4) {
    return isPrivateIpv4(hostForIp);
  }
  if (ipVersion === 6) {
    if (hostForIp === '::' || hostForIp === '::1') return true;
    if (hostForIp.startsWith('fe80:')) return true; // Link-local
    if (hostForIp.startsWith('fc') || hostForIp.startsWith('fd')) return true; // ULA
    if (hostForIp.startsWith('::ffff:')) {
      const v4 = hostForIp.slice('::ffff:'.length);
      if (net.isIP(v4) === 4) return isPrivateIpv4(v4);
    }
  }

  return false;
}

/**
 * Execute tool - runs agent-generated JavaScript with Unix-style tools available.
 *
 * Instead of reimplementing tools, this sandbox exposes the actual tools
 * as callable functions. The agent writes code that composes these primitives.
 */
export const createExecuteTool = (ctx: ToolContext) => {
  const { storage, workspaceId } = ctx;

  // Track panel updates during execution for streaming to client
  const panelUpdates: PanelUpdate[] = [];
  const shouldEmbedPanelUpdates = !ctx.emitPanelUpdates;
  const emitPanelUpdate = (update: PanelUpdate) => {
    if (ctx.emitPanelUpdates) {
      try {
        ctx.emitPanelUpdates([update]);
      } catch (error) {
        console.error('Failed to emit panel update:', error);
      }
    }
    if (shouldEmbedPanelUpdates) {
      panelUpdates.push(update);
    }
  };

  // Create wrapper functions that call the actual storage/tool operations
  // These are the Unix-style primitives exposed to agent code
  const toolFunctions = {
    // Panel updates getter (for extracting after execution)
    __panelUpdates: panelUpdates,

    // === I/O ===
    async read(from: string): Promise<unknown> {
      if (from.startsWith('table:')) {
        const tableId = from.slice(6);
        const table = await storage.getTable(workspaceId, tableId);
        return table?.data ?? [];
      }
      if (from.startsWith('file:')) {
        const filePath = from.slice(5);
        const ext = filePath.toLowerCase().split('.').pop();

        // Parse PDFs using pdf-parse v2
        if (ext === 'pdf') {
          const buffer = await storage.readFileBuffer(workspaceId, filePath);
          if (!buffer) {
            return `PDF file not found: ${filePath}`;
          }
          try {
            const parser = new PDFParse({ data: buffer });
            const result = await parser.getText();
            return result.text;
          } catch (err) {
            return `Error parsing PDF: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Excel files need Python via Bash
        if (['xlsx', 'xls'].includes(ext || '')) {
          return `[Excel file: ${filePath}]\nExcel files cannot be read as text. Use the Bash tool to run Python:\n\n${getPythonBin()} -c "\nimport pandas as pd\ndf = pd.read_excel('data/users/.../files/${filePath}')\nprint(df.to_string())\n"`;
        }

        const content = await storage.readFile(workspaceId, filePath);
        return content;
      }
      if (from.startsWith('chart:')) {
        const chartId = from.slice(6);
        const chart = await storage.getChart(workspaceId, chartId);
        return chart; // Returns full chart object {id, title, type, data, config}
      }
      if (from.startsWith('cards:')) {
        const cardsId = from.slice(6);
        const cards = await storage.getCards(workspaceId, cardsId);
        return cards; // Returns full cards object {id, title, items}
      }
      if (from.startsWith('markdown:')) {
        const panelId = from.slice(9);
        const uiState = await storage.getUIState(workspaceId);
        const panel = uiState.panels.find(p => p.id === panelId && p.type === 'markdown');
        return panel?.content ?? null;
      }
      throw new Error(`Unknown source: ${from}. Use "table:name", "file:path", "chart:id", "cards:id", or "markdown:id"`);
    },

    async write(data: unknown, to: string): Promise<void> {
      if (to.startsWith('table:')) {
        const tableId = to.slice(6);
        const existing = await storage.getTable(workspaceId, tableId);
        if (existing) {
          existing.data = data as Record<string, unknown>[];
          await storage.setTable(workspaceId, tableId, existing);
        } else {
          const rows = data as Record<string, unknown>[];
          const columns = rows.length > 0
            ? Object.keys(rows[0]).map(key => ({ key, label: key, type: 'text' as const }))
            : [];
          await storage.setTable(workspaceId, tableId, { id: tableId, title: tableId, columns, data: rows });
        }
        return;
      }
      if (to.startsWith('file:')) {
        const path = to.slice(5);
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        await storage.writeFile(workspaceId, path, content);
        return;
      }
      throw new Error(`Unknown destination: ${to}. Use "table:name" or "file:path"`);
    },

    // === Transform (pure functions, same as our Unix tools) ===
    filter(data: unknown[], where: string): unknown[] {
      const match = where.match(/^(\w+)\s*(==|!=|>|<|>=|<=|contains)\s*(.+)$/);
      if (!match) return data;

      const [, field, op, valueStr] = match;
      const value = valueStr.startsWith('"') || valueStr.startsWith("'")
        ? valueStr.slice(1, -1)
        : isNaN(Number(valueStr)) ? valueStr : Number(valueStr);

      return data.filter((item) => {
        const rec = item as Record<string, unknown>;
        const itemValue = rec[field];
        switch (op) {
          case '==': return itemValue == value;
          case '!=': return itemValue != value;
          case '>': return Number(itemValue) > Number(value);
          case '<': return Number(itemValue) < Number(value);
          case '>=': return Number(itemValue) >= Number(value);
          case '<=': return Number(itemValue) <= Number(value);
          case 'contains': return String(itemValue).toLowerCase().includes(String(value).toLowerCase());
          default: return true;
        }
      });
    },

    pick(data: unknown[], fields: string[]): unknown[] {
      return data.map((item) => {
        const rec = item as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in rec) result[field] = rec[field];
        }
        return result;
      });
    },

    sort(data: unknown[], field: string, order: 'asc' | 'desc' = 'asc'): unknown[] {
      return [...data].sort((a, b) => {
        const recA = a as Record<string, unknown>;
        const recB = b as Record<string, unknown>;
        const aVal = recA[field] as string | number;
        const bVal = recB[field] as string | number;
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return order === 'desc' ? -cmp : cmp;
      });
    },

    map(data: unknown[], fn: (item: unknown) => unknown): unknown[] {
      return data.map(fn);
    },

    unique(data: unknown[], field?: string): unknown[] {
      if (field) {
        const seen = new Set();
        return data.filter((item) => {
          const rec = item as Record<string, unknown>;
          const val = rec[field];
          if (seen.has(val)) return false;
          seen.add(val);
          return true;
        });
      }
      return [...new Set(data)];
    },

    group(data: unknown[], field: string): Record<string, unknown[]> {
      const groups: Record<string, unknown[]> = {};
      for (const item of data) {
        const rec = item as Record<string, unknown>;
        const key = String(rec[field] ?? 'undefined');
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      }
      return groups;
    },

    // === UI ===
    async setTable(id: string, config: {
      title?: string;
      columns?: { key: string; label: string; type?: string }[];
      data: unknown[];
      layout?: { x?: number; y?: number; width?: number; height?: number };
    }): Promise<void> {
      const existing = await storage.getTable(workspaceId, id);
      const rows = config.data as Record<string, unknown>[];

      // Infer columns if not provided
      const columns = config.columns?.map(c => ({ ...c, type: c.type || 'text' })) as { key: string; label: string; type: 'text' | 'number' | 'date' | 'url' | 'status' }[]
        ?? existing?.columns
        ?? (rows.length > 0 ? Object.keys(rows[0]).map(k => ({ key: k, label: k, type: 'text' as const })) : []);

      const tableData: Table = {
        id,
        title: config.title ?? existing?.title ?? id,
        columns,
        data: rows,
      };
      await storage.setTable(workspaceId, id, tableData);

      // Auto-add table panel if not exists
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.type === 'table' && p.tableId === id);

      // Default size for tables - x/y left undefined so frontend positions in viewport
      const defaultSize = { width: 600, height: 400 };

      if (!existingPanel) {
        // New panel: only set size, let frontend position it in the viewport
        const panel: UIPanel = {
          id: `table-${id}`,
          type: 'table',
          tableId: id,
          title: config.title ?? id,
          layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
        };
        await storage.addPanel(workspaceId, panel);
        // Track for streaming
        emitPanelUpdate({ action: 'add', panel, data: { table: tableData } });
      } else {
        // Existing panel: preserve position if it has one, otherwise let frontend position
        const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
        const updatedLayout = hasExistingPosition ? {
          x: config.layout?.x ?? existingPanel.layout!.x,
          y: config.layout?.y ?? existingPanel.layout!.y,
          width: config.layout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
          height: config.layout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
        } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;

        if (config.layout && updatedLayout) {
          await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
        }
        emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { table: tableData } });
      }
    },

    async addPanel(panel: Omit<UIPanel, 'type'> & { type: string }): Promise<void> {
      const typedPanel = panel as UIPanel;
      await storage.addPanel(workspaceId, typedPanel);
      emitPanelUpdate({ action: 'add', panel: typedPanel });
    },

    async removePanel(id: string): Promise<void> {
      const ui = await storage.getUIState(workspaceId);
      const panel = ui.panels.find(p => p.id === id);
      await storage.removePanel(workspaceId, id);
      if (panel) {
        emitPanelUpdate({ action: 'remove', panel });
      }
    },

    async updatePanel(id: string, updates: Partial<UIPanel>): Promise<void> {
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.id === id);
      if (!existingPanel) {
        return;
      }
      const updatedPanel: UIPanel = { ...existingPanel, ...updates };
      await storage.updatePanel(workspaceId, id, updates);
      emitPanelUpdate({ action: 'update', panel: updatedPanel });
    },

    // === Charts ===
    async setChart(id: string, config: {
      title?: string;
      type: 'bar' | 'line' | 'pie' | 'area';
      data: unknown[];
      xKey?: string;
      yKey?: string;
      labelKey?: string;
      valueKey?: string;
      layout?: { x?: number; y?: number; width?: number; height?: number };
    }): Promise<void> {
      const chartData: ChartData = {
        id,
        title: config.title ?? id,
        type: config.type,
        data: config.data as Record<string, unknown>[],
        config: {
          xKey: config.xKey,
          yKey: config.yKey,
          labelKey: config.labelKey,
          valueKey: config.valueKey,
        },
      };
      await storage.setChart(workspaceId, id, chartData);

      // Auto-add chart panel if not exists
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.type === 'chart' && p.chartId === id);

      // Default size for charts - x/y left undefined so frontend positions in viewport
      const defaultSize = { width: 500, height: 350 };

      if (!existingPanel) {
        // New panel: only set size, let frontend position it in the viewport
        const panel: UIPanel = {
          id: `chart-${id}`,
          type: 'chart',
          chartId: id,
          title: config.title ?? id,
          layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
        };
        await storage.addPanel(workspaceId, panel);
        emitPanelUpdate({ action: 'add', panel, data: { chart: chartData } });
      } else {
        // Existing panel: preserve position if it has one, otherwise let frontend position
        const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
        const updatedLayout = hasExistingPosition ? {
          x: config.layout?.x ?? existingPanel.layout!.x,
          y: config.layout?.y ?? existingPanel.layout!.y,
          width: config.layout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
          height: config.layout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
        } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;

        if (config.layout && updatedLayout) {
          await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
        }
        emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { chart: chartData } });
      }
    },

    // === Cards ===
    async setCards(id: string, config: {
      title?: string;
      items: { title: string; subtitle?: string; description?: string; image?: string; badge?: string; metadata?: Record<string, string> }[];
      layout?: { x?: number; y?: number; width?: number; height?: number };
    }): Promise<void> {
      const cardsData: CardsData = {
        id,
        title: config.title ?? id,
        items: config.items.map((item, i) => ({ id: String(i), ...item })),
      };
      await storage.setCards(workspaceId, id, cardsData);

      // Auto-add cards panel if not exists
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.type === 'cards' && p.cardsId === id);

      // Default size for cards - x/y left undefined so frontend positions in viewport
      const defaultSize = { width: 500, height: 400 };

      if (!existingPanel) {
        // New panel: only set size, let frontend position it in the viewport
        const panel: UIPanel = {
          id: `cards-${id}`,
          type: 'cards',
          cardsId: id,
          title: config.title ?? id,
          layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
        };
        await storage.addPanel(workspaceId, panel);
        emitPanelUpdate({ action: 'add', panel, data: { cards: cardsData } });
      } else {
        // Existing panel: preserve position if it has one, otherwise let frontend position
        const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
        const updatedLayout = hasExistingPosition ? {
          x: config.layout?.x ?? existingPanel.layout!.x,
          y: config.layout?.y ?? existingPanel.layout!.y,
          width: config.layout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
          height: config.layout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
        } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;

        if (config.layout && updatedLayout) {
          await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
        }
        emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { cards: cardsData } });
      }
    },

    // === Markdown ===
    async setMarkdown(id: string, config: {
      title?: string;
      content: string;
      layout?: { x?: number; y?: number; width?: number; height?: number };
    }): Promise<void> {
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.id === id);

      // Default size for markdown - x/y left undefined so frontend positions in viewport
      const defaultSize = { width: 400, height: 300 };

      if (existingPanel) {
        // Existing panel: preserve position if it has one, otherwise let frontend position
        const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
        const updatedLayout = hasExistingPosition ? {
          x: config.layout?.x ?? existingPanel.layout!.x,
          y: config.layout?.y ?? existingPanel.layout!.y,
          width: config.layout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
          height: config.layout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
        } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;

        const updatedPanel: UIPanel = {
          ...existingPanel,
          type: 'markdown',
          title: config.title ?? existingPanel.title,
          content: config.content,
          layout: updatedLayout,
        };
        await storage.updatePanel(workspaceId, id, updatedPanel);
        emitPanelUpdate({ action: 'update', panel: updatedPanel, data: { content: config.content } });
      } else {
        // New panel: only set size, let frontend position it in the viewport
        const panel: UIPanel = {
          id,
          type: 'markdown',
          title: config.title ?? id,
          content: config.content,
          layout: config.layout ? { ...defaultSize, ...config.layout } : undefined,
        };
        await storage.addPanel(workspaceId, panel);
        emitPanelUpdate({ action: 'add', panel, data: { content: config.content } });
      }
    },

    // === PDF ===
    async setPdf(id: string, config: {
      title?: string;
      filePath: string;
      layout?: { x?: number; y?: number; width?: number; height?: number };
    }): Promise<void> {
      // Validate file exists before creating panel
      const fileBuffer = await storage.readFileBuffer(workspaceId, config.filePath);
      if (!fileBuffer) {
        throw new Error(`File not found: ${config.filePath}`);
      }

      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.id === id);

      // Default size for PDF viewer - x/y left undefined so frontend positions in viewport
      const defaultSize = { width: 600, height: 800 };

      if (existingPanel) {
        // Existing panel: preserve position if it has one, otherwise let frontend position
        const hasExistingPosition = existingPanel.layout?.x !== undefined && existingPanel.layout?.y !== undefined;
        const updatedLayout = hasExistingPosition ? {
          x: config.layout?.x ?? existingPanel.layout!.x,
          y: config.layout?.y ?? existingPanel.layout!.y,
          width: config.layout?.width ?? existingPanel.layout?.width ?? defaultSize.width,
          height: config.layout?.height ?? existingPanel.layout?.height ?? defaultSize.height,
        } : config.layout ? { ...defaultSize, ...config.layout } : undefined;

        const updatedPanel: UIPanel = {
          ...existingPanel,
          type: 'pdf',
          title: config.title ?? existingPanel.title,
          filePath: config.filePath,
          layout: updatedLayout,
        };
        await storage.updatePanel(workspaceId, id, updatedPanel);
        emitPanelUpdate({ action: 'update', panel: updatedPanel });
      } else {
        // New panel: only set size, let frontend position it in the viewport
        const panel: UIPanel = {
          id,
          type: 'pdf',
          title: config.title ?? config.filePath,
          filePath: config.filePath,
          layout: config.layout ? { ...defaultSize, ...config.layout } : undefined,
        };
        await storage.addPanel(workspaceId, panel);
        emitPanelUpdate({ action: 'add', panel });
      }
    },

    // === Layout ===
    async movePanel(id: string, layout: { x?: number; y?: number; width?: number; height?: number }): Promise<void> {
      // Get current panel to merge with existing layout
      const ui = await storage.getUIState(workspaceId);
      const existingPanel = ui.panels.find(p => p.id === id);
      if (!existingPanel) {
        throw new Error(`Panel not found: ${id}`);
      }
      // Only update fields that are explicitly provided or already exist
      const fullLayout = {
        x: layout.x ?? existingPanel.layout?.x ?? 0,
        y: layout.y ?? existingPanel.layout?.y ?? 0,
        width: layout.width ?? existingPanel.layout?.width ?? 400,
        height: layout.height ?? existingPanel.layout?.height ?? 300,
      };
      await storage.updatePanel(workspaceId, id, { layout: fullLayout });
      emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: fullLayout } });
    },

    // === Downloads ===
    async download(filename: string, data: unknown, format: 'csv' | 'json' | 'txt' = 'json'): Promise<void> {
      await storage.addDownload(workspaceId, { filename, data, format });
    },

    // === Utilities ===
    // logs array will be populated later in the sandbox
    __logs: [] as string[],
    log(...args: unknown[]): void {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      toolFunctions.__logs.push(msg);
      console.log('[agent]', ...args);
    },

    // === Workspace Info ===
    async setWorkspaceInfo(info: { title?: string; description?: string }): Promise<void> {
      const workspace = await storage.getWorkspace(workspaceId);
      if (workspace) {
        if (info.title) workspace.name = info.title;
        if (info.description) workspace.description = info.description;
        workspace.updatedAt = new Date().toISOString();
        await storage.setWorkspace(workspaceId, workspace);
      }
    },

    // JSON helpers
    JSON: {
      parse: JSON.parse,
      stringify: JSON.stringify,
    },

    // XML parsing (for APIs like arXiv that return XML)
    parseXML(xml: string, options?: { ignoreAttributes?: boolean; attributeNamePrefix?: string }): unknown {
      const parser = new XMLParser({
        ignoreAttributes: options?.ignoreAttributes ?? false,
        attributeNamePrefix: options?.attributeNamePrefix ?? '@_',
        textNodeName: '#text',
        removeNSPrefix: true, // Remove namespace prefixes for easier access
      });
      return parser.parse(xml);
    },

    // === HTTP ===
    async fetch(url: string, options?: RequestInit): Promise<Response> {
      // SSRF protection: block internal networks and localhost
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP(S) requests are allowed');
      }
      const host = parsed.hostname.toLowerCase();

      if (isPrivateHost(host)) {
        throw new Error('Access to internal networks is not allowed');
      }

      const hostForIp = normalizeHostForIp(host);
      if (net.isIP(hostForIp) === 0) {
        let addresses: { address: string }[] = [];
        try {
          addresses = await lookup(hostForIp, { all: true, verbatim: true });
        } catch {
          throw new Error('Failed to resolve host');
        }
        if (addresses.length === 0) {
          throw new Error('Failed to resolve host');
        }
        for (const addr of addresses) {
          if (isPrivateHost(addr.address)) {
            throw new Error('Access to internal networks is not allowed');
          }
        }
      }

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
      let abortListener: (() => void) | undefined;

      if (options?.signal) {
        if (options.signal.aborted) {
          timeoutController.abort();
        } else {
          abortListener = () => timeoutController.abort();
          options.signal.addEventListener('abort', abortListener, { once: true });
        }
      }

      try {
        return await globalThis.fetch(url, {
          ...options,
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        if (abortListener) {
          options?.signal?.removeEventListener('abort', abortListener);
        }
      }
    },

    // === Skills Discovery ===
    async listSkills(): Promise<{ name: string; description: string }[]> {
      try {
        const indexPath = path.join(SKILLS_DIR, 'index.json');
        const content = await fs.promises.readFile(indexPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return [];
      }
    },

    async readSkill(name: string): Promise<string> {
      // Validate skill name to prevent path traversal
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return `Invalid skill name: "${name}"`;
      }
      try {
        const skillPath = path.join(SKILLS_DIR, `${name}.md`);
        return await fs.promises.readFile(skillPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return `Skill "${name}" not found`;
        }
        return `Error reading skill: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    // === Environment ===
    env(key: string): string | undefined {
      // Whitelist of allowed environment variables for agent access
      const ALLOWED_ENV_VARS = [
        'PRIMO_API_KEY',
        'PRIMO_VID',
        'PRIMO_SCOPE',
        'PRIMO_BASE_URL',
        'PRIMO_DISCOVERY_URL',
        'OPENALEX_EMAIL',
        'OCLC_CLIENT_ID',
        'OCLC_CLIENT_SECRET',
        'OCLC_INSTITUTION_ID',
        'LIBGUIDES_SITE_ID',
        'LIBGUIDES_CLIENT_ID',
        'LIBGUIDES_CLIENT_SECRET',
        'LIBGUIDES_BASE_URL',
      ];
      if (!ALLOWED_ENV_VARS.includes(key)) {
        throw new Error(`Access to environment variable '${key}' is not allowed`);
      }
      return process.env[key];
    },

    // === File Discovery (Glob) ===
    async glob(pattern: string): Promise<string[]> {
      // Recursively get all files in workspace
      const getAllFiles = async (dir: string): Promise<string[]> => {
        const files = await storage.listFiles(workspaceId, dir);
        const results: string[] = [];
        for (const file of files) {
          if (file.isDirectory) {
            const subFiles = await getAllFiles(file.path);
            results.push(...subFiles);
          } else {
            results.push(file.path);
          }
        }
        return results;
      };

      const allFiles = await getAllFiles('');
      // Filter by glob pattern
      return allFiles.filter(f => minimatch(f, pattern, { matchBase: true }));
    },

    // === Content Search (Grep) ===
    async search(pattern: string, filePath?: string): Promise<{ file: string; line: number; text: string }[]> {
      const results: { file: string; line: number; text: string }[] = [];
      const regex = new RegExp(pattern, 'gi');

      const searchFile = async (file: string) => {
        const content = await storage.readFile(workspaceId, file);
        if (!content) return;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({ file, line: i + 1, text: lines[i].trim() });
            regex.lastIndex = 0; // Reset regex state
          }
        }
      };

      if (filePath) {
        // Search single file
        await searchFile(filePath);
      } else {
        // Search all text files
        const allFiles = await toolFunctions.glob('*');
        const textExtensions = ['.txt', '.md', '.json', '.csv', '.js', '.ts', '.html', '.css', '.xml', '.yaml', '.yml'];
        for (const file of allFiles) {
          const ext = path.extname(file).toLowerCase();
          if (textExtensions.includes(ext) || !ext) {
            await searchFile(file);
          }
        }
      }

      return results.slice(0, 100); // Limit results
    },

    // === Surgical Edit ===
    async edit(filePath: string, oldText: string, newText: string): Promise<boolean> {
      const content = await storage.readFile(workspaceId, filePath);
      if (content === null) {
        throw new Error(`File not found: ${filePath}`);
      }

      if (!content.includes(oldText)) {
        throw new Error(`Text not found in file: "${oldText.slice(0, 50)}${oldText.length > 50 ? '...' : ''}"`);
      }

      const occurrences = content.split(oldText).length - 1;
      if (occurrences > 1) {
        throw new Error(`Text appears ${occurrences} times. Provide more context for unique match.`);
      }

      const newContent = content.replace(oldText, newText);
      await storage.writeFile(workspaceId, filePath, newContent);
      return true;
    },

    // === List Files ===
    async listFiles(dir?: string): Promise<{ name: string; path: string; isDirectory: boolean; size?: number }[]> {
      return storage.listFiles(workspaceId, dir || '');
    },

    // === Delete File ===
    async deleteFile(filePath: string): Promise<void> {
      await storage.deleteFile(workspaceId, filePath);
    },

    // === Get Absolute Path (for Bash/Python) ===
    getFilePath(filename: string): string {
      // Returns the absolute filesystem path for use with Bash/Python
      // Validates the filename to prevent path traversal
      if (filename.includes('..') || filename.startsWith('/')) {
        throw new Error('Invalid filename');
      }
      return path.join(storage.basePath, 'workspaces', workspaceId, 'files', filename);
    },

    // === Get Workspace Directory (for Bash/Python) ===
    getWorkspaceDir(): string {
      return path.join(storage.basePath, 'workspaces', workspaceId, 'files');
    },
  };

  return tool(
    'execute',
    `Execute JavaScript code to compose data operations, call APIs, and build UI.

Available functions:

FILES:
- read(from) - Read data: "table:id", "chart:id", "cards:id", "markdown:id", "file:path" (supports PDF)
- write(data, to) - Write to "table:name" or "file:path"
- glob(pattern) - Find files: glob("*.pdf"), glob("data/*.csv")
- search(pattern, file?) - Search file contents with regex
- edit(file, old, new) - Surgical text replacement (must be unique match)
- listFiles(dir?) - List files in directory
- deleteFile(path) - Delete a file

DATA TRANSFORMS:
- filter(data, where) - Filter: filter(data, "status == 'active'")
- pick(data, fields) - Select fields: pick(data, ["title", "author"])
- sort(data, field, order) - Sort: sort(data, "date", "desc")
- map(data, fn) - Transform each item
- unique(data, field?) - Deduplicate
- group(data, field) - Group by field

UI:
- setTable(id, {title?, columns?, data, layout?}) - Create/update table
- setChart(id, {type, data, xKey?, yKey?, layout?}) - Create chart (bar/line/pie/area)
- setCards(id, {title?, items, layout?}) - Create card grid
- setMarkdown(id, {title?, content, layout?}) - Show markdown text
- addPanel({id, type, layout?, ...}) - Add custom panel
- removePanel(id) - Remove panel
- movePanel(id, {x?, y?, width?, height?}) - Move/resize panel

Layout: {x, y, width, height} - Pixel-based canvas positioning

OUTPUT:
- download(filename, data, format) - Trigger download (csv/json/txt)

WORKSPACE:
- setWorkspaceInfo({title?, description?}) - Set workspace title/description

HTTP & APIs:
- fetch(url, options) - Make HTTP requests
- parseXML(xml, options?) - Parse XML string to JSON (for APIs like arXiv)
- listSkills() - List available API skills
- readSkill(name) - Read API documentation
- env(key) - Get environment variable (API keys)

Use async/await for I/O. Return a value to see results.`,
    z.object({
      code: z.string().describe('JavaScript code to execute'),
    }).shape,
    async ({ code }) => {
      // Clear logs from previous execution
      toolFunctions.__logs = [];
      panelUpdates.length = 0;

      const sandbox = {
        ...toolFunctions,
        console: { log: toolFunctions.log, error: toolFunctions.log },
        // Standard globals needed for common operations
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        Promise,
        Map,
        Set,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        // Base64 encoding (needed for OAuth)
        btoa: (str: string) => Buffer.from(str, 'utf-8').toString('base64'),
        atob: (str: string) => Buffer.from(str, 'base64').toString('utf-8'),
        // Safe timer wrappers with limits
        setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          return setTimeout(fn, Math.min(ms ?? 0, SANDBOX_TIMER_LIMIT_MS), ...args);
        },
        clearTimeout,
        // setInterval is not allowed - too dangerous for DoS
        setInterval: () => { throw new Error('setInterval is not available in sandbox'); },
        clearInterval,
        // URL utilities
        URL,
        URLSearchParams,
        // Text encoding/decoding
        TextEncoder,
        TextDecoder,
        // Abort controller for fetch timeouts
        AbortController,
        __result: undefined as unknown,
        __error: undefined as string | undefined,
        __done: false as boolean,
      };

      // Wrap in async IIFE
      const wrappedCode = `
        (async () => {
          try {
            const __ret = await (async () => {
              ${code}
            })();
            if (__ret !== undefined) {
              __result = __ret;
            }
          } catch (e) {
            __error = e.message || String(e);
          } finally {
            __done = true;
          }
        })();
      `;

      try {
        const context = vm.createContext(sandbox);
        const script = new vm.Script(wrappedCode);
        script.runInContext(context, { timeout: VM_TIMEOUT_MS });

        // Wait for async completion with proper timeout
        let asyncTimeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          asyncTimeoutId = setTimeout(() => resolve('timeout'), ASYNC_TIMEOUT_MS);
        });
        const completionPromise = new Promise<'done'>((resolve) => {
          const check = () => {
            if (sandbox.__done || sandbox.__error !== undefined) {
              resolve('done');
            } else {
              setTimeout(check, 100);
            }
          };
          check();
        });

        const raceResult = await Promise.race([completionPromise, timeoutPromise]);
        if (asyncTimeoutId) {
          clearTimeout(asyncTimeoutId);
        }
        if (raceResult === 'timeout') {
          sandbox.__error = `Execution timed out after ${Math.round(ASYNC_TIMEOUT_MS / 1000)} seconds`;
        }

        // Build output with logs
        const logs = toolFunctions.__logs;
        const logOutput = logs.length > 0 ? `Logs:\n${logs.join('\n')}\n\n` : '';

        // Include panel updates in output for runtime to extract
        const panelUpdateOutput = shouldEmbedPanelUpdates && panelUpdates.length > 0
          ? `\n__PANEL_UPDATES_START__${JSON.stringify(panelUpdates)}__PANEL_UPDATES_END__`
          : '';

        if (sandbox.__error) {
          return {
            content: [{ type: 'text' as const, text: `${logOutput}Error: ${sandbox.__error}${panelUpdateOutput}` }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: (sandbox.__result !== undefined
              ? `${logOutput}Done. Result: ${JSON.stringify(sandbox.__result, null, 2)}`
              : `${logOutput}Done (no return value)`) + panelUpdateOutput,
          }],
        };
      } catch (error) {
        const logs = toolFunctions.__logs;
        const logOutput = logs.length > 0 ? `Logs:\n${logs.join('\n')}\n\n` : '';
        const panelUpdateOutput = shouldEmbedPanelUpdates && panelUpdates.length > 0
          ? `\n__PANEL_UPDATES_START__${JSON.stringify(panelUpdates)}__PANEL_UPDATES_END__`
          : '';
        return {
          content: [{
            type: 'text' as const,
            text: `${logOutput}Execution error: ${error instanceof Error ? error.message : String(error)}${panelUpdateOutput}`,
          }],
        };
      }
    }
  );
};
