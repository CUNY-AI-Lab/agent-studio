import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import type { CardsData, UIPanel } from '../../storage';
import { emitPanelUpdate, refreshWorkspaceResources, resolvePanelLayout } from './shared';

const cardsItemSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  badge: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const createCardsTool = (ctx: ToolContext) =>
  tool(
    'ui_cards',
    'Create or update a cards tile in the workspace UI.',
    z.object({
      id: z.string().describe('Cards dataset ID'),
      title: z.string().describe('Display title'),
      items: z.array(cardsItemSchema).describe('Cards to display'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ id, title, items, layout }) => {
      const cards: CardsData = {
        id,
        title,
        items: items.map((item, index) => ({ id: String(index), ...item })),
      };

      await ctx.storage.setCards(ctx.workspaceId, id, cards);
      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find((panel) => panel.type === 'cards' && panel.cardsId === id);
      const defaultSize = { width: 500, height: 400 };

      if (!existingPanel) {
        const panel: UIPanel = {
          id: `cards-${id}`,
          type: 'cards',
          cardsId: id,
          title,
          layout: layout ? { ...defaultSize, ...layout } : undefined,
        };
        await ctx.storage.addPanel(ctx.workspaceId, panel);
        emitPanelUpdate(ctx, {
          action: 'add',
          panel,
          data: { cards },
        });
        await refreshWorkspaceResources(ctx);
      } else {
        const updatedLayout = resolvePanelLayout(existingPanel, layout, defaultSize);
        const updatedPanel: UIPanel = {
          ...existingPanel,
          title,
          layout: updatedLayout,
        };

        await ctx.storage.updatePanel(ctx.workspaceId, existingPanel.id, {
          title,
          ...(updatedLayout ? { layout: updatedLayout } : {}),
        });
        emitPanelUpdate(ctx, {
          action: 'update',
          panel: updatedPanel,
          data: { cards },
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Cards "${title}" updated with ${cards.items.length} items`,
          },
        ],
      };
    }
  );
