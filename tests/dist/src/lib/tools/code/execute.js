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
exports.createExecuteTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
const vm = __importStar(require("vm"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const promises_1 = require("dns/promises");
const net = __importStar(require("net"));
const pdf_parse_1 = require("pdf-parse");
const minimatch_1 = require("minimatch");
const fast_xml_parser_1 = require("fast-xml-parser");
// Skills directory location
const SKILLS_DIR = path.join(process.cwd(), 'src/lib/skills');
const FETCH_TIMEOUT_MS = 15000;
// Python venv path - computed lazily to avoid Turbopack static analysis
function getPythonBin() {
    const venv = process.env.PYTHON_VENV_PATH || `${process.cwd()}/.venv`;
    return `${venv}/bin/python3`;
}
function isPrivateIpv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN))
        return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127)
        return true;
    if (a === 169 && b === 254)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    return false;
}
function normalizeHostForIp(host) {
    const normalized = host.toLowerCase();
    const debracketed = normalized.startsWith('[') && normalized.endsWith(']')
        ? normalized.slice(1, -1)
        : normalized;
    const zoneIndex = debracketed.indexOf('%');
    return zoneIndex >= 0 ? debracketed.slice(0, zoneIndex) : debracketed;
}
function isPrivateHost(host) {
    const normalized = host.toLowerCase();
    if (normalized === 'localhost')
        return true;
    const hostForIp = normalizeHostForIp(normalized);
    const ipVersion = net.isIP(hostForIp);
    if (ipVersion === 4) {
        return isPrivateIpv4(hostForIp);
    }
    if (ipVersion === 6) {
        if (hostForIp === '::' || hostForIp === '::1')
            return true;
        if (hostForIp.startsWith('fe80:'))
            return true; // Link-local
        if (hostForIp.startsWith('fc') || hostForIp.startsWith('fd'))
            return true; // ULA
        if (hostForIp.startsWith('::ffff:')) {
            const v4 = hostForIp.slice('::ffff:'.length);
            if (net.isIP(v4) === 4)
                return isPrivateIpv4(v4);
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
const createExecuteTool = (ctx) => {
    const { storage, workspaceId } = ctx;
    // Track panel updates during execution for streaming to client
    const panelUpdates = [];
    const shouldEmbedPanelUpdates = !ctx.emitPanelUpdates;
    const emitPanelUpdate = (update) => {
        if (ctx.emitPanelUpdates) {
            try {
                ctx.emitPanelUpdates([update]);
            }
            catch (error) {
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
        async read(from) {
            var _a, _b;
            if (from.startsWith('table:')) {
                const tableId = from.slice(6);
                const table = await storage.getTable(workspaceId, tableId);
                return (_a = table === null || table === void 0 ? void 0 : table.data) !== null && _a !== void 0 ? _a : [];
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
                        const parser = new pdf_parse_1.PDFParse({ data: buffer });
                        const result = await parser.getText();
                        return result.text;
                    }
                    catch (err) {
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
                return (_b = panel === null || panel === void 0 ? void 0 : panel.content) !== null && _b !== void 0 ? _b : null;
            }
            throw new Error(`Unknown source: ${from}. Use "table:name", "file:path", "chart:id", "cards:id", or "markdown:id"`);
        },
        async write(data, to) {
            if (to.startsWith('table:')) {
                const tableId = to.slice(6);
                const existing = await storage.getTable(workspaceId, tableId);
                if (existing) {
                    existing.data = data;
                    await storage.setTable(workspaceId, tableId, existing);
                }
                else {
                    const rows = data;
                    const columns = rows.length > 0
                        ? Object.keys(rows[0]).map(key => ({ key, label: key, type: 'text' }))
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
        filter(data, where) {
            const match = where.match(/^(\w+)\s*(==|!=|>|<|>=|<=|contains)\s*(.+)$/);
            if (!match)
                return data;
            const [, field, op, valueStr] = match;
            const value = valueStr.startsWith('"') || valueStr.startsWith("'")
                ? valueStr.slice(1, -1)
                : isNaN(Number(valueStr)) ? valueStr : Number(valueStr);
            return data.filter((item) => {
                const rec = item;
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
        pick(data, fields) {
            return data.map((item) => {
                const rec = item;
                const result = {};
                for (const field of fields) {
                    if (field in rec)
                        result[field] = rec[field];
                }
                return result;
            });
        },
        sort(data, field, order = 'asc') {
            return [...data].sort((a, b) => {
                const recA = a;
                const recB = b;
                const aVal = recA[field];
                const bVal = recB[field];
                const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                return order === 'desc' ? -cmp : cmp;
            });
        },
        map(data, fn) {
            return data.map(fn);
        },
        unique(data, field) {
            if (field) {
                const seen = new Set();
                return data.filter((item) => {
                    const rec = item;
                    const val = rec[field];
                    if (seen.has(val))
                        return false;
                    seen.add(val);
                    return true;
                });
            }
            return [...new Set(data)];
        },
        group(data, field) {
            var _a;
            const groups = {};
            for (const item of data) {
                const rec = item;
                const key = String((_a = rec[field]) !== null && _a !== void 0 ? _a : 'undefined');
                if (!groups[key])
                    groups[key] = [];
                groups[key].push(item);
            }
            return groups;
        },
        // === UI ===
        async setTable(id, config) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
            const existing = await storage.getTable(workspaceId, id);
            const rows = config.data;
            // Infer columns if not provided
            const columns = (_c = (_b = (_a = config.columns) === null || _a === void 0 ? void 0 : _a.map(c => ({ ...c, type: c.type || 'text' }))) !== null && _b !== void 0 ? _b : existing === null || existing === void 0 ? void 0 : existing.columns) !== null && _c !== void 0 ? _c : (rows.length > 0 ? Object.keys(rows[0]).map(k => ({ key: k, label: k, type: 'text' })) : []);
            const tableData = {
                id,
                title: (_e = (_d = config.title) !== null && _d !== void 0 ? _d : existing === null || existing === void 0 ? void 0 : existing.title) !== null && _e !== void 0 ? _e : id,
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
                const panel = {
                    id: `table-${id}`,
                    type: 'table',
                    tableId: id,
                    title: (_f = config.title) !== null && _f !== void 0 ? _f : id,
                    layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
                };
                await storage.addPanel(workspaceId, panel);
                // Track for streaming
                emitPanelUpdate({ action: 'add', panel, data: { table: tableData } });
            }
            else {
                // Existing panel: preserve position if it has one, otherwise let frontend position
                const hasExistingPosition = ((_g = existingPanel.layout) === null || _g === void 0 ? void 0 : _g.x) !== undefined && ((_h = existingPanel.layout) === null || _h === void 0 ? void 0 : _h.y) !== undefined;
                const updatedLayout = hasExistingPosition ? {
                    x: (_k = (_j = config.layout) === null || _j === void 0 ? void 0 : _j.x) !== null && _k !== void 0 ? _k : existingPanel.layout.x,
                    y: (_m = (_l = config.layout) === null || _l === void 0 ? void 0 : _l.y) !== null && _m !== void 0 ? _m : existingPanel.layout.y,
                    width: (_r = (_p = (_o = config.layout) === null || _o === void 0 ? void 0 : _o.width) !== null && _p !== void 0 ? _p : (_q = existingPanel.layout) === null || _q === void 0 ? void 0 : _q.width) !== null && _r !== void 0 ? _r : defaultSize.width,
                    height: (_v = (_t = (_s = config.layout) === null || _s === void 0 ? void 0 : _s.height) !== null && _t !== void 0 ? _t : (_u = existingPanel.layout) === null || _u === void 0 ? void 0 : _u.height) !== null && _v !== void 0 ? _v : defaultSize.height,
                } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;
                if (config.layout && updatedLayout) {
                    await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
                }
                emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { table: tableData } });
            }
        },
        async addPanel(panel) {
            const typedPanel = panel;
            await storage.addPanel(workspaceId, typedPanel);
            emitPanelUpdate({ action: 'add', panel: typedPanel });
        },
        async removePanel(id) {
            const ui = await storage.getUIState(workspaceId);
            const panel = ui.panels.find(p => p.id === id);
            await storage.removePanel(workspaceId, id);
            if (panel) {
                emitPanelUpdate({ action: 'remove', panel });
            }
        },
        async updatePanel(id, updates) {
            const ui = await storage.getUIState(workspaceId);
            const existingPanel = ui.panels.find(p => p.id === id);
            if (!existingPanel) {
                return;
            }
            const updatedPanel = { ...existingPanel, ...updates };
            await storage.updatePanel(workspaceId, id, updates);
            emitPanelUpdate({ action: 'update', panel: updatedPanel });
        },
        // === Charts ===
        async setChart(id, config) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
            const chartData = {
                id,
                title: (_a = config.title) !== null && _a !== void 0 ? _a : id,
                type: config.type,
                data: config.data,
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
                const panel = {
                    id: `chart-${id}`,
                    type: 'chart',
                    chartId: id,
                    title: (_b = config.title) !== null && _b !== void 0 ? _b : id,
                    layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
                };
                await storage.addPanel(workspaceId, panel);
                emitPanelUpdate({ action: 'add', panel, data: { chart: chartData } });
            }
            else {
                // Existing panel: preserve position if it has one, otherwise let frontend position
                const hasExistingPosition = ((_c = existingPanel.layout) === null || _c === void 0 ? void 0 : _c.x) !== undefined && ((_d = existingPanel.layout) === null || _d === void 0 ? void 0 : _d.y) !== undefined;
                const updatedLayout = hasExistingPosition ? {
                    x: (_f = (_e = config.layout) === null || _e === void 0 ? void 0 : _e.x) !== null && _f !== void 0 ? _f : existingPanel.layout.x,
                    y: (_h = (_g = config.layout) === null || _g === void 0 ? void 0 : _g.y) !== null && _h !== void 0 ? _h : existingPanel.layout.y,
                    width: (_m = (_k = (_j = config.layout) === null || _j === void 0 ? void 0 : _j.width) !== null && _k !== void 0 ? _k : (_l = existingPanel.layout) === null || _l === void 0 ? void 0 : _l.width) !== null && _m !== void 0 ? _m : defaultSize.width,
                    height: (_r = (_p = (_o = config.layout) === null || _o === void 0 ? void 0 : _o.height) !== null && _p !== void 0 ? _p : (_q = existingPanel.layout) === null || _q === void 0 ? void 0 : _q.height) !== null && _r !== void 0 ? _r : defaultSize.height,
                } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;
                if (config.layout && updatedLayout) {
                    await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
                }
                emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { chart: chartData } });
            }
        },
        // === Cards ===
        async setCards(id, config) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
            const cardsData = {
                id,
                title: (_a = config.title) !== null && _a !== void 0 ? _a : id,
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
                const panel = {
                    id: `cards-${id}`,
                    type: 'cards',
                    cardsId: id,
                    title: (_b = config.title) !== null && _b !== void 0 ? _b : id,
                    layout: config.layout ? { ...defaultSize, ...config.layout } : undefined
                };
                await storage.addPanel(workspaceId, panel);
                emitPanelUpdate({ action: 'add', panel, data: { cards: cardsData } });
            }
            else {
                // Existing panel: preserve position if it has one, otherwise let frontend position
                const hasExistingPosition = ((_c = existingPanel.layout) === null || _c === void 0 ? void 0 : _c.x) !== undefined && ((_d = existingPanel.layout) === null || _d === void 0 ? void 0 : _d.y) !== undefined;
                const updatedLayout = hasExistingPosition ? {
                    x: (_f = (_e = config.layout) === null || _e === void 0 ? void 0 : _e.x) !== null && _f !== void 0 ? _f : existingPanel.layout.x,
                    y: (_h = (_g = config.layout) === null || _g === void 0 ? void 0 : _g.y) !== null && _h !== void 0 ? _h : existingPanel.layout.y,
                    width: (_m = (_k = (_j = config.layout) === null || _j === void 0 ? void 0 : _j.width) !== null && _k !== void 0 ? _k : (_l = existingPanel.layout) === null || _l === void 0 ? void 0 : _l.width) !== null && _m !== void 0 ? _m : defaultSize.width,
                    height: (_r = (_p = (_o = config.layout) === null || _o === void 0 ? void 0 : _o.height) !== null && _p !== void 0 ? _p : (_q = existingPanel.layout) === null || _q === void 0 ? void 0 : _q.height) !== null && _r !== void 0 ? _r : defaultSize.height,
                } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;
                if (config.layout && updatedLayout) {
                    await storage.updatePanel(workspaceId, existingPanel.id, { layout: updatedLayout });
                }
                emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: updatedLayout }, data: { cards: cardsData } });
            }
        },
        // === Markdown ===
        async setMarkdown(id, config) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
            const ui = await storage.getUIState(workspaceId);
            const existingPanel = ui.panels.find(p => p.id === id);
            // Default size for markdown - x/y left undefined so frontend positions in viewport
            const defaultSize = { width: 400, height: 300 };
            if (existingPanel) {
                // Existing panel: preserve position if it has one, otherwise let frontend position
                const hasExistingPosition = ((_a = existingPanel.layout) === null || _a === void 0 ? void 0 : _a.x) !== undefined && ((_b = existingPanel.layout) === null || _b === void 0 ? void 0 : _b.y) !== undefined;
                const updatedLayout = hasExistingPosition ? {
                    x: (_d = (_c = config.layout) === null || _c === void 0 ? void 0 : _c.x) !== null && _d !== void 0 ? _d : existingPanel.layout.x,
                    y: (_f = (_e = config.layout) === null || _e === void 0 ? void 0 : _e.y) !== null && _f !== void 0 ? _f : existingPanel.layout.y,
                    width: (_k = (_h = (_g = config.layout) === null || _g === void 0 ? void 0 : _g.width) !== null && _h !== void 0 ? _h : (_j = existingPanel.layout) === null || _j === void 0 ? void 0 : _j.width) !== null && _k !== void 0 ? _k : defaultSize.width,
                    height: (_p = (_m = (_l = config.layout) === null || _l === void 0 ? void 0 : _l.height) !== null && _m !== void 0 ? _m : (_o = existingPanel.layout) === null || _o === void 0 ? void 0 : _o.height) !== null && _p !== void 0 ? _p : defaultSize.height,
                } : config.layout ? { ...defaultSize, ...config.layout } : existingPanel.layout;
                const updatedPanel = {
                    ...existingPanel,
                    type: 'markdown',
                    title: (_q = config.title) !== null && _q !== void 0 ? _q : existingPanel.title,
                    content: config.content,
                    layout: updatedLayout,
                };
                await storage.updatePanel(workspaceId, id, updatedPanel);
                emitPanelUpdate({ action: 'update', panel: updatedPanel, data: { content: config.content } });
            }
            else {
                // New panel: only set size, let frontend position it in the viewport
                const panel = {
                    id,
                    type: 'markdown',
                    title: (_r = config.title) !== null && _r !== void 0 ? _r : id,
                    content: config.content,
                    layout: config.layout ? { ...defaultSize, ...config.layout } : undefined,
                };
                await storage.addPanel(workspaceId, panel);
                emitPanelUpdate({ action: 'add', panel, data: { content: config.content } });
            }
        },
        // === PDF ===
        async setPdf(id, config) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
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
                const hasExistingPosition = ((_a = existingPanel.layout) === null || _a === void 0 ? void 0 : _a.x) !== undefined && ((_b = existingPanel.layout) === null || _b === void 0 ? void 0 : _b.y) !== undefined;
                const updatedLayout = hasExistingPosition ? {
                    x: (_d = (_c = config.layout) === null || _c === void 0 ? void 0 : _c.x) !== null && _d !== void 0 ? _d : existingPanel.layout.x,
                    y: (_f = (_e = config.layout) === null || _e === void 0 ? void 0 : _e.y) !== null && _f !== void 0 ? _f : existingPanel.layout.y,
                    width: (_k = (_h = (_g = config.layout) === null || _g === void 0 ? void 0 : _g.width) !== null && _h !== void 0 ? _h : (_j = existingPanel.layout) === null || _j === void 0 ? void 0 : _j.width) !== null && _k !== void 0 ? _k : defaultSize.width,
                    height: (_p = (_m = (_l = config.layout) === null || _l === void 0 ? void 0 : _l.height) !== null && _m !== void 0 ? _m : (_o = existingPanel.layout) === null || _o === void 0 ? void 0 : _o.height) !== null && _p !== void 0 ? _p : defaultSize.height,
                } : config.layout ? { ...defaultSize, ...config.layout } : undefined;
                const updatedPanel = {
                    ...existingPanel,
                    type: 'pdf',
                    title: (_q = config.title) !== null && _q !== void 0 ? _q : existingPanel.title,
                    filePath: config.filePath,
                    layout: updatedLayout,
                };
                await storage.updatePanel(workspaceId, id, updatedPanel);
                emitPanelUpdate({ action: 'update', panel: updatedPanel });
            }
            else {
                // New panel: only set size, let frontend position it in the viewport
                const panel = {
                    id,
                    type: 'pdf',
                    title: (_r = config.title) !== null && _r !== void 0 ? _r : config.filePath,
                    filePath: config.filePath,
                    layout: config.layout ? { ...defaultSize, ...config.layout } : undefined,
                };
                await storage.addPanel(workspaceId, panel);
                emitPanelUpdate({ action: 'add', panel });
            }
        },
        // === Layout ===
        async movePanel(id, layout) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
            // Get current panel to merge with existing layout
            const ui = await storage.getUIState(workspaceId);
            const existingPanel = ui.panels.find(p => p.id === id);
            if (!existingPanel) {
                throw new Error(`Panel not found: ${id}`);
            }
            // Only update fields that are explicitly provided or already exist
            const fullLayout = {
                x: (_c = (_a = layout.x) !== null && _a !== void 0 ? _a : (_b = existingPanel.layout) === null || _b === void 0 ? void 0 : _b.x) !== null && _c !== void 0 ? _c : 0,
                y: (_f = (_d = layout.y) !== null && _d !== void 0 ? _d : (_e = existingPanel.layout) === null || _e === void 0 ? void 0 : _e.y) !== null && _f !== void 0 ? _f : 0,
                width: (_j = (_g = layout.width) !== null && _g !== void 0 ? _g : (_h = existingPanel.layout) === null || _h === void 0 ? void 0 : _h.width) !== null && _j !== void 0 ? _j : 400,
                height: (_m = (_k = layout.height) !== null && _k !== void 0 ? _k : (_l = existingPanel.layout) === null || _l === void 0 ? void 0 : _l.height) !== null && _m !== void 0 ? _m : 300,
            };
            await storage.updatePanel(workspaceId, id, { layout: fullLayout });
            emitPanelUpdate({ action: 'update', panel: { ...existingPanel, layout: fullLayout } });
        },
        // === Downloads ===
        async download(filename, data, format = 'json') {
            await storage.addDownload(workspaceId, { filename, data, format });
        },
        // === Utilities ===
        // logs array will be populated later in the sandbox
        __logs: [],
        log(...args) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            toolFunctions.__logs.push(msg);
            console.log('[agent]', ...args);
        },
        // === Workspace Info ===
        async setWorkspaceInfo(info) {
            const workspace = await storage.getWorkspace(workspaceId);
            if (workspace) {
                if (info.title)
                    workspace.name = info.title;
                if (info.description)
                    workspace.description = info.description;
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
        parseXML(xml, options) {
            var _a, _b;
            const parser = new fast_xml_parser_1.XMLParser({
                ignoreAttributes: (_a = options === null || options === void 0 ? void 0 : options.ignoreAttributes) !== null && _a !== void 0 ? _a : false,
                attributeNamePrefix: (_b = options === null || options === void 0 ? void 0 : options.attributeNamePrefix) !== null && _b !== void 0 ? _b : '@_',
                textNodeName: '#text',
                removeNSPrefix: true, // Remove namespace prefixes for easier access
            });
            return parser.parse(xml);
        },
        // === HTTP ===
        async fetch(url, options) {
            var _a;
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
                let addresses = [];
                try {
                    addresses = await (0, promises_1.lookup)(hostForIp, { all: true, verbatim: true });
                }
                catch {
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
            let abortListener;
            if (options === null || options === void 0 ? void 0 : options.signal) {
                if (options.signal.aborted) {
                    timeoutController.abort();
                }
                else {
                    abortListener = () => timeoutController.abort();
                    options.signal.addEventListener('abort', abortListener, { once: true });
                }
            }
            try {
                return await globalThis.fetch(url, {
                    ...options,
                    signal: timeoutController.signal,
                });
            }
            finally {
                clearTimeout(timeoutId);
                if (abortListener) {
                    (_a = options === null || options === void 0 ? void 0 : options.signal) === null || _a === void 0 ? void 0 : _a.removeEventListener('abort', abortListener);
                }
            }
        },
        // === Skills Discovery ===
        async listSkills() {
            try {
                const indexPath = path.join(SKILLS_DIR, 'index.json');
                const content = await fs.promises.readFile(indexPath, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                return [];
            }
        },
        async readSkill(name) {
            // Validate skill name to prevent path traversal
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
                return `Invalid skill name: "${name}"`;
            }
            try {
                const skillPath = path.join(SKILLS_DIR, `${name}.md`);
                return await fs.promises.readFile(skillPath, 'utf-8');
            }
            catch (err) {
                if (err.code === 'ENOENT') {
                    return `Skill "${name}" not found`;
                }
                return `Error reading skill: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
        // === Environment ===
        env(key) {
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
        async glob(pattern) {
            // Recursively get all files in workspace
            const getAllFiles = async (dir) => {
                const files = await storage.listFiles(workspaceId, dir);
                const results = [];
                for (const file of files) {
                    if (file.isDirectory) {
                        const subFiles = await getAllFiles(file.path);
                        results.push(...subFiles);
                    }
                    else {
                        results.push(file.path);
                    }
                }
                return results;
            };
            const allFiles = await getAllFiles('');
            // Filter by glob pattern
            return allFiles.filter(f => (0, minimatch_1.minimatch)(f, pattern, { matchBase: true }));
        },
        // === Content Search (Grep) ===
        async search(pattern, filePath) {
            const results = [];
            const regex = new RegExp(pattern, 'gi');
            const searchFile = async (file) => {
                const content = await storage.readFile(workspaceId, file);
                if (!content)
                    return;
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
            }
            else {
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
        async edit(filePath, oldText, newText) {
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
        async listFiles(dir) {
            return storage.listFiles(workspaceId, dir || '');
        },
        // === Delete File ===
        async deleteFile(filePath) {
            await storage.deleteFile(workspaceId, filePath);
        },
        // === Get Absolute Path (for Bash/Python) ===
        getFilePath(filename) {
            // Returns the absolute filesystem path for use with Bash/Python
            // Validates the filename to prevent path traversal
            if (filename.includes('..') || filename.startsWith('/')) {
                throw new Error('Invalid filename');
            }
            return path.join(storage.basePath, 'workspaces', workspaceId, 'files', filename);
        },
        // === Get Workspace Directory (for Bash/Python) ===
        getWorkspaceDir() {
            return path.join(storage.basePath, 'workspaces', workspaceId, 'files');
        },
    };
    return (0, claude_agent_sdk_1.tool)('execute', `Execute JavaScript code to compose data operations, call APIs, and build UI.

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

Use async/await for I/O. Return a value to see results.`, zod_1.z.object({
        code: zod_1.z.string().describe('JavaScript code to execute'),
    }).shape, async ({ code }) => {
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
            btoa: (str) => Buffer.from(str, 'utf-8').toString('base64'),
            atob: (str) => Buffer.from(str, 'base64').toString('utf-8'),
            // Safe timer wrappers with limits
            setTimeout: (fn, ms, ...args) => {
                const maxMs = 30000; // Max 30 seconds
                return setTimeout(fn, Math.min(ms !== null && ms !== void 0 ? ms : 0, maxMs), ...args);
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
            __result: undefined,
            __error: undefined,
            __done: false,
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
            script.runInContext(context, { timeout: 30000 });
            // Wait for async completion with proper timeout
            const ASYNC_TIMEOUT = 30000; // 30 seconds for async operations
            let asyncTimeoutId = null;
            const timeoutPromise = new Promise((resolve) => {
                asyncTimeoutId = setTimeout(() => resolve('timeout'), ASYNC_TIMEOUT);
            });
            const completionPromise = new Promise((resolve) => {
                const check = () => {
                    if (sandbox.__done || sandbox.__error !== undefined) {
                        resolve('done');
                    }
                    else {
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
                sandbox.__error = 'Execution timed out after 30 seconds';
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
                    content: [{ type: 'text', text: `${logOutput}Error: ${sandbox.__error}${panelUpdateOutput}` }],
                };
            }
            return {
                content: [{
                        type: 'text',
                        text: (sandbox.__result !== undefined
                            ? `${logOutput}Done. Result: ${JSON.stringify(sandbox.__result, null, 2)}`
                            : `${logOutput}Done (no return value)`) + panelUpdateOutput,
                    }],
            };
        }
        catch (error) {
            const logs = toolFunctions.__logs;
            const logOutput = logs.length > 0 ? `Logs:\n${logs.join('\n')}\n\n` : '';
            const panelUpdateOutput = shouldEmbedPanelUpdates && panelUpdates.length > 0
                ? `\n__PANEL_UPDATES_START__${JSON.stringify(panelUpdates)}__PANEL_UPDATES_END__`
                : '';
            return {
                content: [{
                        type: 'text',
                        text: `${logOutput}Execution error: ${error instanceof Error ? error.message : String(error)}${panelUpdateOutput}`,
                    }],
            };
        }
    });
};
exports.createExecuteTool = createExecuteTool;
