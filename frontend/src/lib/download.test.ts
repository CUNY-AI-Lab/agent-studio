import { describe, expect, it } from 'vitest';
import { ensureDownloadFilename } from './download';

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
