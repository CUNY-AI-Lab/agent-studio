import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ToolContext } from '../types';
import { TableColumn } from '../../storage';

export const createWriteTool = (ctx: ToolContext) =>
  tool(
    'write',
    'Write data to a destination. Destinations can be: "table:name" for tables, "file:path" for files.',
    z.object({
      data: z.any().describe('Data to write (array for tables, string for files)'),
      to: z.string().describe('Destination: "table:name" or "file:path"'),
      mode: z.enum(['replace', 'append']).default('replace').describe('Write mode'),
      title: z.string().optional().describe('Title for new tables'),
      columns: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            type: z.enum(['text', 'number', 'date', 'url', 'status']).default('text'),
          })
        )
        .optional()
        .describe('Column definitions for new tables'),
    }).shape,
    async ({ data, to, mode, title, columns }) => {
      const [type, name] = to.split(':');

      if (type === 'table') {
        let table = await ctx.storage.getTable(ctx.workspaceId, name);

        if (!table) {
          // Infer columns from data if not provided
          const inferredColumns: TableColumn[] =
            columns ||
            (Array.isArray(data) && data.length > 0
              ? Object.keys(data[0]).map((key) => ({
                  key,
                  label: key.charAt(0).toUpperCase() + key.slice(1),
                  type: 'text' as const,
                }))
              : []);

          table = {
            id: name,
            title: title || name,
            columns: inferredColumns,
            data: [],
          };
        }

        if (mode === 'replace') {
          table.data = Array.isArray(data) ? data : [data];
        } else {
          const newData = Array.isArray(data) ? data : [data];
          table.data = [...table.data, ...newData];
        }

        await ctx.storage.setTable(ctx.workspaceId, name, table);
        const uiState = await ctx.storage.getUIState(ctx.workspaceId);
        const tablePanels = uiState.panels.filter(p => p.type === 'table' && p.tableId === name);
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
              text: `Wrote ${Array.isArray(data) ? data.length : 1} items to table "${name}"`,
            },
          ],
        };
      }

      if (type === 'file') {
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

        if (mode === 'append') {
          const existing = (await ctx.storage.readFile(ctx.workspaceId, name)) || '';
          await ctx.storage.writeFile(ctx.workspaceId, name, existing + content);
        } else {
          await ctx.storage.writeFile(ctx.workspaceId, name, content);
        }

        return {
          content: [{ type: 'text' as const, text: `Wrote to file "${name}"` }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Unknown destination type: ${type}` }],
      };
    }
  );
