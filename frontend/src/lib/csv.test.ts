import { describe, expect, it } from 'vitest';
import { escapeCsvCell, parseCsvPreview, serializeTableAsCsv } from './csv';
import type { WorkspacePanel } from '../types';

describe('parseCsvPreview', () => {
  it('separates headers from rows', () => {
    const { headers, rows, truncated } = parseCsvPreview('name,age\nAda,30\nGrace,45');
    expect(headers).toEqual(['name', 'age']);
    expect(rows).toEqual([['Ada', '30'], ['Grace', '45']]);
    expect(truncated).toBe(false);
  });

  it('keeps LF and CRLF inside quoted cells instead of creating extra rows', () => {
    expect(parseCsvPreview('name,notes\nAda,"line one\nline two"\nGrace,"said ""hi"""')).toEqual({
      headers: ['name', 'notes'],
      rows: [['Ada', 'line one\nline two'], ['Grace', 'said "hi"']],
      truncated: false,
    });
    expect(parseCsvPreview('name,notes\r\nAda,"line one\r\nline two"\r\nGrace,done\r\n')).toEqual({
      headers: ['name', 'notes'],
      rows: [['Ada', 'line one\r\nline two'], ['Grace', 'done']],
      truncated: false,
    });
  });

  it('marks truncation past the row limit', () => {
    const body = ['h', ...Array.from({ length: 5 }, (_, i) => `r${i}`)].join('\n');
    const { rows, truncated } = parseCsvPreview(body, 2);
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('preserves records whose cells are all empty', () => {
    expect(parseCsvPreview('A,B\n,\n"",')).toEqual({
      headers: ['A', 'B'],
      rows: [['', ''], ['', '']],
      truncated: false,
    });
  });

  it('returns no headers for blank input', () => {
    expect(parseCsvPreview('')).toEqual({ headers: [], rows: [], truncated: false });
  });
});

describe('escapeCsvCell', () => {
  it('leaves plain values untouched', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
  });

  it('quotes and escapes values with commas, quotes, or newlines', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('renders null and undefined as empty strings', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('serializeTableAsCsv', () => {
  it('emits a header row followed by data rows', () => {
    const panel: Extract<WorkspacePanel, { type: 'table' }> = {
      id: 't',
      type: 'table',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'city', label: 'City' },
      ],
      rows: [
        { name: 'Ada', city: 'line1\r\nline2' },
        { name: 'Bo', city: 'São, Paulo' },
      ],
    };
    expect(serializeTableAsCsv(panel)).toBe('Name,City\nAda,"line1\r\nline2"\nBo,"São, Paulo"');
  });
});
