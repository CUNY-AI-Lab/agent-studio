import type { UIMessage } from 'ai';

export interface ContextualTurn {
  previousAssistantId: string | null;
  previousMessageIds: ReadonlySet<string>;
  userMessageId: string | null;
}

export interface ContextualTurnMessages {
  userMessageId: string | null;
  assistantMessage: UIMessage | null;
}

/**
 * Correlate the assistant projection to the user message created for this
 * scoped turn. Looking only at the last assistant message lets an unrelated
 * full-chat turn leak into the tile popover.
 */
export function getContextualTurnMessages(
  messages: UIMessage[],
  turn: ContextualTurn,
): ContextualTurnMessages {
  const userMessage = turn.userMessageId
    ? messages.find((message) => message.id === turn.userMessageId && message.role === 'user')
    : messages.find((message) => message.role === 'user' && !turn.previousMessageIds.has(message.id));
  if (!userMessage) return { userMessageId: null, assistantMessage: null };

  const userIndex = messages.findIndex((message) => message.id === userMessage.id);
  const messagesAfterUser = messages.slice(userIndex + 1);
  const nextUserIndex = messagesAfterUser.findIndex((message) => message.role === 'user');
  const turnMessages = nextUserIndex === -1
    ? messagesAfterUser
    : messagesAfterUser.slice(0, nextUserIndex);
  const assistantMessage = turnMessages
    .find((message) => message.role === 'assistant' && message.id !== turn.previousAssistantId) || null;
  return { userMessageId: userMessage.id, assistantMessage };
}

export function contextualFailureMessage(reason: 'timeout' | 'cancel' | 'error' | 'empty'): string {
  switch (reason) {
    case 'timeout':
      return 'This request took too long. Try again.';
    case 'cancel':
      return 'Request stopped.';
    case 'empty':
      return 'No response came back. Try again.';
    case 'error':
      return "That request didn't go through. Try again.";
  }
}
