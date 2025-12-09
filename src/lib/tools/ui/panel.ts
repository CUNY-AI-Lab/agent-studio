import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../index';

const panelTypeSchema = z.enum(['table', 'editor', 'preview', 'fileTree', 'detail']);

export const createAddPanelTool = (ctx: ToolContext) =>
  tool(
    'ui_add_panel',
    'Add a new panel to the workspace UI. Panels can be tables, editors, previews, file trees, or detail views.',
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
      await ctx.storage.removePanel(ctx.workspaceId, id);

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

      await ctx.storage.updatePanel(ctx.workspaceId, id, cleanUpdates);

      return {
        content: [{ type: 'text' as const, text: `Updated panel "${id}"` }],
      };
    }
  );

export const createSetLayoutTool = (ctx: ToolContext) =>
  tool(
    'ui_set_layout',
    'Set the layout direction for workspace panels',
    z.object({
      layout: z.enum(['horizontal', 'vertical', 'grid']).describe('Layout direction'),
    }).shape,
    async ({ layout }) => {
      const state = await ctx.storage.getUIState(ctx.workspaceId);
      state.layout = layout;
      await ctx.storage.setUIState(ctx.workspaceId, state);

      return {
        content: [{ type: 'text' as const, text: `Set workspace layout to ${layout}` }],
      };
    }
  );
