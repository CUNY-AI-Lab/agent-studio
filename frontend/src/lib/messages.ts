import {
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

export interface ToolNotice {
  kind: 'error' | 'denied' | 'approval';
  message: string;
}

export function extractMessageText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .map((part) => {
      if (isTextUIPart(part)) return part.text;
      if (isToolUIPart(part)) return '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Keep exceptional tool outcomes visible without exposing tool internals. */
export function getToolNotices(message: UIMessage): ToolNotice[] {
  if (!Array.isArray(message.parts)) return [];

  const states = new Set(
    message.parts
      .filter(isToolUIPart)
      .map((part) => part.state)
  );
  const notices: ToolNotice[] = [];
  if (states.has('output-error')) {
    notices.push({ kind: 'error', message: "A tool couldn't complete this request. Try again." });
  }
  if (states.has('output-denied')) {
    notices.push({ kind: 'denied', message: "A tool wasn't allowed to run." });
  }
  if (states.has('approval-requested')) {
    notices.push({ kind: 'approval', message: 'Approval is needed before this can continue.' });
  }
  return notices;
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
