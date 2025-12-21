import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ToolContext } from '../types';
import { TableColumn } from '../../storage';

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
    }).shape,
    async ({ id, title, columns, data }) => {
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
      const tablePanels = uiState.panels.filter(p => p.type === 'table' && p.tableId === id);
      if (tablePanels.length > 0) {
        ctx.emitPanelUpdates?.(tablePanels.map(panel => ({
          action: 'update',
          panel,
          data: { table },
        })));
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
