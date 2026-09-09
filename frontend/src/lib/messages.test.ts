import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { extractMessageText, getContextualStatusLabel, getToolNotices } from './messages';

function textMessage(text: string): UIMessage {
  return { id: 'm', role: 'assistant', parts: [{ type: 'text', text }] };
}

describe('tool attempt notices', () => {
  it('does not treat prior success or a final apology as recovery from a later failed attempt', () => {
    expect(getToolNotices({ id: 'failure', role: 'assistant', parts: [
      { type: 'tool-write_file', toolCallId: 'saved', state: 'output-available', input: {}, output: {} },
      { type: 'tool-codemode', toolCallId: 'failed', state: 'output-error', input: {}, errorText: 'hidden' },
      { type: 'text', text: 'I could not finish.' },
    ] })).toEqual([{ kind: 'error', message: 'A tool attempt failed. Review the response and any files it produced.' }]);
  });

  it('reports continuation during a later tool attempt without claiming success', () => {
    expect(getToolNotices({ id: 'continuing', role: 'assistant', parts: [
      { type: 'tool-codemode', toolCallId: 'failed', state: 'output-error', input: {}, errorText: 'hidden' },
      { type: 'tool-codemode', toolCallId: 'next', state: 'input-streaming', input: {} },
    ] })).toEqual([{ kind: 'continued', message: 'A tool attempt failed. The agent continued with other tools.' }]);
  });
});

describe('extractMessageText', () => {
  it('joins text parts', () => {
    const msg: UIMessage = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    };
    expect(extractMessageText(msg)).toBe('hello\nworld');
  });

  it('returns empty string when parts are missing', () => {
    // SAFETY: this deliberately malformed fixture exercises the runtime guard
    // for a persisted message whose parts field is missing.
    expect(extractMessageText({ id: 'm', role: 'user' } as UIMessage)).toBe('');
  });

  it('omits tool parts from user-facing message text', () => {
    const msg: UIMessage = {
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'tool-write_file', toolCallId: 't1', state: 'output-available', input: {}, output: {} }],
    };
    expect(extractMessageText(msg)).toBe('');
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
