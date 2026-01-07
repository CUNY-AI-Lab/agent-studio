"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTableTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
const createTableTool = (ctx) => (0, claude_agent_sdk_1.tool)('ui_table', 'Create or update a table in the workspace UI.', zod_1.z.object({
    id: zod_1.z.string().describe('Table ID'),
    title: zod_1.z.string().describe('Display title'),
    columns: zod_1.z
        .array(zod_1.z.object({
        key: zod_1.z.string(),
        label: zod_1.z.string(),
        type: zod_1.z.enum(['text', 'number', 'date', 'url', 'status']).default('text'),
    }))
        .optional()
        .describe('Column definitions (required for new tables)'),
    data: zod_1.z.array(zod_1.z.any()).optional().describe('Table data'),
}).shape, async ({ id, title, columns, data }) => {
    var _a;
    let table = await ctx.storage.getTable(ctx.workspaceId, id);
    if (!table && !columns) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Columns are required when creating a new table',
                },
            ],
        };
    }
    if (!table) {
        table = {
            id,
            title,
            columns: columns,
            data: data || [],
        };
    }
    else {
        table.title = title;
        if (columns)
            table.columns = columns;
        if (data)
            table.data = data;
    }
    await ctx.storage.setTable(ctx.workspaceId, id, table);
    const uiState = await ctx.storage.getUIState(ctx.workspaceId);
    const tablePanels = uiState.panels.filter(p => p.type === 'table' && p.tableId === id);
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
                text: `Table "${title}" updated with ${table.data.length} rows`,
            },
        ],
    };
});
exports.createTableTool = createTableTool;
