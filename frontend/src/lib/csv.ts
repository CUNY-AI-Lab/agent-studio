import { dsvFormat } from 'd3-dsv';
import type { WorkspacePanel } from '../types';

const CSV_FORMAT = dsvFormat(',');

export type CsvPreview = { headers: string[]; rows: string[][]; truncated: boolean };

export function parseCsvPreview(content: string, limit = 50): CsvPreview {
  let headers: string[] = [];
  const rows: string[][] = [];
  let truncated = false;

  CSV_FORMAT.parseRows(content, (row, rowIndex) => {
    if (rowIndex === 0) {
      headers = row;
    } else if (rows.length < limit) {
      rows.push(row);
    } else truncated = true;
    return null;
  });

  return {
    headers,
    rows,
    truncated,
  };
}

export function escapeCsvCell<T>(value: T): string {
  return CSV_FORMAT.formatValue(String(value ?? ''));
}

export function serializeTableAsCsv(panel: Extract<WorkspacePanel, { type: 'table' }>): string {
  const rows = [
    panel.columns.map((column) => column.label),
    ...panel.rows.map((row) => panel.columns.map((column) => row[column.key])),
  ].map((row) => row.map((value) => String(value ?? '')));
  return CSV_FORMAT.formatRows(rows);
}
