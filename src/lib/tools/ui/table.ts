import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ToolContext } from '../types';
import { TableColumn, UIPanel } from '../../storage';
import { emitPanelUpdate, refreshWorkspaceResources, resolvePanelLayout } from './shared';

export const createTableTool = (ctx: ToolContext) =>
  tool(
    'ui_table',
    'Create or update a table in the workspace UI.',
    z.object({
      id: z.string().describe('Table ID'),
      title: z.string().describe('Display title'),
      columns: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            type: z.enum(['text', 'number', 'date', 'url', 'status']).default('text'),
          })
        )
        .optional()
        .describe('Column definitions (required for new tables)'),
      data: z.array(z.any()).optional().describe('Table data'),
      layout: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Optional tile layout'),
    }).shape,
    async ({ id, title, columns, data, layout }) => {
      let table = await ctx.storage.getTable(ctx.workspaceId, id);

      if (!table && !columns) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Columns are required when creating a new table',
            },
          ],
        };
      }

      if (!table) {
        table = {
          id,
          title,
          columns: columns as TableColumn[],
          data: data || [],
        };
      } else {
        table.title = title;
        if (columns) table.columns = columns as TableColumn[];
        if (data) table.data = data;
      }

      await ctx.storage.setTable(ctx.workspaceId, id, table);
      const uiState = await ctx.storage.getUIState(ctx.workspaceId);
      const existingPanel = uiState.panels.find(p => p.type === 'table' && p.tableId === id);
      const defaultSize = { width: 600, height: 400 };

      if (!existingPanel) {
        const panel: UIPanel = {
          id: `table-${id}`,
          type: 'table',
          tableId: id,
          title,
          layout: layout ? { ...defaultSize, ...layout } : undefined,
        };
        await ctx.storage.addPanel(ctx.workspaceId, panel);
        emitPanelUpdate(ctx, {
          action: 'add',
          panel,
          data: { table },
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
          data: { table },
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Table "${title}" updated with ${table.data.length} rows`,
          },
        ],
      };
    }
  );
