import type { DownloadRequest } from '../types';

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

  const content = typeof download.data === 'string'
    ? download.data
    : download.data == null
      ? ''
      : String(download.data);
  const contentType = download.format === 'csv'
    ? 'text/csv;charset=utf-8'
    : 'text/plain;charset=utf-8';
  downloadBlob(new Blob([content], { type: contentType }), filename);
}
