import { isTextUIPart, type UIMessage } from 'ai';
import { currentToolActivity } from './toolActivity';

export type ChatActivityState =
  | {
    phase: 'ready';
    label: 'Ready';
    tone: 'ready';
    canSubmit: true;
    canStop: false;
    canRetry: boolean;
  }
  | {
    phase: 'working';
    label: 'Working…';
    detail: string;
    tone: 'working';
    canSubmit: false;
    canStop: true;
    canRetry: false;
  }
  | {
    phase: 'error';
    label: 'Something went wrong';
    tone: 'error';
    canSubmit: true;
    canStop: false;
    canRetry: boolean;
  }
  | {
    phase: 'error';
    label: 'Connection lost';
    tone: 'error';
    canSubmit: false;
    canStop: false;
    canRetry: false;
  };

export interface ChatActivityInput {
  status: string;
  isStreaming: boolean;
  isServerStreaming: boolean;
  isRecovering: boolean;
  isToolContinuation: boolean;
  contextualTurnActive: boolean;
  connectionError: Error | null;
  canRetry: boolean;
  messages?: UIMessage[];
}

/** Derive every main-composer control from the same protocol state. */
export function getChatActivity({
  status,
  isStreaming,
  isServerStreaming,
  isRecovering,
  isToolContinuation,
  contextualTurnActive,
  connectionError,
  canRetry,
  messages = [],
}: ChatActivityInput): ChatActivityState {
  if (connectionError) {
    return {
      phase: 'error',
      label: 'Connection lost',
      tone: 'error',
      canSubmit: false,
      canStop: false,
      canRetry: false,
    };
  }

  const isBusy =
    contextualTurnActive ||
    status === 'submitted' ||
    status === 'streaming' ||
    isStreaming ||
    isServerStreaming ||
    isRecovering ||
    isToolContinuation;

  // A terminal status can arrive before the server's continuation and
  // recovery flags settle. Keep the composer busy until every maintained
  // activity signal is idle; exposing an error here would allow a second send
  // while the existing turn is still running.
  if (isBusy) {
    return {
      phase: 'working',
      label: 'Working…',
      detail: getWorkingDetail(messages, isRecovering, isToolContinuation),
      tone: 'working',
      canSubmit: false,
      canStop: true,
      canRetry: false,
    };
  }

  if (status === 'error') {
    return {
      phase: 'error',
      label: 'Something went wrong',
      tone: 'error',
      canSubmit: true,
      canStop: false,
      canRetry,
    };
  }

  return {
    phase: 'ready',
    label: 'Ready',
    tone: 'ready',
    canSubmit: true,
    canStop: false,
    canRetry,
  };
}

function getWorkingDetail(messages: UIMessage[], recovering: boolean, continuing: boolean): string {
  if (recovering) return 'Recovering the response…';
  const latest = messages[messages.length - 1];
  // A previous turn must not lend its tool or text state to a new request.
  const parts = latest?.role === 'assistant' ? latest.parts : [];
  const toolActivity = currentToolActivity(latest);
  if (toolActivity) return toolActivity;
  if (continuing) return 'Continuing after tools…';
  if (parts.some((part) => isTextUIPart(part) && part.text.trim())) return 'Writing the response…';
  return 'Thinking…';
}
