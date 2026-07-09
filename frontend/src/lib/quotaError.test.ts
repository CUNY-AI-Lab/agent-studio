import { describe, expect, it } from 'vitest';

import { quotaMessageFromChatError } from './quotaError';

describe('quotaMessageFromChatError', () => {
  it('extracts the worker quota message from a stream error', () => {
    const signal = JSON.stringify({
      type: 'quota_exceeded',
      message: 'Quota exhausted for this account.',
    });
    expect(quotaMessageFromChatError(new Error(signal))).toBe('Quota exhausted for this account.');
  });

  it('finds a quota signal after an error prefix and supplies the default message', () => {
    const signal = JSON.stringify({ type: 'quota_exceeded' });
    expect(quotaMessageFromChatError(new Error(`stream failed: ${signal}`))).toBe(
      'You have reached your usage quota. Try again later.',
    );
  });

  it('ignores malformed and unrelated errors', () => {
    expect(quotaMessageFromChatError(new Error('stream failed'))).toBeNull();
    expect(quotaMessageFromChatError(new Error('{not json'))).toBeNull();
    expect(quotaMessageFromChatError({ message: '{"type":"other"}' })).toBeNull();
  });
});
