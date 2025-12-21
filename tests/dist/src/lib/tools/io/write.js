"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWriteTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
const createWriteTool = (ctx) => (0, claude_agent_sdk_1.tool)('write', 'Write data to a destination. Destinations can be: "table:name" for tables, "file:path" for files.', zod_1.z.object({
    data: zod_1.z.any().describe('Data to write (array for tables, string for files)'),
    to: zod_1.z.string().describe('Destination: "table:name" or "file:path"'),
    mode: zod_1.z.enum(['replace', 'append']).default('replace').describe('Write mode'),
    title: zod_1.z.string().optional().describe('Title for new tables'),
    columns: zod_1.z
        .array(zod_1.z.object({
        key: zod_1.z.string(),
        label: zod_1.z.string(),
        type: zod_1.z.enum(['text', 'number', 'date', 'url', 'status']).default('text'),
    }))
        .optional()
        .describe('Column definitions for new tables'),
}).shape, async ({ data, to, mode, title, columns }) => {
    var _a;
    const [type, name] = to.split(':');
    if (type === 'table') {
        let table = await ctx.storage.getTable(ctx.workspaceId, name);
        if (!table) {
            // Infer columns from data if not provided
            const inferredColumns = columns ||
                (Array.isArray(data) && data.length > 0
                    ? Object.keys(data[0]).map((key) => ({
                        key,
                        label: key.charAt(0).toUpperCase() + key.slice(1),
                        type: 'text',
                    }))
                    : []);
            table = {
                id: name,
                title: title || name,
                columns: inferredColumns,
                data: [],
            };
        }
        if (mode === 'replace') {
            table.data = Array.isArray(data) ? data : [data];
        }
        else {
            const newData = Array.isArray(data) ? data : [data];
            table.data = [...table.data, ...newData];
        }
        await ctx.storage.setTable(ctx.workspaceId, name, table);
        const uiState = await ctx.storage.getUIState(ctx.workspaceId);
        const tablePanels = uiState.panels.filter(p => p.type === 'table' && p.tableId === name);
        if (tablePanels.length > 0) {
            (_a = ctx.emitPanelUpdates) === null || _a === void 0 ? void 0 : _a.call(ctx, tablePanels.map(panel => ({
                action: 'update',
                panel,
                data: { table },
            })));
        }
        return {
            content: [
                {
                    type: 'text',
                    text: `Wrote ${Array.isArray(data) ? data.length : 1} items to table "${name}"`,
                },
            ],
        };
    }
    if (type === 'file') {
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        if (mode === 'append') {
            const existing = (await ctx.storage.readFile(ctx.workspaceId, name)) || '';
            await ctx.storage.writeFile(ctx.workspaceId, name, existing + content);
        }
        else {
            await ctx.storage.writeFile(ctx.workspaceId, name, content);
        }
        return {
            content: [{ type: 'text', text: `Wrote to file "${name}"` }],
        };
    }
    return {
        content: [{ type: 'text', text: `Unknown destination type: ${type}` }],
    };
});
exports.createWriteTool = createWriteTool;
