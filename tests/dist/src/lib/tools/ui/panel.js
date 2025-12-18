"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSetLayoutTool = exports.createUpdatePanelTool = exports.createRemovePanelTool = exports.createAddPanelTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
const panelTypeSchema = zod_1.z.enum(['table', 'editor', 'preview', 'fileTree', 'detail']);
const createAddPanelTool = (ctx) => (0, claude_agent_sdk_1.tool)('ui_add_panel', 'Add a new panel to the workspace UI. Panels can be tables, editors, previews, file trees, or detail views.', zod_1.z.object({
    id: zod_1.z.string().describe('Unique ID for this panel'),
    type: panelTypeSchema.describe('Panel type'),
    title: zod_1.z.string().optional().describe('Display title for the panel'),
    tableId: zod_1.z.string().optional().describe('For table panels: which table to display'),
    filePath: zod_1.z.string().optional().describe('For editor/preview panels: file path'),
    linkedTo: zod_1.z.string().optional().describe('For detail panels: ID of table panel to link to'),
    content: zod_1.z.string().optional().describe('For preview panels: inline HTML/content'),
}).shape, async ({ id, type, title, tableId, filePath, linkedTo, content }) => {
    await ctx.storage.addPanel(ctx.workspaceId, {
        id,
        type,
        title,
        tableId,
        filePath,
        linkedTo,
        content,
    });
    return {
        content: [{ type: 'text', text: `Added ${type} panel "${id}" to workspace UI` }],
    };
});
exports.createAddPanelTool = createAddPanelTool;
const createRemovePanelTool = (ctx) => (0, claude_agent_sdk_1.tool)('ui_remove_panel', 'Remove a panel from the workspace UI', zod_1.z.object({
    id: zod_1.z.string().describe('ID of the panel to remove'),
}).shape, async ({ id }) => {
    await ctx.storage.removePanel(ctx.workspaceId, id);
    return {
        content: [{ type: 'text', text: `Removed panel "${id}" from workspace UI` }],
    };
});
exports.createRemovePanelTool = createRemovePanelTool;
const createUpdatePanelTool = (ctx) => (0, claude_agent_sdk_1.tool)('ui_update_panel', 'Update an existing panel in the workspace UI', zod_1.z.object({
    id: zod_1.z.string().describe('ID of the panel to update'),
    title: zod_1.z.string().optional().describe('New title'),
    tableId: zod_1.z.string().optional().describe('New table ID'),
    filePath: zod_1.z.string().optional().describe('New file path'),
    content: zod_1.z.string().optional().describe('New content'),
}).shape, async ({ id, ...updates }) => {
    // Filter out undefined values
    const cleanUpdates = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    await ctx.storage.updatePanel(ctx.workspaceId, id, cleanUpdates);
    return {
        content: [{ type: 'text', text: `Updated panel "${id}"` }],
    };
});
exports.createUpdatePanelTool = createUpdatePanelTool;
const createSetLayoutTool = (ctx) => (0, claude_agent_sdk_1.tool)('ui_set_layout', 'Set the viewport zoom level for the canvas (deprecated - canvas zoom is handled by user interaction)', zod_1.z.object({
    zoom: zod_1.z.number().min(0.5).max(2.4).optional().describe('Zoom level (0.5-2.4, default 1)'),
}).shape, async ({ zoom = 1 }) => {
    var _a, _b, _c, _d;
    const state = await ctx.storage.getUIState(ctx.workspaceId);
    state.viewport = { x: (_b = (_a = state.viewport) === null || _a === void 0 ? void 0 : _a.x) !== null && _b !== void 0 ? _b : 0, y: (_d = (_c = state.viewport) === null || _c === void 0 ? void 0 : _c.y) !== null && _d !== void 0 ? _d : 0, zoom };
    await ctx.storage.setUIState(ctx.workspaceId, state);
    return {
        content: [{ type: 'text', text: `Set canvas zoom to ${zoom * 100}%` }],
    };
});
exports.createSetLayoutTool = createSetLayoutTool;
