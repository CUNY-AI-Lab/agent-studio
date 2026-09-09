import { describe, expect, it } from 'vitest';

import { noticeFromChatError } from './chatError';

describe('noticeFromChatError', () => {
  it('maps the worker quota code without displaying upstream text', () => {
    const signal = JSON.stringify({
      error: { code: 'quota_exceeded', message: 'Quota exhausted for this account.' },
    });
    expect(noticeFromChatError(new Error(signal))).toBe('You have reached your usage quota. Try again later.');
  });

  it('finds a quota signal after an error prefix and supplies the default message', () => {
    const signal = JSON.stringify({ error: { code: 'quota_exceeded' } });
    expect(noticeFromChatError(new Error(`stream failed: ${signal}`))).toBe(
      'You have reached your usage quota. Try again later.',
    );
  });

  it('ignores malformed and unrelated errors', () => {
    expect(noticeFromChatError(new Error('stream failed'))).toBeNull();
    expect(noticeFromChatError(new Error('{not json'))).toBeNull();
    expect(noticeFromChatError({ message: '{"type":"other"}' })).toBeNull();
    expect(noticeFromChatError({ message: '{"type":"quota_exceeded"}' })).toBeNull();
    expect(noticeFromChatError(new Error('{"error":{"code":"authentication_required","message":"private detail"}}'))).toBeNull();
    expect(noticeFromChatError(new Error('{"error":{"code":"unrecognized","message":"private detail"}}'))).toBeNull();
  });
});
