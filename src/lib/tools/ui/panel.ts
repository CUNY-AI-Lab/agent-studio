import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../index';

const panelTypeSchema = z.enum([
  'chat',
  'table',
  'editor',
  'preview',
  'fileTree',
  'detail',
  'chart',
  'cards',
  'markdown',
  'pdf',
]);

export const createAddPanelTool = (ctx: ToolContext) =>
  tool(
    'ui_add_panel',
    'Add a new panel to the workspace UI. Panels can be tables, charts, cards, editors, previews, file trees, detail views, markdown, or PDFs.',
    z.object({
      id: z.string().describe('Unique ID for this panel'),
      type: panelTypeSchema.describe('Panel type'),
      title: z.string().optional().describe('Display title for the panel'),
      tableId: z.string().optional().describe('For table panels: which table to display'),
      filePath: z.string().optional().describe('For editor/preview panels: file path'),
      linkedTo: z.string().optional().describe('For detail panels: ID of table panel to link to'),
      content: z.string().optional().describe('For preview panels: inline HTML/content'),
    }).shape,
    async ({ id, type, title, tableId, filePath, linkedTo, content }) => {
      const panel = {
        id,
        type,
        title,
        tableId,
        filePath,
        linkedTo,
        content,
      };
      await ctx.storage.addPanel(ctx.workspaceId, panel);
      ctx.emitPanelUpdates?.([{ action: 'add', panel }]);

      return {
        content: [{ type: 'text' as const, text: `Added ${type} panel "${id}" to workspace UI` }],
      };
    }
  );

export const createRemovePanelTool = (ctx: ToolContext) =>
  tool(
    'ui_remove_panel',
    'Remove a panel from the workspace UI',
    z.object({
      id: z.string().describe('ID of the panel to remove'),
    }).shape,
    async ({ id }) => {
      const ui = await ctx.storage.getUIState(ctx.workspaceId);
      const panel = ui.panels.find(p => p.id === id);
      await ctx.storage.removePanel(ctx.workspaceId, id);
      if (panel) {
        ctx.emitPanelUpdates?.([{ action: 'remove', panel }]);
      }

      return {
        content: [{ type: 'text' as const, text: `Removed panel "${id}" from workspace UI` }],
      };
    }
  );

export const createUpdatePanelTool = (ctx: ToolContext) =>
  tool(
    'ui_update_panel',
    'Update an existing panel in the workspace UI',
    z.object({
      id: z.string().describe('ID of the panel to update'),
      title: z.string().optional().describe('New title'),
      tableId: z.string().optional().describe('New table ID'),
      filePath: z.string().optional().describe('New file path'),
      content: z.string().optional().describe('New content'),
    }).shape,
    async ({ id, ...updates }) => {
      // Filter out undefined values
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );

      const ui = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = ui.panels.find(p => p.id === id);
      await ctx.storage.updatePanel(ctx.workspaceId, id, cleanUpdates);
      if (existingPanel) {
        const updatedPanel = { ...existingPanel, ...cleanUpdates };
        ctx.emitPanelUpdates?.([{ action: 'update', panel: updatedPanel }]);
      }

      return {
        content: [{ type: 'text' as const, text: `Updated panel "${id}"` }],
      };
    }
  );

export const createSetLayoutTool = (ctx: ToolContext) =>
  tool(
    'ui_set_layout',
    'Set the viewport zoom level for the canvas (deprecated - canvas zoom is handled by user interaction)',
    z.object({
      zoom: z.number().min(0.5).max(2.4).optional().describe('Zoom level (0.5-2.4, default 1)'),
    }).shape,
    async ({ zoom = 1 }) => {
      await ctx.storage.updateUIState(ctx.workspaceId, (state) => {
        state.viewport = { x: state.viewport?.x ?? 0, y: state.viewport?.y ?? 0, zoom };
        return state;
      });

      return {
        content: [{ type: 'text' as const, text: `Set canvas zoom to ${zoom * 100}%` }],
      };
    }
  );
