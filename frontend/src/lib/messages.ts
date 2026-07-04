import {
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai';

export interface ContextualThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextualChatTarget {
  key: string;
  panelIds: string[];
  title: string;
  typeLabel: string;
}

export function extractMessageText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .map((part) => {
      if (isTextUIPart(part)) return part.text;
      if (isToolUIPart(part)) return `[tool:${getToolName(part)}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function getContextualStatusLabel(status: string, assistantMessage: UIMessage | null): string | null {
  if (status === 'ready') return null;
  if (status === 'submitted') return 'Thinking...';
  if (status === 'error') return null;

  if (assistantMessage && Array.isArray(assistantMessage.parts)) {
    const hasRunningTool = assistantMessage.parts.some((part) =>
      isToolUIPart(part) &&
      part.state !== 'output-available' &&
      part.state !== 'output-error' &&
      part.state !== 'output-denied'
    );
    if (hasRunningTool) return 'Running tools...';
    if (extractMessageText(assistantMessage).trim()) return 'Responding...';
  }

  return 'Thinking...';
}
