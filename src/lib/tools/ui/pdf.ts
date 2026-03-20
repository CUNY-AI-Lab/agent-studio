import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import type { UIPanel } from '../../storage';
import { emitPanelUpdate, refreshWorkspaceResources, resolvePanelLayout } from './shared';

export const createPdfTool = (ctx: ToolContext) =>
  tool(
    'ui_pdf',
    'Show an existing PDF workspace file as a tile in the workspace UI.',
    z.object({
      id: z.string().describe('Tile ID'),
      title: z.string().describe('Display title'),
      filePath: z.string().describe('Workspace-relative PDF path'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ id, title, filePath, layout }) => {
      const fileBuffer = await ctx.storage.readFileBuffer(ctx.workspaceId, filePath);
      if (!fileBuffer) {
        throw new Error(`File not found: ${filePath}`);
      }

      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find((panel) => panel.id === id);
      const defaultSize = { width: 600, height: 800 };

      if (!existingPanel) {
        const panel: UIPanel = {
          id,
          type: 'pdf',
          title,
          filePath,
          layout: layout ? { ...defaultSize, ...layout } : undefined,
        };
        await ctx.storage.addPanel(ctx.workspaceId, panel);
        emitPanelUpdate(ctx, { action: 'add', panel });
        await refreshWorkspaceResources(ctx);
      } else {
        const updatedLayout = resolvePanelLayout(existingPanel, layout, defaultSize);
        const updatedPanel: UIPanel = {
          ...existingPanel,
          type: 'pdf',
          title,
          filePath,
          layout: updatedLayout,
        };

        await ctx.storage.updatePanel(ctx.workspaceId, id, {
          type: 'pdf',
          title,
          filePath,
          ...(updatedLayout ? { layout: updatedLayout } : {}),
        });
        emitPanelUpdate(ctx, { action: 'update', panel: updatedPanel });
        await refreshWorkspaceResources(ctx);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `PDF tile "${title}" is showing ${filePath}`,
          },
        ],
      };
    }
  );
