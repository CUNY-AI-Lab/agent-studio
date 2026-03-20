import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';
import type { ChartData, UIPanel } from '../../storage';
import { emitPanelUpdate, refreshWorkspaceResources, resolvePanelLayout } from './shared';

export const createChartTool = (ctx: ToolContext) =>
  tool(
    'ui_chart',
    'Create or update a chart tile in the workspace UI.',
    z.object({
      id: z.string().describe('Chart ID'),
      title: z.string().describe('Display title'),
      type: z.enum(['bar', 'line', 'pie', 'area']).describe('Chart type'),
      data: z.array(z.any()).describe('Chart data rows'),
      xKey: z.string().optional().describe('Field for the x-axis'),
      yKey: z.string().optional().describe('Field for the y-axis'),
      labelKey: z.string().optional().describe('Field for pie chart labels'),
      valueKey: z.string().optional().describe('Field for pie chart values'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ id, title, type, data, xKey, yKey, labelKey, valueKey, layout }) => {
      const chart: ChartData = {
        id,
        title,
        type,
        data: data as Record<string, unknown>[],
        config: {
          xKey,
          yKey,
          labelKey,
          valueKey,
        },
      };

      await ctx.storage.setChart(ctx.workspaceId, id, chart);
      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find((panel) => panel.type === 'chart' && panel.chartId === id);
      const defaultSize = { width: 500, height: 350 };

      if (!existingPanel) {
        const panel: UIPanel = {
          id: `chart-${id}`,
          type: 'chart',
          chartId: id,
          title,
          layout: layout ? { ...defaultSize, ...layout } : undefined,
        };
        await ctx.storage.addPanel(ctx.workspaceId, panel);
        emitPanelUpdate(ctx, {
          action: 'add',
          panel,
          data: { chart },
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
          data: { chart },
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Chart "${title}" updated with ${chart.data.length} rows`,
          },
        ],
      };
    }
  );
