"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSandboxedStorage = createSandboxedStorage;
const promises_1 = require("fs/promises");
const path_1 = require("path");
const session_1 = require("../session");
// Simple per-workspace mutex to prevent race conditions in read-modify-write operations
const workspaceLocks = new Map();
async function withWorkspaceLock(workspaceId, fn) {
    const lockKey = workspaceId;
    // Wait for any existing lock to release
    while (workspaceLocks.has(lockKey)) {
        await workspaceLocks.get(lockKey);
    }
    // Create new lock
    let releaseLock;
    const lockPromise = new Promise(resolve => {
        releaseLock = resolve;
    });
    workspaceLocks.set(lockKey, lockPromise);
    try {
        return await fn();
    }
    finally {
        workspaceLocks.delete(lockKey);
        releaseLock();
    }
}
function createSandboxedStorage(userId) {
    const basePath = (0, session_1.getUserDataPath)(userId);
    const ensureDir = async (path) => {
        await (0, promises_1.mkdir)(path, { recursive: true });
    };
    // Validate workspace ID to prevent path traversal
    const validateWorkspaceId = (workspaceId) => {
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
    const workspacePath = (workspaceId) => {
        validateWorkspaceId(workspaceId);
        return (0, path_1.join)(basePath, 'workspaces', workspaceId);
    };
    // Resolve safe file path within workspace to prevent path traversal
    const resolveSafePath = (workspaceId, userPath) => {
        const baseDir = (0, path_1.resolve)(workspacePath(workspaceId), 'files');
        // Normalize and resolve the path
        const resolved = (0, path_1.resolve)(baseDir, userPath);
        // Ensure resolved path is within base directory
        if (!resolved.startsWith(baseDir + path_1.sep) && resolved !== baseDir) {
            throw new Error('Path traversal detected');
        }
        return resolved;
    };
    return {
        userId,
        basePath,
        // Workspaces
        async getWorkspace(workspaceId) {
            try {
                const configPath = (0, path_1.join)(workspacePath(workspaceId), 'config.json');
                const content = await (0, promises_1.readFile)(configPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return null;
            }
        },
        async setWorkspace(workspaceId, config) {
            const wsPath = workspacePath(workspaceId);
            await ensureDir(wsPath);
            await ensureDir((0, path_1.join)(wsPath, 'tables'));
            await ensureDir((0, path_1.join)(wsPath, 'files'));
            await (0, promises_1.writeFile)((0, path_1.join)(wsPath, 'config.json'), JSON.stringify(config, null, 2));
        },
        async listWorkspaces() {
            const workspacesDir = (0, path_1.join)(basePath, 'workspaces');
            try {
                await ensureDir(workspacesDir);
                const entries = await (0, promises_1.readdir)(workspacesDir, { withFileTypes: true });
                const workspaces = [];
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const config = await this.getWorkspace(entry.name);
                        if (config)
                            workspaces.push(config);
                    }
                }
                return workspaces.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            }
            catch {
                return [];
            }
        },
        async deleteWorkspace(workspaceId) {
            const wsPath = workspacePath(workspaceId);
            const { rm } = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            await rm(wsPath, { recursive: true, force: true });
        },
        // Tables
        async getTable(workspaceId, tableId) {
            try {
                const tablePath = (0, path_1.join)(workspacePath(workspaceId), 'tables', `${tableId}.json`);
                const content = await (0, promises_1.readFile)(tablePath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return null;
            }
        },
        async setTable(workspaceId, tableId, table) {
            const tablesDir = (0, path_1.join)(workspacePath(workspaceId), 'tables');
            await ensureDir(tablesDir);
            await (0, promises_1.writeFile)((0, path_1.join)(tablesDir, `${tableId}.json`), JSON.stringify(table, null, 2));
        },
        async listTables(workspaceId) {
            try {
                const tablesDir = (0, path_1.join)(workspacePath(workspaceId), 'tables');
                const entries = await (0, promises_1.readdir)(tablesDir);
                const tables = [];
                for (const entry of entries) {
                    if (entry.endsWith('.json')) {
                        const table = await this.getTable(workspaceId, entry.replace('.json', ''));
                        if (table)
                            tables.push(table);
                    }
                }
                return tables;
            }
            catch {
                return [];
            }
        },
        // Charts
        async getChart(workspaceId, chartId) {
            try {
                const chartPath = (0, path_1.join)(workspacePath(workspaceId), 'charts', `${chartId}.json`);
                const content = await (0, promises_1.readFile)(chartPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return null;
            }
        },
        async setChart(workspaceId, chartId, chart) {
            const chartsDir = (0, path_1.join)(workspacePath(workspaceId), 'charts');
            await ensureDir(chartsDir);
            await (0, promises_1.writeFile)((0, path_1.join)(chartsDir, `${chartId}.json`), JSON.stringify(chart, null, 2));
        },
        async listCharts(workspaceId) {
            try {
                const chartsDir = (0, path_1.join)(workspacePath(workspaceId), 'charts');
                const entries = await (0, promises_1.readdir)(chartsDir);
                const charts = [];
                for (const entry of entries) {
                    if (entry.endsWith('.json')) {
                        const chart = await this.getChart(workspaceId, entry.replace('.json', ''));
                        if (chart)
                            charts.push(chart);
                    }
                }
                return charts;
            }
            catch {
                return [];
            }
        },
        // Cards
        async getCards(workspaceId, cardsId) {
            try {
                const cardsPath = (0, path_1.join)(workspacePath(workspaceId), 'cards', `${cardsId}.json`);
                const content = await (0, promises_1.readFile)(cardsPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return null;
            }
        },
        async setCards(workspaceId, cardsId, cards) {
            const cardsDir = (0, path_1.join)(workspacePath(workspaceId), 'cards');
            await ensureDir(cardsDir);
            await (0, promises_1.writeFile)((0, path_1.join)(cardsDir, `${cardsId}.json`), JSON.stringify(cards, null, 2));
        },
        async listCards(workspaceId) {
            try {
                const cardsDir = (0, path_1.join)(workspacePath(workspaceId), 'cards');
                const entries = await (0, promises_1.readdir)(cardsDir);
                const cardsList = [];
                for (const entry of entries) {
                    if (entry.endsWith('.json')) {
                        const cards = await this.getCards(workspaceId, entry.replace('.json', ''));
                        if (cards)
                            cardsList.push(cards);
                    }
                }
                return cardsList;
            }
            catch {
                return [];
            }
        },
        // Downloads
        async addDownload(workspaceId, download) {
            await withWorkspaceLock(workspaceId, async () => {
                const downloads = await this.getDownloads(workspaceId);
                downloads.push(download);
                const downloadsPath = (0, path_1.join)(workspacePath(workspaceId), 'downloads.json');
                await (0, promises_1.writeFile)(downloadsPath, JSON.stringify(downloads, null, 2));
            });
        },
        async getDownloads(workspaceId) {
            try {
                const downloadsPath = (0, path_1.join)(workspacePath(workspaceId), 'downloads.json');
                const content = await (0, promises_1.readFile)(downloadsPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return [];
            }
        },
        async clearDownloads(workspaceId) {
            const downloadsPath = (0, path_1.join)(workspacePath(workspaceId), 'downloads.json');
            await (0, promises_1.writeFile)(downloadsPath, '[]');
        },
        // Files
        async readFile(workspaceId, path) {
            try {
                const filePath = resolveSafePath(workspaceId, path);
                return await (0, promises_1.readFile)(filePath, 'utf-8');
            }
            catch {
                return null;
            }
        },
        async readFileBuffer(workspaceId, path) {
            try {
                const filePath = resolveSafePath(workspaceId, path);
                return await (0, promises_1.readFile)(filePath);
            }
            catch {
                return null;
            }
        },
        async writeFile(workspaceId, path, content) {
            const filePath = resolveSafePath(workspaceId, path);
            const dir = (0, path_1.join)(filePath, '..');
            await ensureDir(dir);
            await (0, promises_1.writeFile)(filePath, content);
        },
        async listFiles(workspaceId, dir = '') {
            try {
                const filesDir = resolveSafePath(workspaceId, dir || '.');
                await ensureDir(filesDir);
                const entries = await (0, promises_1.readdir)(filesDir, { withFileTypes: true });
                const files = [];
                for (const entry of entries) {
                    const filePath = (0, path_1.join)(dir, entry.name);
                    const fullPath = (0, path_1.join)(filesDir, entry.name);
                    if (entry.isDirectory()) {
                        files.push({
                            name: entry.name,
                            path: filePath,
                            isDirectory: true,
                        });
                    }
                    else {
                        const stats = await (0, promises_1.stat)(fullPath);
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
                    if (a.isDirectory !== b.isDirectory)
                        return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
            }
            catch {
                return [];
            }
        },
        async deleteFile(workspaceId, path) {
            const filePath = resolveSafePath(workspaceId, path);
            await (0, promises_1.unlink)(filePath);
        },
        // Conversations
        async getConversation(workspaceId) {
            try {
                const convPath = (0, path_1.join)(workspacePath(workspaceId), 'conversation.json');
                const content = await (0, promises_1.readFile)(convPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return [];
            }
        },
        async appendMessage(workspaceId, message) {
            await withWorkspaceLock(workspaceId, async () => {
                const messages = await this.getConversation(workspaceId);
                messages.push(message);
                const convPath = (0, path_1.join)(workspacePath(workspaceId), 'conversation.json');
                await (0, promises_1.writeFile)(convPath, JSON.stringify(messages, null, 2));
            });
        },
        async clearConversation(workspaceId) {
            const convPath = (0, path_1.join)(workspacePath(workspaceId), 'conversation.json');
            await (0, promises_1.writeFile)(convPath, '[]');
        },
        // UI State
        async getUIState(workspaceId) {
            try {
                const uiPath = (0, path_1.join)(workspacePath(workspaceId), 'ui.json');
                const content = await (0, promises_1.readFile)(uiPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                // Default: just a chat panel
                return {
                    panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
                    viewport: { x: 0, y: 0, zoom: 1 },
                };
            }
        },
        async setUIState(workspaceId, state) {
            const uiPath = (0, path_1.join)(workspacePath(workspaceId), 'ui.json');
            const tmpPath = `${uiPath}.tmp`;
            await (0, promises_1.writeFile)(tmpPath, JSON.stringify(state, null, 2));
            await (0, promises_1.rename)(tmpPath, uiPath);
        },
        async updateUIState(workspaceId, updater) {
            return withWorkspaceLock(workspaceId, async () => {
                var _a;
                const state = await this.getUIState(workspaceId);
                const next = (_a = (await updater(state))) !== null && _a !== void 0 ? _a : state;
                await this.setUIState(workspaceId, next);
                return next;
            });
        },
        async addPanel(workspaceId, panel) {
            await withWorkspaceLock(workspaceId, async () => {
                const state = await this.getUIState(workspaceId);
                // Remove existing panel with same id if present
                state.panels = state.panels.filter(p => p.id !== panel.id);
                state.panels.push(panel);
                await this.setUIState(workspaceId, state);
            });
        },
        async removePanel(workspaceId, panelId) {
            await withWorkspaceLock(workspaceId, async () => {
                const state = await this.getUIState(workspaceId);
                state.panels = state.panels.filter(p => p.id !== panelId);
                await this.setUIState(workspaceId, state);
            });
        },
        async updatePanel(workspaceId, panelId, updates) {
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
