"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolRegistry = void 0;
exports.getTools = getTools;
exports.listTools = listTools;
const io_1 = require("./io");
const transform_1 = require("./transform");
const ui_1 = require("./ui");
const code_1 = require("./code");
// Tool registry - maps tool IDs to tool creators
exports.toolRegistry = {
    // I/O tools (need context)
    read: (ctx) => (0, io_1.createReadTool)(ctx),
    write: (ctx) => (0, io_1.createWriteTool)(ctx),
    // Transform tools (pure, no context needed)
    filter: () => transform_1.filterTool,
    pick: () => transform_1.pickTool,
    sort: () => transform_1.sortTool,
    // UI tools (need context)
    'ui.table': (ctx) => (0, ui_1.createTableTool)(ctx),
    'ui.message': () => ui_1.messageTool,
    'ui.addPanel': (ctx) => (0, ui_1.createAddPanelTool)(ctx),
    'ui.removePanel': (ctx) => (0, ui_1.createRemovePanelTool)(ctx),
    'ui.updatePanel': (ctx) => (0, ui_1.createUpdatePanelTool)(ctx),
    'ui.setLayout': (ctx) => (0, ui_1.createSetLayoutTool)(ctx),
    // Code execution (need context)
    execute: (ctx) => (0, code_1.createExecuteTool)(ctx),
};
// Get tools by IDs
function getTools(toolIds, ctx) {
    return toolIds
        .filter((id) => id in exports.toolRegistry)
        .map((id) => {
        const creator = exports.toolRegistry[id];
        return creator(ctx);
    });
}
// List all available tools
function listTools() {
    return [
        { id: 'read', description: 'Read data from table or file' },
        { id: 'write', description: 'Write data to table or file' },
        { id: 'filter', description: 'Filter array by condition' },
        { id: 'pick', description: 'Select fields from items' },
        { id: 'sort', description: 'Sort array by field' },
        { id: 'ui.table', description: 'Create/update table in UI' },
        { id: 'ui.message', description: 'Display message to user' },
        { id: 'ui.addPanel', description: 'Add a panel to workspace UI' },
        { id: 'ui.removePanel', description: 'Remove a panel from workspace UI' },
        { id: 'ui.updatePanel', description: 'Update an existing panel' },
        { id: 'ui.setLayout', description: 'Set workspace layout direction' },
        { id: 'execute', description: 'Execute JavaScript code with tool functions' },
    ];
}
