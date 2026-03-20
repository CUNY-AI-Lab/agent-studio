import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import { refreshWorkspaceResources } from './shared';

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
    'Add a new tile to the canvas. Tiles can be tables, charts, cards, editors, previews, file trees, detail views, markdown, or PDFs.',
    z.object({
      id: z.string().describe('Unique ID for this tile'),
      type: panelTypeSchema.describe('Tile type'),
      title: z.string().optional().describe('Display title for the tile'),
      tableId: z.string().optional().describe('For table tiles: which table to display'),
      filePath: z.string().optional().describe('For editor/preview tiles: file path'),
      linkedTo: z.string().optional().describe('For detail tiles: ID of related table tile'),
      content: z.string().optional().describe('For preview tiles: inline HTML/content'),
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
      await refreshWorkspaceResources(ctx);

      return {
        content: [{ type: 'text' as const, text: `Added ${type} tile "${id}" to the canvas` }],
      };
    }
  );

export const createRemovePanelTool = (ctx: ToolContext) =>
  tool(
    'ui_remove_panel',
    'Remove a tile from the canvas',
    z.object({
      id: z.string().describe('ID of the tile to remove'),
    }).shape,
    async ({ id }) => {
      const ui = await ctx.storage.getUIState(ctx.workspaceId);
      const panel = ui.panels.find(p => p.id === id);
      await ctx.storage.removePanel(ctx.workspaceId, id);
      if (panel) {
        ctx.emitPanelUpdates?.([{ action: 'remove', panel }]);
      }
      await refreshWorkspaceResources(ctx);

      return {
        content: [{ type: 'text' as const, text: `Removed tile "${id}" from the canvas` }],
      };
    }
  );

export const createUpdatePanelTool = (ctx: ToolContext) =>
  tool(
    'ui_update_panel',
    'Update an existing tile on the canvas',
    z.object({
      id: z.string().describe('ID of the tile to update'),
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
        content: [{ type: 'text' as const, text: `Updated tile "${id}"` }],
      };
    }
  );
