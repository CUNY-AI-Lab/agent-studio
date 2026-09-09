import { describe, expect, it } from 'vitest';
import { getChatActivity } from './chatActivity';

const idle = {
  isStreaming: false,
  isServerStreaming: false,
  isRecovering: false,
  isToolContinuation: false,
  contextualTurnActive: false,
  connectionError: null,
};

describe('chat activity', () => {
  it('reports real stages without carrying the previous turn into a new request', () => {
    const toolMessage = {
      id: 'assistant', role: 'assistant' as const,
      parts: [{ type: 'tool-write_file' as const, toolCallId: 'tool', state: 'input-available' as const, input: {} }],
    };
    const working = { ...idle, status: 'streaming', canRetry: false };
    expect(getChatActivity({ ...working, messages: [toolMessage] })).toMatchObject({ detail: 'Saving a file…' });
    expect(getChatActivity({ ...working, messages: [{
      ...toolMessage,
      parts: [{ type: 'tool-write_file', toolCallId: 'tool', state: 'input-streaming', input: {} }],
    }] })).toMatchObject({ detail: 'Preparing a file…' });
    expect(getChatActivity({ ...working, messages: [toolMessage], isRecovering: true })).toMatchObject({ detail: 'Recovering the response…' });
    expect(getChatActivity({ ...working, isToolContinuation: true })).toMatchObject({ detail: 'Continuing after tools…' });
    expect(getChatActivity({ ...working, messages: [
      { id: 'text', role: 'assistant', parts: [{ type: 'text', text: 'A response' }] },
    ] })).toMatchObject({ detail: 'Writing the response…' });
    expect(getChatActivity({ ...working, messages: [toolMessage,
      { id: 'next', role: 'user', parts: [{ type: 'text', text: 'Next request' }] },
    ] })).toMatchObject({ detail: 'Thinking…' });
  });

  it('is ready only when every stream and contextual flag is idle', () => {
    expect(getChatActivity({ ...idle, status: 'ready', canRetry: false })).toMatchObject({
      phase: 'ready',
      canSubmit: true,
      canStop: false,
    });
    expect(getChatActivity({ ...idle, status: 'ready', isServerStreaming: true, canRetry: false }).phase).toBe('working');
    expect(getChatActivity({ ...idle, status: 'ready', isToolContinuation: true, canRetry: false }).phase).toBe('working');
    expect(getChatActivity({ ...idle, status: 'ready', contextualTurnActive: true, canRetry: false }).phase).toBe('working');
  });

  it('keeps retry available only for the terminal error state', () => {
    expect(getChatActivity({ ...idle, status: 'error', canRetry: true })).toMatchObject({
      phase: 'error',
      canSubmit: true,
      canStop: false,
      canRetry: true,
    });
    expect(getChatActivity({ ...idle, status: 'streaming', canRetry: true })).toMatchObject({
      phase: 'working',
      canRetry: false,
    });
  });

  it.each([
    'isStreaming',
    'isServerStreaming',
    'isRecovering',
    'isToolContinuation',
    'contextualTurnActive',
  ] as const)('keeps an error response working while %s is active', (flag) => {
    expect(getChatActivity({
      ...idle,
      status: 'error',
      canRetry: true,
      [flag]: true,
    })).toMatchObject({
      phase: 'working',
      canSubmit: false,
      canStop: true,
      canRetry: false,
    });
  });

  it('blocks sending and reports a terminal agent connection failure', () => {
    expect(getChatActivity({
      ...idle,
      status: 'ready',
      connectionError: new Error('socket closed'),
      canRetry: true,
    })).toMatchObject({
      phase: 'error',
      label: 'Connection lost',
      canSubmit: false,
      canStop: false,
      canRetry: false,
    });
  });
});
