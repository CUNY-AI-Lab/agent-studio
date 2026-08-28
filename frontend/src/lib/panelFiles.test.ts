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
import type {
  ChartPanel,
  FilePanel,
  FileTreePanel,
  MarkdownPanel,
  TablePanel,
} from '../types';

function markdownPanel(id: string, extra: Partial<MarkdownPanel> = {}): MarkdownPanel {
  return { id, type: 'markdown', content: '', ...extra };
}

function tablePanel(id: string, extra: Partial<TablePanel> = {}): TablePanel {
  return { id, type: 'table', columns: [], rows: [], ...extra };
}

function chartPanel(id: string, extra: Partial<ChartPanel> = {}): ChartPanel {
  return { id, type: 'chart', chartType: 'bar', data: [], ...extra };
}

function filePanel(type: FilePanel['type'], id: string, filePath: string, extra: Partial<FilePanel> = {}): FilePanel {
  return { id, type, filePath, ...extra };
}

function fileTreePanel(id: string, extra: Partial<FileTreePanel> = {}): FileTreePanel {
  return { id, type: 'fileTree', ...extra };
}

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
    expect(getPanelTitle(markdownPanel('p', { title: 'Hi' }))).toBe('Hi');
    expect(getPanelTitle(filePanel('editor', 'p', 'x/y.txt'))).toBe('y.txt');
    expect(getPanelTitle(fileTreePanel('p'))).toBe('Workspace Files');
  });
});

describe('getPanelTypeLabel', () => {
  it('labels by type', () => {
    expect(getPanelTypeLabel(chartPanel('p'))).toBe('Chart');
    expect(getPanelTypeLabel(filePanel('pdf', 'p', 'a.pdf'))).toBe('PDF');
  });
});

describe('isPanelContextualChatCapable', () => {
  it('allows data panels', () => {
    expect(isPanelContextualChatCapable(tablePanel('p'))).toBe(true);
  });

  it('gates editor panels by queryable extension', () => {
    expect(isPanelContextualChatCapable(filePanel('editor', 'p', 'a.md'))).toBe(true);
    expect(isPanelContextualChatCapable(filePanel('editor', 'p', 'a.png'))).toBe(false);
  });
});

describe('getPanelDownloadFormats', () => {
  it('returns nothing for null', () => {
    expect(getPanelDownloadFormats(null)).toEqual([]);
  });

  it('offers csv/json/png for a table', () => {
    const formats = getPanelDownloadFormats(tablePanel('t'));
    expect(formats).toEqual(['csv', 'json', 'png']);
  });

  it('includes file download when a filePath is present', () => {
    const formats = getPanelDownloadFormats(filePanel('editor', 'e', 'a.md'));
    expect(formats).toContain('file');
    expect(formats).toContain('png');
  });

});

describe('canExportPanelSnapshot', () => {
  it('always allows chart/table/cards/markdown/fileTree', () => {
    expect(canExportPanelSnapshot(chartPanel('c'))).toBe(true);
  });

  it('gates file-backed panels by extension', () => {
    expect(canExportPanelSnapshot(filePanel('editor', 'e', 'a.md'))).toBe(true);
    expect(canExportPanelSnapshot(filePanel('editor', 'e', 'a.pdf'))).toBe(false);
  });
});
