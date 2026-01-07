import { ToolContext } from './types';
import { createReadTool, createWriteTool } from './io';
import { filterTool, pickTool, sortTool } from './transform';
import {
  createTableTool,
  messageTool,
  createAddPanelTool,
  createRemovePanelTool,
  createUpdatePanelTool,
  createSetLayoutTool,
} from './ui';
import { createExecuteTool } from './code';

export type { ToolContext } from './types';

// Tool registry - maps tool IDs to tool creators
export const toolRegistry = {
  // I/O tools (need context)
  read: (ctx: ToolContext) => createReadTool(ctx),
  write: (ctx: ToolContext) => createWriteTool(ctx),

  // Transform tools (pure, no context needed)
  filter: () => filterTool,
  pick: () => pickTool,
  sort: () => sortTool,

  // UI tools (need context)
  'ui.table': (ctx: ToolContext) => createTableTool(ctx),
  'ui.message': () => messageTool,
  'ui.addPanel': (ctx: ToolContext) => createAddPanelTool(ctx),
  'ui.removePanel': (ctx: ToolContext) => createRemovePanelTool(ctx),
  'ui.updatePanel': (ctx: ToolContext) => createUpdatePanelTool(ctx),
  'ui.setLayout': (ctx: ToolContext) => createSetLayoutTool(ctx),

  // Code execution (need context)
  execute: (ctx: ToolContext) => createExecuteTool(ctx),
} as const;

export type ToolId = keyof typeof toolRegistry;

// Get tools by IDs
export function getTools(toolIds: string[], ctx: ToolContext) {
  return toolIds
    .filter((id) => id in toolRegistry)
    .map((id) => {
      const creator = toolRegistry[id as ToolId];
      return creator(ctx);
    });
}

// List all available tools
export function listTools(): { id: string; description: string }[] {
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
