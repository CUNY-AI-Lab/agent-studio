import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { extractMessageText, getContextualStatusLabel } from './messages';

function textMessage(text: string): UIMessage {
  return { id: 'm', role: 'assistant', parts: [{ type: 'text', text }] } as unknown as UIMessage;
}

describe('extractMessageText', () => {
  it('joins text parts', () => {
    const msg = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    } as unknown as UIMessage;
    expect(extractMessageText(msg)).toBe('hello\nworld');
  });

  it('returns empty string when parts are missing', () => {
    expect(extractMessageText({ id: 'm', role: 'user' } as unknown as UIMessage)).toBe('');
  });
});

describe('getContextualStatusLabel', () => {
  it('returns null for ready and error', () => {
    expect(getContextualStatusLabel('ready', null)).toBeNull();
    expect(getContextualStatusLabel('error', null)).toBeNull();
  });

  it('reports Thinking for submitted', () => {
    expect(getContextualStatusLabel('submitted', null)).toBe('Thinking...');
  });

  it('reports Responding when the assistant has produced text', () => {
    expect(getContextualStatusLabel('streaming', textMessage('partial answer'))).toBe('Responding...');
  });

  it('defaults to Thinking with no assistant content', () => {
    expect(getContextualStatusLabel('streaming', null)).toBe('Thinking...');
  });
});
