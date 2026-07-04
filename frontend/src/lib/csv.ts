import type { WorkspacePanel } from '../types';

export function parseDelimitedLine(line: string, delimiter = ','): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === delimiter && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

export function parseCsvPreview(content: string, limit = 50) {
  const lines = content
    .split(/\r?\n/)
    .filter((line, index, source) => line.trim().length > 0 || (index === 0 && source.length === 1));

  if (lines.length === 0) {
    return { headers: [] as string[], rows: [] as string[][], truncated: false };
  }

  const headers = parseDelimitedLine(lines[0]);
  const rows = lines.slice(1, limit + 1).map((line) => parseDelimitedLine(line));
  return {
    headers,
    rows,
    truncated: lines.length > limit + 1,
  };
}

export function escapeCsvCell(value: unknown): string {
  const normalized = String(value ?? '');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function serializeTableAsCsv(panel: Extract<WorkspacePanel, { type: 'table' }>): string {
  const header = panel.columns.map((column) => escapeCsvCell(column.label)).join(',');
  const rows = panel.rows.map((row) =>
    panel.columns.map((column) => escapeCsvCell(row[column.key])).join(',')
  );
  return [header, ...rows].join('\n');
}
