import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const pickTool = tool(
  'pick',
  'Select specific fields from each item in an array.',
  z.object({
    data: z.array(z.any()).describe('Array of items'),
    fields: z.array(z.string()).describe('Field names to keep'),
  }).shape,
  async ({ data, fields }) => {
    const picked = data.map((item) => {
      const result: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in item) {
          result[field] = item[field];
        }
      }
      return result;
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(picked, null, 2) }],
    };
  }
);
