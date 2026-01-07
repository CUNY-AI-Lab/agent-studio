import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const messageTool = tool(
  'ui_message',
  'Display a message to the user.',
  z.object({
    text: z.string().describe('Message text to display'),
    type: z.enum(['info', 'success', 'warning', 'error']).default('info'),
  }).shape,
  async ({ text, type }) => {
    // In a real implementation, this would emit an event to the UI
    // For now, we just return the message
    return {
      content: [
        {
          type: 'text' as const,
          text: `[${type.toUpperCase()}] ${text}`,
        },
      ],
    };
  }
);
