import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolContext } from '../types';

export const createWorkspaceInfoTool = (ctx: ToolContext) =>
  tool(
    'ui_workspace',
    'Update the workspace title or description.',
    z.object({
      title: z.string().optional().describe('New workspace title'),
      description: z.string().optional().describe('New workspace description'),
    }).shape,
    async ({ title, description }) => {
      const workspace = await ctx.storage.getWorkspace(ctx.workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      await ctx.storage.setWorkspace(ctx.workspaceId, {
        ...workspace,
        ...(title ? { name: title } : {}),
        ...(description ? { description } : {}),
        updatedAt: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Workspace info updated',
          },
        ],
      };
    }
  );
