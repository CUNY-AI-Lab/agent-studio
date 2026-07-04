import { describe, expect, it } from 'vitest';
import {
  canExportPanelSnapshot,
  canOpenFileInPanel,
  canQueryFileInPanel,
  getFileTileLabel,
  getFileTypeBadge,
  getPanelDownloadFormats,
  getPanelTitle,
  getPanelTypeLabel,
  getWorkspaceFilePanelId,
  inferWorkspaceFilePanelType,
  isPanelContextualChatCapable,
} from './panelFiles';
import type { WorkspacePanel } from '../types';

describe('file classification', () => {
  it('recognizes openable file extensions', () => {
    expect(canOpenFileInPanel('a.pdf')).toBe(true);
    expect(canOpenFileInPanel('a.zip')).toBe(false);
  });

  it('recognizes queryable file extensions', () => {
    expect(canQueryFileInPanel('a.md')).toBe(true);
    expect(canQueryFileInPanel('a.png')).toBe(false);
  });

  it('maps extensions to panel types', () => {
    expect(inferWorkspaceFilePanelType('a.pdf')).toBe('pdf');
    expect(inferWorkspaceFilePanelType('a.html')).toBe('preview');
    expect(inferWorkspaceFilePanelType('a.svg')).toBe('preview');
    expect(inferWorkspaceFilePanelType('a.ts')).toBe('editor');
  });

  it('builds a dom-safe panel id from a file path', () => {
    expect(getWorkspaceFilePanelId('dir/sub/file.name.txt')).toBe('file-dir-sub-file-name-txt');
  });

  it('produces a short badge from the extension', () => {
    expect(getFileTypeBadge('a.json')).toBe('JSON');
    expect(getFileTypeBadge('a.markdown')).toBe('MARK');
    expect(getFileTypeBadge('noext')).toBe('FILE');
  });

  it('labels common file tile types', () => {
    expect(getFileTileLabel('a.csv')).toBe('CSV File');
    expect(getFileTileLabel('a.png')).toBe('Image');
    expect(getFileTileLabel('a.unknown')).toBe('File');
  });
});

describe('getPanelTitle', () => {
  it('prefers explicit title, then filename, then fallback', () => {
    expect(getPanelTitle({ id: 'p', type: 'markdown', title: 'Hi', content: '' } as WorkspacePanel)).toBe('Hi');
    expect(getPanelTitle({ id: 'p', type: 'editor', filePath: 'x/y.txt' } as WorkspacePanel)).toBe('y.txt');
    expect(getPanelTitle({ id: 'p', type: 'fileTree' } as WorkspacePanel)).toBe('Workspace Files');
  });
});

describe('getPanelTypeLabel', () => {
  it('labels by type', () => {
    expect(getPanelTypeLabel({ id: 'p', type: 'chart' } as WorkspacePanel)).toBe('Chart');
    expect(getPanelTypeLabel({ id: 'p', type: 'pdf', filePath: 'a.pdf' } as WorkspacePanel)).toBe('PDF');
  });
});

describe('isPanelContextualChatCapable', () => {
  it('allows data panels', () => {
    expect(isPanelContextualChatCapable({ id: 'p', type: 'table', columns: [], rows: [] } as WorkspacePanel)).toBe(true);
  });

  it('gates editor panels by queryable extension', () => {
    expect(isPanelContextualChatCapable({ id: 'p', type: 'editor', filePath: 'a.md' } as WorkspacePanel)).toBe(true);
    expect(isPanelContextualChatCapable({ id: 'p', type: 'editor', filePath: 'a.png' } as WorkspacePanel)).toBe(false);
  });
});

describe('getPanelDownloadFormats', () => {
  it('returns nothing for null', () => {
    expect(getPanelDownloadFormats(null)).toEqual([]);
  });

  it('offers csv/json/png for a table', () => {
    const formats = getPanelDownloadFormats({ id: 't', type: 'table', columns: [], rows: [] } as WorkspacePanel);
    expect(formats).toEqual(['csv', 'json', 'png']);
  });

  it('includes file download when a filePath is present', () => {
    const formats = getPanelDownloadFormats({ id: 'e', type: 'editor', filePath: 'a.md' } as WorkspacePanel);
    expect(formats).toContain('file');
    expect(formats).toContain('png');
  });

  it('deduplicates formats', () => {
    const formats = getPanelDownloadFormats({ id: 'm', type: 'markdown', content: '' } as WorkspacePanel);
    expect(new Set(formats).size).toBe(formats.length);
  });
});

describe('canExportPanelSnapshot', () => {
  it('always allows chart/table/cards/markdown/fileTree', () => {
    expect(canExportPanelSnapshot({ id: 'c', type: 'chart' } as WorkspacePanel)).toBe(true);
  });

  it('gates file-backed panels by extension', () => {
    expect(canExportPanelSnapshot({ id: 'e', type: 'editor', filePath: 'a.md' } as WorkspacePanel)).toBe(true);
    expect(canExportPanelSnapshot({ id: 'e', type: 'editor', filePath: 'a.pdf' } as WorkspacePanel)).toBe(false);
  });
});
