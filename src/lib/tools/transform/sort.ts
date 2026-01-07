import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const sortTool = tool(
  'sort',
  'Sort an array of items by a field.',
  z.object({
    data: z.array(z.any()).describe('Array of items to sort'),
    by: z.string().describe('Field name to sort by'),
    order: z.enum(['asc', 'desc']).default('asc').describe('Sort order'),
  }).shape,
  async ({ data, by, order }) => {
    const sorted = [...data].sort((a, b) => {
      const aVal = a[by];
      const bVal = b[by];

      // Try numeric comparison first
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return order === 'asc' ? aNum - bNum : bNum - aNum;
      }

      // Fall back to string comparison
      const aStr = String(aVal);
      const bStr = String(bVal);
      return order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(sorted, null, 2) }],
    };
  }
);
