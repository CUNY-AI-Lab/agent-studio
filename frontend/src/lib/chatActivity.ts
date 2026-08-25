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
  };

export interface ChatActivityInput {
  status: string;
  isStreaming: boolean;
  isServerStreaming: boolean;
  isRecovering: boolean;
  isToolContinuation: boolean;
  contextualTurnActive: boolean;
  canRetry: boolean;
}

/** Derive every main-composer control from the same protocol state. */
export function getChatActivity({
  status,
  isStreaming,
  isServerStreaming,
  isRecovering,
  isToolContinuation,
  contextualTurnActive,
  canRetry,
}: ChatActivityInput): ChatActivityState {
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
