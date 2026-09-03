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
    const download = { id: 'download-1', filename: 'report', data: 'ready', format: 'txt' as const };
    let queued = [download];
    const read = vi.fn(async () => {
      const next = queued;
      queued = [];
      return next;
    });
    const consume = vi.fn();
    let releaseClear: () => void = () => undefined;
    const clearPromise = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clear = vi.fn((_ids: readonly string[]) => clearPromise);
    const drain = createDownloadQueueDrainer(read, clear, consume);

    const first = drain();
    const second = drain();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(['download-1']);

    releaseClear();
    await Promise.all([first, second]);
  });

  it('drains an item queued while the preceding acknowledgement is in flight', async () => {
    const firstDownload = { id: 'download-a', filename: 'first', data: 'a', format: 'txt' as const };
    const secondDownload = { id: 'download-b', filename: 'second', data: 'b', format: 'txt' as const };
    let queued = [firstDownload];
    const read = vi.fn(async () => {
      const next = queued;
      queued = [];
      return next;
    });
    const consume = vi.fn();
    let releaseFirstAcknowledgement: () => void = () => undefined;
    const firstAcknowledgement = new Promise<void>((resolve) => {
      releaseFirstAcknowledgement = resolve;
    });
    const clear = vi.fn(async (ids: readonly string[]) => {
      if (ids[0] === firstDownload.id) {
        queued = [secondDownload];
        await firstAcknowledgement;
      }
    });
    const drain = createDownloadQueueDrainer(read, clear, consume);

    const first = drain();
    await Promise.resolve();
    const second = drain();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith([firstDownload]);

    releaseFirstAcknowledgement();
    await Promise.all([first, second]);

    expect(consume).toHaveBeenNthCalledWith(2, [secondDownload]);
    expect(clear).toHaveBeenNthCalledWith(1, [firstDownload.id]);
    expect(clear).toHaveBeenNthCalledWith(2, [secondDownload.id]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not acknowledge downloads when browser consumption fails', async () => {
    const download = { id: 'download-1', filename: 'report', data: 'ready', format: 'txt' as const };
    const read = vi.fn(async () => [download]);
    const consume = vi.fn(() => {
      throw new Error('browser rejected download');
    });
    const clear = vi.fn(async (_ids: readonly string[]) => undefined);
    const drain = createDownloadQueueDrainer(read, clear, consume);

    await expect(drain()).rejects.toThrow('browser rejected download');
    expect(clear).not.toHaveBeenCalled();
  });

  it('stops after an acknowledgement failure without consuming later items', async () => {
    const firstDownload = { id: 'download-a', filename: 'first', data: 'a', format: 'txt' as const };
    const secondDownload = { id: 'download-b', filename: 'second', data: 'b', format: 'txt' as const };
    let queued = [firstDownload];
    const read = vi.fn(async () => {
      const next = queued;
      queued = [];
      return next;
    });
    const consume = vi.fn();
    const clear = vi.fn(async (_ids: readonly string[]) => {
      queued = [secondDownload];
      throw new Error('acknowledgement failed');
    });
    const drain = createDownloadQueueDrainer(read, clear, consume);

    await expect(drain()).rejects.toThrow('acknowledgement failed');
    expect(consume).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
  });
});
