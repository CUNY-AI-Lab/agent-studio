import { dsvFormat } from 'd3-dsv';
import type { WorkspacePanel } from '../types';

const CSV_FORMAT = dsvFormat(',');

export type CsvPreview = { headers: string[]; rows: string[][]; truncated: boolean };

export function parseCsvPreview(content: string, limit = 50): CsvPreview {
  const lines = CSV_FORMAT.parseRows(content);

  if (lines.length === 0) {
    return { headers: [], rows: [], truncated: false };
  }

  const [headers, ...dataRows] = lines;
  return {
    headers,
    rows: dataRows.slice(0, limit),
    truncated: dataRows.length > limit,
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
