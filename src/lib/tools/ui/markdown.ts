import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import type { UIPanel } from '../../storage';
import { emitPanelUpdate, refreshWorkspaceResources, resolvePanelLayout } from './shared';

export const createMarkdownTool = (ctx: ToolContext) =>
  tool(
    'ui_markdown',
    'Create or update a markdown tile in the workspace UI.',
    z.object({
      id: z.string().describe('Tile ID'),
      title: z.string().describe('Display title'),
      content: z.string().describe('Markdown content'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ id, title, content, layout }) => {
      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find((panel) => panel.id === id);
      const defaultSize = { width: 400, height: 300 };

      if (!existingPanel) {
        const panel: UIPanel = {
          id,
          type: 'markdown',
          title,
          content,
          layout: layout ? { ...defaultSize, ...layout } : undefined,
        };
        await ctx.storage.addPanel(ctx.workspaceId, panel);
        emitPanelUpdate(ctx, {
          action: 'add',
          panel,
          data: { content },
        });
        await refreshWorkspaceResources(ctx);
      } else {
        const updatedLayout = resolvePanelLayout(existingPanel, layout, defaultSize);
        const updatedPanel: UIPanel = {
          ...existingPanel,
          type: 'markdown',
          title,
          content,
          layout: updatedLayout,
        };

        await ctx.storage.updatePanel(ctx.workspaceId, id, {
          type: 'markdown',
          title,
          content,
          ...(updatedLayout ? { layout: updatedLayout } : {}),
        });
        emitPanelUpdate(ctx, {
          action: 'update',
          panel: updatedPanel,
          data: { content },
        });
        await refreshWorkspaceResources(ctx);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Markdown tile "${title}" updated`,
          },
        ],
      };
    }
  );
