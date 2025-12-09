import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const filterTool = tool(
  'filter',
  'Filter an array of items by a condition. Returns items where the condition is true.',
  z.object({
    data: z.array(z.any()).describe('Array of items to filter'),
    where: z.string().describe('Condition: "field == value", "field > n", "field contains text"'),
  }).shape,
  async ({ data, where }) => {
    // Parse condition
    const containsMatch = where.match(/(\w+)\s+contains\s+['"]?(.+?)['"]?$/i);
    if (containsMatch) {
      const [, field, value] = containsMatch;
      const filtered = data.filter((item) =>
        String(item[field]).toLowerCase().includes(value.toLowerCase())
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
      };
    }

    const opMatch = where.match(/(\w+)\s*(==|!=|>|<|>=|<=)\s*['"]?(.+?)['"]?$/);
    if (opMatch) {
      const [, field, op, value] = opMatch;
      const filtered = data.filter((item) => {
        const itemValue = item[field];
        const numValue = Number(value);
        const numItemValue = Number(itemValue);

        switch (op) {
          case '==':
            return String(itemValue) === value;
          case '!=':
            return String(itemValue) !== value;
          case '>':
            return numItemValue > numValue;
          case '<':
            return numItemValue < numValue;
          case '>=':
            return numItemValue >= numValue;
          case '<=':
            return numItemValue <= numValue;
          default:
            return true;
        }
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: 'Could not parse filter condition' }],
    };
  }
);
