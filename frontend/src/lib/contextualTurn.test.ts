import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { contextualFailureMessage, getContextualTurnMessages } from './contextualTurn';

function message(id: string, role: 'user' | 'assistant'): UIMessage {
  return { id, role, parts: [{ type: 'text', text: id }] };
}

describe('contextual turn correlation', () => {
  it('ignores an assistant from an unrelated turn', () => {
    const result = getContextualTurnMessages(
      [message('old-user', 'user'), message('old-assistant', 'assistant')],
      {
        previousAssistantId: 'old-assistant',
        previousMessageIds: new Set(['old-user', 'old-assistant']),
        userMessageId: null,
      },
    );
    expect(result.userMessageId).toBeNull();
    expect(result.assistantMessage).toBeNull();
  });

  it('finds only the assistant after the scoped user message', () => {
    const result = getContextualTurnMessages(
      [
        message('old-user', 'user'),
        message('old-assistant', 'assistant'),
        message('scoped-user', 'user'),
        message('scoped-assistant', 'assistant'),
      ],
      {
        previousAssistantId: 'old-assistant',
        previousMessageIds: new Set(['old-user', 'old-assistant']),
        userMessageId: null,
      },
    );
    expect(result.userMessageId).toBe('scoped-user');
    expect(result.assistantMessage?.id).toBe('scoped-assistant');
  });

  it('does not attribute a later unrelated turn to the scoped request', () => {
    const result = getContextualTurnMessages(
      [
        message('scoped-user', 'user'),
        message('other-user', 'user'),
        message('other-assistant', 'assistant'),
      ],
      {
        previousAssistantId: null,
        previousMessageIds: new Set(),
        userMessageId: null,
      },
    );
    expect(result.userMessageId).toBe('scoped-user');
    expect(result.assistantMessage).toBeNull();
  });
});

describe('contextual failure copy', () => {
  it('distinguishes timeout, cancellation, empty, and stream errors', () => {
    expect(contextualFailureMessage('timeout')).toContain('too long');
    expect(contextualFailureMessage('cancel')).toBe('Request stopped.');
    expect(contextualFailureMessage('empty')).toContain('No response');
    expect(contextualFailureMessage('error')).toContain("didn't go through");
  });
});
