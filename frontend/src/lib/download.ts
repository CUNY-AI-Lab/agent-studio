import type { DownloadRequest, QueuedDownload } from '../types';
import { z } from 'zod';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ensureDownloadFilename(filename: string, format: DownloadRequest['format']): string {
  const trimmed = filename.trim() || `download.${format}`;
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.${format}`;
}

export function triggerQueuedDownload(download: DownloadRequest) {
  const filename = ensureDownloadFilename(download.filename, download.format);

  if (download.format === 'json') {
    downloadBlob(
      new Blob([JSON.stringify(download.data, null, 2)], { type: 'application/json;charset=utf-8' }),
      filename
    );
    return;
  }

  const stringData = z.string().safeParse(download.data).data;
  const content = stringData !== undefined
    ? stringData
    : download.data == null
      ? ''
      : String(download.data);
  const contentType = download.format === 'csv'
    ? 'text/csv;charset=utf-8'
    : 'text/plain;charset=utf-8';
  downloadBlob(new Blob([content], { type: contentType }), filename);
}

/**
 * Serialize browser consumption of the server-side download queue.
 *
 * A workspace can ask the shell to drain from more than one lifecycle edge
 * (initial readiness and a same-workspace refresh). Keep one in-flight drain
 * so two edges cannot trigger the same download before the server-side
 * acknowledgement completes. Continue reading after each acknowledgement so
 * items queued while that acknowledgement was in flight are delivered by the
 * same lifecycle edge. IDs are acknowledged only after browser consumption
 * succeeds; the server endpoint still owns cross-client ordering and
 * acknowledgement semantics.
 */
export function createDownloadQueueDrainer(
  read: () => Promise<QueuedDownload[]>,
  clear: (ids: readonly string[]) => Promise<void>,
  consume: (downloads: QueuedDownload[]) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (inFlight) return inFlight;

    const operation = (async () => {
      while (true) {
        const downloads = await read();
        if (downloads.length === 0) return;
        consume(downloads);
        await clear(downloads.map((download) => download.id));
      }
    })();
    inFlight = operation;

    try {
      await operation;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  };
}
