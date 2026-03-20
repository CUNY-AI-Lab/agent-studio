import { ToolContext } from './types';
import {
  createCardsTool,
  createChartTool,
  createMarkdownTool,
  createPdfTool,
  createShowFileTool,
  createTableTool,
  createWorkspaceInfoTool,
  createAddPanelTool,
  createRemovePanelTool,
  createUpdatePanelTool,
} from './ui';

export type { ToolContext } from './types';

// Tool registry - maps tool IDs to tool creators
export const toolRegistry = {
  // UI tools (need context)
  'ui.table': (ctx: ToolContext) => createTableTool(ctx),
  'ui.chart': (ctx: ToolContext) => createChartTool(ctx),
  'ui.cards': (ctx: ToolContext) => createCardsTool(ctx),
  'ui.markdown': (ctx: ToolContext) => createMarkdownTool(ctx),
  'ui.pdf': (ctx: ToolContext) => createPdfTool(ctx),
  'ui.showFile': (ctx: ToolContext) => createShowFileTool(ctx),
  'ui.workspace': (ctx: ToolContext) => createWorkspaceInfoTool(ctx),
  'ui.addPanel': (ctx: ToolContext) => createAddPanelTool(ctx),
  'ui.removePanel': (ctx: ToolContext) => createRemovePanelTool(ctx),
  'ui.updatePanel': (ctx: ToolContext) => createUpdatePanelTool(ctx),
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
    { id: 'ui.table', description: 'Create or update a table tile' },
    { id: 'ui.chart', description: 'Create or update a chart tile' },
    { id: 'ui.cards', description: 'Create or update a cards tile' },
    { id: 'ui.markdown', description: 'Create or update a markdown tile' },
    { id: 'ui.pdf', description: 'Show a PDF file as a tile' },
    { id: 'ui.showFile', description: 'Show a workspace file on the canvas' },
    { id: 'ui.workspace', description: 'Update workspace title or description' },
    { id: 'ui.addPanel', description: 'Add a low-level tile to the canvas' },
    { id: 'ui.removePanel', description: 'Remove a tile from the canvas' },
    { id: 'ui.updatePanel', description: 'Update a tile on the canvas' },
  ];
}
