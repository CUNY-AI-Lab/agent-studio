import { describe, expect, it } from 'vitest';
import { escapeCsvCell, parseCsvPreview, parseDelimitedLine, serializeTableAsCsv } from './csv';
import type { WorkspacePanel } from '../types';

describe('parseDelimitedLine', () => {
  it('splits a simple comma line', () => {
    expect(parseDelimitedLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('respects quoted fields containing the delimiter', () => {
    expect(parseDelimitedLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseDelimitedLine('"he said ""hi""",x')).toEqual(['he said "hi"', 'x']);
  });

  it('supports a custom delimiter', () => {
    expect(parseDelimitedLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseCsvPreview', () => {
  it('separates headers from rows', () => {
    const { headers, rows, truncated } = parseCsvPreview('name,age\nAda,30\nGrace,45');
    expect(headers).toEqual(['name', 'age']);
    expect(rows).toEqual([['Ada', '30'], ['Grace', '45']]);
    expect(truncated).toBe(false);
  });

  it('marks truncation past the row limit', () => {
    const body = ['h', ...Array.from({ length: 5 }, (_, i) => `r${i}`)].join('\n');
    const { rows, truncated } = parseCsvPreview(body, 2);
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('treats blank input as a single empty header cell', () => {
    // The blank first line is retained (index 0 of a single-line source),
    // so it parses as one empty header column and no rows.
    expect(parseCsvPreview('')).toEqual({ headers: [''], rows: [], truncated: false });
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
  });

  it('renders null and undefined as empty strings', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('serializeTableAsCsv', () => {
  it('emits a header row followed by data rows', () => {
    const panel = {
      id: 't',
      type: 'table',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'city', label: 'City' },
      ],
      rows: [
        { name: 'Ada', city: 'London' },
        { name: 'Bo', city: 'São, Paulo' },
      ],
    } as Extract<WorkspacePanel, { type: 'table' }>;
    expect(serializeTableAsCsv(panel)).toBe('Name,City\nAda,London\nBo,"São, Paulo"');
  });
});
