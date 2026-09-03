import { describe, expect, it, vi } from 'vitest';
import { createDownloadQueueDrainer, ensureDownloadFilename } from './download';

describe('ensureDownloadFilename', () => {
  it('keeps an existing extension', () => {
    expect(ensureDownloadFilename('report.csv', 'csv')).toBe('report.csv');
  });

  it('appends the format extension when missing', () => {
    expect(ensureDownloadFilename('report', 'json')).toBe('report.json');
  });

  it('falls back to a default name for blank input', () => {
    expect(ensureDownloadFilename('   ', 'txt')).toBe('download.txt');
  });
});

describe('createDownloadQueueDrainer', () => {
  it('coalesces overlapping drains until the queue is cleared', async () => {
    const download = { filename: 'report', data: 'ready', format: 'txt' as const };
    const read = vi.fn(async () => [download]);
    const consume = vi.fn();
    let releaseClear: () => void = () => undefined;
    const clearPromise = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clear = vi.fn(() => clearPromise);
    const drain = createDownloadQueueDrainer(read, clear, consume);

    const first = drain();
    const second = drain();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();

    releaseClear();
    await Promise.all([first, second]);
  });
});
