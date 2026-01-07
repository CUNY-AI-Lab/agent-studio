import { readFile, writeFile, mkdir, readdir, stat, unlink, rename } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { getUserDataPath } from '../session';

// Simple per-workspace mutex to prevent race conditions in read-modify-write operations
const workspaceLocks = new Map<string, Promise<void>>();

async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = workspaceId;

  // Wait for any existing lock to release
  while (workspaceLocks.has(lockKey)) {
    await workspaceLocks.get(lockKey);
  }

  // Create new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>(resolve => {
    releaseLock = resolve;
  });
  workspaceLocks.set(lockKey, lockPromise);

  try {
    return await fn();
  } finally {
    workspaceLocks.delete(lockKey);
    releaseLock!();
  }
}

export interface TableColumn {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'url' | 'status';
  linkText?: string; // For url type: display this text instead of the URL
}

export interface Table {
  id: string;
  title: string;
  columns: TableColumn[];
  data: Record<string, unknown>[];
}

// Chart data structure
export interface ChartData {
  id: string;
  title: string;
  type: 'bar' | 'line' | 'pie' | 'area';
  data: Record<string, unknown>[];
  config: {
    xKey?: string;
    yKey?: string;
    labelKey?: string;
    valueKey?: string;
    colors?: string[];
  };
}

// Cards data structure
export interface CardsData {
  id: string;
  title: string;
  items: {
    id?: string;
    title: string;
    subtitle?: string;
    description?: string;
    image?: string;
    badge?: string;
    metadata?: Record<string, string>;
  }[];
}

// Tool execution tracking for message display
export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'success' | 'error';
  output?: string;
  startTime?: number;
  elapsedTime?: number;
}

export interface ContentBlock {
  type: 'text' | 'tools';
  text?: string;
  tools?: ToolExecution[];
}

// Message type
export interface Message {
  role: 'user' | 'assistant';
  content: string;
  blocks?: ContentBlock[];
}

// Download request
export interface DownloadRequest {
  filename: string;
  data: unknown;
  format: 'csv' | 'json' | 'txt';
}

// Layout configuration for infinite canvas positioning (pixel coords)
export interface PanelLayout {
  x?: number;       // Pixel X (world coords) - optional, frontend will position if undefined
  y?: number;       // Pixel Y - optional, frontend will position if undefined
  width: number;    // Pixel width
  height: number;   // Pixel height
  rotation?: number;
  groupId?: string;
}

// Resolved layout with required x/y (used by canvas components after positioning)
export interface CanvasPanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Dynamic UI panel system
export interface UIPanel {
  id: string;
  type: 'chat' | 'table' | 'editor' | 'preview' | 'fileTree' | 'detail' | 'chart' | 'cards' | 'markdown' | 'pdf';
  title?: string;
  // Layout on canvas
  layout?: PanelLayout;
  // Type-specific config
  tableId?: string;       // for type: 'table'
  chartId?: string;       // for type: 'chart'
  cardsId?: string;       // for type: 'cards'
  filePath?: string;      // for type: 'editor', 'preview', or 'pdf'
  linkedTo?: string;      // for type: 'detail' (links to a table panel)
  content?: string;       // for type: 'preview' or 'markdown' with inline content
  sourcePanel?: string;   // ID of panel that spawned this one (for connection lines)
}

// Panel grouping
export interface PanelGroup {
  id: string;
  name?: string;
  panelIds: string[];
  color?: string;
}

// Connection between panels (for visual lines)
export interface PanelConnection {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface UIState {
  panels: UIPanel[];
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
  activePanel?: string;
  groups?: PanelGroup[];
  connections?: PanelConnection[];
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  systemPrompt: string;
  tools: string[];
  galleryId?: string; // If published to gallery
}

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface SandboxedStorage {
  userId: string;
  basePath: string;

  // Workspaces
  getWorkspace(workspaceId: string): Promise<WorkspaceConfig | null>;
  setWorkspace(workspaceId: string, config: WorkspaceConfig): Promise<void>;
  listWorkspaces(): Promise<WorkspaceConfig[]>;
  deleteWorkspace(workspaceId: string): Promise<void>;

  // Tables
  getTable(workspaceId: string, tableId: string): Promise<Table | null>;
  setTable(workspaceId: string, tableId: string, table: Table): Promise<void>;
  listTables(workspaceId: string): Promise<Table[]>;

  // Charts
  getChart(workspaceId: string, chartId: string): Promise<ChartData | null>;
  setChart(workspaceId: string, chartId: string, chart: ChartData): Promise<void>;
  listCharts(workspaceId: string): Promise<ChartData[]>;

  // Cards
  getCards(workspaceId: string, cardsId: string): Promise<CardsData | null>;
  setCards(workspaceId: string, cardsId: string, cards: CardsData): Promise<void>;
  listCards(workspaceId: string): Promise<CardsData[]>;

  // Downloads (stored for frontend to pick up)
  addDownload(workspaceId: string, download: DownloadRequest): Promise<void>;
  getDownloads(workspaceId: string): Promise<DownloadRequest[]>;
  clearDownloads(workspaceId: string): Promise<void>;

  // Files
  readFile(workspaceId: string, path: string): Promise<string | null>;
  readFileBuffer(workspaceId: string, path: string): Promise<Buffer | null>;
  writeFile(workspaceId: string, path: string, content: string | Buffer): Promise<void>;
  listFiles(workspaceId: string, dir?: string): Promise<FileInfo[]>;
  deleteFile(workspaceId: string, path: string): Promise<void>;

  // Conversations
  getConversation(workspaceId: string): Promise<Message[]>;
  appendMessage(workspaceId: string, message: Message): Promise<void>;
  clearConversation(workspaceId: string): Promise<void>;

  // UI State
  getUIState(workspaceId: string): Promise<UIState>;
  setUIState(workspaceId: string, state: UIState): Promise<void>;
  updateUIState(
    workspaceId: string,
    updater: (state: UIState) => UIState | void | Promise<UIState | void>
  ): Promise<UIState>;
  addPanel(workspaceId: string, panel: UIPanel): Promise<void>;
  removePanel(workspaceId: string, panelId: string): Promise<void>;
  updatePanel(workspaceId: string, panelId: string, updates: Partial<UIPanel>): Promise<void>;
}

export function createSandboxedStorage(userId: string): SandboxedStorage {
  const basePath = getUserDataPath(userId);

  const ensureDir = async (path: string) => {
    await mkdir(path, { recursive: true });
  };

  // Validate workspace ID to prevent path traversal
  const validateWorkspaceId = (workspaceId: string) => {
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new Error('Invalid workspace ID');
    }
    // Only allow alphanumeric, dash, underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
      throw new Error('Invalid workspace ID format');
    }
    if (workspaceId.length > 64) {
      throw new Error('Workspace ID too long');
    }
  };

  const workspacePath = (workspaceId: string) => {
    validateWorkspaceId(workspaceId);
    return join(basePath, 'workspaces', workspaceId);
  };

  // Resolve safe file path within workspace to prevent path traversal
  const resolveSafePath = (workspaceId: string, userPath: string): string => {
    const baseDir = resolve(workspacePath(workspaceId), 'files');
    // Normalize and resolve the path
    const resolved = resolve(baseDir, userPath);
    // Ensure resolved path is within base directory
    if (!resolved.startsWith(baseDir + sep) && resolved !== baseDir) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  };

  return {
    userId,
    basePath,

    // Workspaces
    async getWorkspace(workspaceId: string): Promise<WorkspaceConfig | null> {
      try {
        const configPath = join(workspacePath(workspaceId), 'config.json');
        const content = await readFile(configPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    async setWorkspace(workspaceId: string, config: WorkspaceConfig): Promise<void> {
      const wsPath = workspacePath(workspaceId);
      await ensureDir(wsPath);
      await ensureDir(join(wsPath, 'tables'));
      await ensureDir(join(wsPath, 'files'));
      await writeFile(
        join(wsPath, 'config.json'),
        JSON.stringify(config, null, 2)
      );
    },

    async listWorkspaces(): Promise<WorkspaceConfig[]> {
      const workspacesDir = join(basePath, 'workspaces');
      try {
        await ensureDir(workspacesDir);
        const entries = await readdir(workspacesDir, { withFileTypes: true });
        const workspaces: WorkspaceConfig[] = [];

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const config = await this.getWorkspace(entry.name);
            if (config) workspaces.push(config);
          }
        }

        return workspaces.sort((a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      } catch {
        return [];
      }
    },

    async deleteWorkspace(workspaceId: string): Promise<void> {
      const wsPath = workspacePath(workspaceId);
      const { rm } = await import('fs/promises');
      await rm(wsPath, { recursive: true, force: true });
    },

    // Tables
    async getTable(workspaceId: string, tableId: string): Promise<Table | null> {
      try {
        const tablePath = join(workspacePath(workspaceId), 'tables', `${tableId}.json`);
        const content = await readFile(tablePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    async setTable(workspaceId: string, tableId: string, table: Table): Promise<void> {
      const tablesDir = join(workspacePath(workspaceId), 'tables');
      await ensureDir(tablesDir);
      await writeFile(
        join(tablesDir, `${tableId}.json`),
        JSON.stringify(table, null, 2)
      );
    },

    async listTables(workspaceId: string): Promise<Table[]> {
      try {
        const tablesDir = join(workspacePath(workspaceId), 'tables');
        const entries = await readdir(tablesDir);
        const tables: Table[] = [];
        for (const entry of entries) {
          if (entry.endsWith('.json')) {
            const table = await this.getTable(workspaceId, entry.replace('.json', ''));
            if (table) tables.push(table);
          }
        }
        return tables;
      } catch {
        return [];
      }
    },

    // Charts
    async getChart(workspaceId: string, chartId: string): Promise<ChartData | null> {
      try {
        const chartPath = join(workspacePath(workspaceId), 'charts', `${chartId}.json`);
        const content = await readFile(chartPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    async setChart(workspaceId: string, chartId: string, chart: ChartData): Promise<void> {
      const chartsDir = join(workspacePath(workspaceId), 'charts');
      await ensureDir(chartsDir);
      await writeFile(
        join(chartsDir, `${chartId}.json`),
        JSON.stringify(chart, null, 2)
      );
    },

    async listCharts(workspaceId: string): Promise<ChartData[]> {
      try {
        const chartsDir = join(workspacePath(workspaceId), 'charts');
        const entries = await readdir(chartsDir);
        const charts: ChartData[] = [];
        for (const entry of entries) {
          if (entry.endsWith('.json')) {
            const chart = await this.getChart(workspaceId, entry.replace('.json', ''));
            if (chart) charts.push(chart);
          }
        }
        return charts;
      } catch {
        return [];
      }
    },

    // Cards
    async getCards(workspaceId: string, cardsId: string): Promise<CardsData | null> {
      try {
        const cardsPath = join(workspacePath(workspaceId), 'cards', `${cardsId}.json`);
        const content = await readFile(cardsPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    async setCards(workspaceId: string, cardsId: string, cards: CardsData): Promise<void> {
      const cardsDir = join(workspacePath(workspaceId), 'cards');
      await ensureDir(cardsDir);
      await writeFile(
        join(cardsDir, `${cardsId}.json`),
        JSON.stringify(cards, null, 2)
      );
    },

    async listCards(workspaceId: string): Promise<CardsData[]> {
      try {
        const cardsDir = join(workspacePath(workspaceId), 'cards');
        const entries = await readdir(cardsDir);
        const cardsList: CardsData[] = [];
        for (const entry of entries) {
          if (entry.endsWith('.json')) {
            const cards = await this.getCards(workspaceId, entry.replace('.json', ''));
            if (cards) cardsList.push(cards);
          }
        }
        return cardsList;
      } catch {
        return [];
      }
    },

    // Downloads
    async addDownload(workspaceId: string, download: DownloadRequest): Promise<void> {
      await withWorkspaceLock(workspaceId, async () => {
        const downloads = await this.getDownloads(workspaceId);
        downloads.push(download);
        const downloadsPath = join(workspacePath(workspaceId), 'downloads.json');
        await writeFile(downloadsPath, JSON.stringify(downloads, null, 2));
      });
    },

    async getDownloads(workspaceId: string): Promise<DownloadRequest[]> {
      try {
        const downloadsPath = join(workspacePath(workspaceId), 'downloads.json');
        const content = await readFile(downloadsPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return [];
      }
    },

    async clearDownloads(workspaceId: string): Promise<void> {
      const downloadsPath = join(workspacePath(workspaceId), 'downloads.json');
      await writeFile(downloadsPath, '[]');
    },

    // Files
    async readFile(workspaceId: string, path: string): Promise<string | null> {
      try {
        const filePath = resolveSafePath(workspaceId, path);
        return await readFile(filePath, 'utf-8');
      } catch {
        return null;
      }
    },

    async readFileBuffer(workspaceId: string, path: string): Promise<Buffer | null> {
      try {
        const filePath = resolveSafePath(workspaceId, path);
        return await readFile(filePath);
      } catch {
        return null;
      }
    },

    async writeFile(workspaceId: string, path: string, content: string | Buffer): Promise<void> {
      const filePath = resolveSafePath(workspaceId, path);
      const dir = join(filePath, '..');
      await ensureDir(dir);
      await writeFile(filePath, content);
    },

    async listFiles(workspaceId: string, dir = ''): Promise<FileInfo[]> {
      try {
        const filesDir = resolveSafePath(workspaceId, dir || '.');
        await ensureDir(filesDir);
        const entries = await readdir(filesDir, { withFileTypes: true });

        const files: FileInfo[] = [];
        for (const entry of entries) {
          const filePath = join(dir, entry.name);
          const fullPath = join(filesDir, entry.name);

          if (entry.isDirectory()) {
            files.push({
              name: entry.name,
              path: filePath,
              isDirectory: true,
            });
          } else {
            const stats = await stat(fullPath);
            files.push({
              name: entry.name,
              path: filePath,
              isDirectory: false,
              size: stats.size,
              modifiedAt: stats.mtime.toISOString(),
            });
          }
        }

        return files.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      } catch {
        return [];
      }
    },

    async deleteFile(workspaceId: string, path: string): Promise<void> {
      const filePath = resolveSafePath(workspaceId, path);
      await unlink(filePath);
    },

    // Conversations
    async getConversation(workspaceId: string): Promise<Message[]> {
      try {
        const convPath = join(workspacePath(workspaceId), 'conversation.json');
        const content = await readFile(convPath, 'utf-8');
        return JSON.parse(content) as Message[];
      } catch {
        return [];
      }
    },

    async appendMessage(workspaceId: string, message: Message): Promise<void> {
      await withWorkspaceLock(workspaceId, async () => {
        const messages = await this.getConversation(workspaceId);
        messages.push(message);
        const convPath = join(workspacePath(workspaceId), 'conversation.json');
        await writeFile(convPath, JSON.stringify(messages, null, 2));
      });
    },

    async clearConversation(workspaceId: string): Promise<void> {
      const convPath = join(workspacePath(workspaceId), 'conversation.json');
      await writeFile(convPath, '[]');
    },

    // UI State
    async getUIState(workspaceId: string): Promise<UIState> {
      try {
        const uiPath = join(workspacePath(workspaceId), 'ui.json');
        const content = await readFile(uiPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Default: just a chat panel
        return {
          panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
          viewport: { x: 0, y: 0, zoom: 1 },
        };
      }
    },

    async setUIState(workspaceId: string, state: UIState): Promise<void> {
      const uiPath = join(workspacePath(workspaceId), 'ui.json');
      const tmpPath = `${uiPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(state, null, 2));
      await rename(tmpPath, uiPath);
    },

    async updateUIState(
      workspaceId: string,
      updater: (state: UIState) => UIState | void | Promise<UIState | void>
    ): Promise<UIState> {
      return withWorkspaceLock(workspaceId, async () => {
        const state = await this.getUIState(workspaceId);
        const next = (await updater(state)) ?? state;
        await this.setUIState(workspaceId, next);
        return next;
      });
    },

    async addPanel(workspaceId: string, panel: UIPanel): Promise<void> {
      await withWorkspaceLock(workspaceId, async () => {
        const state = await this.getUIState(workspaceId);
        // Remove existing panel with same id if present
        state.panels = state.panels.filter(p => p.id !== panel.id);
        state.panels.push(panel);
        await this.setUIState(workspaceId, state);
      });
    },

    async removePanel(workspaceId: string, panelId: string): Promise<void> {
      await withWorkspaceLock(workspaceId, async () => {
        const state = await this.getUIState(workspaceId);
        state.panels = state.panels.filter(p => p.id !== panelId);
        await this.setUIState(workspaceId, state);
      });
    },

    async updatePanel(workspaceId: string, panelId: string, updates: Partial<UIPanel>): Promise<void> {
      await withWorkspaceLock(workspaceId, async () => {
        const state = await this.getUIState(workspaceId);
        const panel = state.panels.find(p => p.id === panelId);
        if (panel) {
          Object.assign(panel, updates);
          await this.setUIState(workspaceId, state);
        }
      });
    },
  };
}
