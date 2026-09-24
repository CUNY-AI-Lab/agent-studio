import { describe, expect, it } from 'vitest';

import { noticeFromChatError } from './chatError';

describe('noticeFromChatError', () => {
  it('maps the worker quota code without displaying upstream text', () => {
    const signal = JSON.stringify({
      error: { code: 'quota_exceeded', message: 'Quota exhausted for this account.' },
    });
    const notice = noticeFromChatError(new Error(signal));
    expect(notice).not.toBeNull();
    expect(notice).not.toContain('Quota exhausted for this account.');
  });

  it('finds a quota signal after an error prefix and supplies the default message', () => {
    const signal = JSON.stringify({ error: { code: 'quota_exceeded' } });
    const notice = noticeFromChatError(new Error(`stream failed: ${signal}`));
    expect(notice).not.toBeNull();
    expect(notice).toBe(noticeFromChatError(new Error(signal)));
  });

  it('warns that an unconfirmed outcome may already have produced a result', () => {
    const signal = JSON.stringify({ error: { code: 'outcome_unknown' } });
    expect(noticeFromChatError(new Error(signal))).toMatch(/may already have produced a result/);
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
