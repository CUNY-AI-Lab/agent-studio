import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import type { UIPanel } from '../../storage';
import {
  emitPanelUpdate,
  getFileTilePanelType,
  makeFileTilePanelId,
  refreshWorkspaceResources,
  resolvePanelLayout,
} from './shared';

export const createShowFileTool = (ctx: ToolContext) =>
  tool(
    'ui_show_file',
    'Show an existing workspace file on the canvas as a tile.',
    z.object({
      filePath: z.string().describe('Workspace-relative file path'),
      title: z.string().optional().describe('Optional tile title'),
      panelId: z.string().optional().describe('Optional tile ID'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ filePath, title, panelId, layout }) => {
      const fileBuffer = await ctx.storage.readFileBuffer(ctx.workspaceId, filePath);
      if (!fileBuffer) {
        throw new Error(`File not found: ${filePath}`);
      }

      const type = getFileTilePanelType(filePath);
      const id = panelId || makeFileTilePanelId(filePath);
      const resolvedTitle = title || filePath.split('/').pop() || filePath;
      const defaultSize = type === 'pdf'
        ? { width: 600, height: 800 }
        : { width: 520, height: 420 };

      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find((panel) => panel.id === id || panel.filePath === filePath);

      if (!existingPanel) {
        const panel: UIPanel = {
          id,
          type,
          title: resolvedTitle,
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
          id: existingPanel.id,
          type,
          title: resolvedTitle,
          filePath,
          layout: updatedLayout,
        };

        await ctx.storage.updatePanel(ctx.workspaceId, existingPanel.id, {
          type,
          title: resolvedTitle,
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
            text: `Showing ${filePath} on the canvas`,
          },
        ],
      };
    }
  );
