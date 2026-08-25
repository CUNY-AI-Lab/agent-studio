import { describe, expect, it } from 'vitest';
import { getChatActivity } from './chatActivity';

const idle = {
  isStreaming: false,
  isServerStreaming: false,
  isRecovering: false,
  isToolContinuation: false,
  contextualTurnActive: false,
};

describe('chat activity', () => {
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
});
