import { useMemo, useState } from 'react';
import type { WorkspacePanel } from '../../types';

export function TablePanelView({ panel }: { panel: Extract<WorkspacePanel, { type: 'table' }> }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const sortedRows = useMemo(() => {
    if (!sortKey) return panel.rows;

    return [...panel.rows].sort((left, right) => {
      const leftValue = left[sortKey];
      const rightValue = right[sortKey];

      if (leftValue == null && rightValue == null) return 0;
      if (leftValue == null) return sortDirection === 'asc' ? 1 : -1;
      if (rightValue == null) return sortDirection === 'asc' ? -1 : 1;

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return sortDirection === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      }

      const leftString = String(leftValue).toLowerCase();
      const rightString = String(rightValue).toLowerCase();
      if (leftString < rightString) return sortDirection === 'asc' ? -1 : 1;
      if (leftString > rightString) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [panel.rows, sortDirection, sortKey]);

  if (panel.rows.length === 0) {
    return <div className="panel-empty">No table rows yet.</div>;
  }

  return (
    <div className="panel-table-wrap">
      <table className="panel-table">
        <thead>
          <tr>
            {panel.columns.map((column) => (
              <th key={column.key}>
                <button
                  className="panel-table-sort"
                  onClick={() => {
                    if (sortKey === column.key) {
                      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
                    } else {
                      setSortKey(column.key);
                      setSortDirection('asc');
                    }
                  }}
                >
                  <span>{column.label}</span>
                  {sortKey === column.key ? (
                    <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>
                  ) : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr key={index}>
              {panel.columns.map((column) => (
                <td key={column.key}>
                  {row[column.key] == null || row[column.key] === ''
                    ? <span className="panel-muted">—</span>
                    : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
