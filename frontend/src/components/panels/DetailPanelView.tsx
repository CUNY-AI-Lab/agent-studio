import type { WorkspacePanel } from '../../types';

export function DetailPanelView({
  panel,
  panels,
}: {
  panel: Extract<WorkspacePanel, { type: 'detail' }>;
  panels: WorkspacePanel[];
}) {
  const linkedPanel = panel.linkedTo
    ? panels.find((candidate) => candidate.id === panel.linkedTo)
    : null;

  if (!panel.linkedTo) {
    return <div className="panel-empty">No linked tile selected for this detail view.</div>;
  }

  if (!linkedPanel || linkedPanel.type !== 'table') {
    return <div className="panel-empty">The linked table for this detail view is unavailable.</div>;
  }

  if (linkedPanel.rows.length === 0) {
    return <div className="panel-empty">The linked table has no rows yet.</div>;
  }

  return (
    <div className="space-y-3 pr-1">
      {linkedPanel.rows.slice(0, 8).map((row, index) => (
        <article key={index} className="detail-row">
          <div className="ui-label">
            Row {index + 1}
          </div>
          <dl>
            {linkedPanel.columns.map((column) => (
              <div key={column.key} className="grid grid-cols-[minmax(0,140px)_1fr] items-start gap-3">
                <dt>
                  {column.label}
                </dt>
                <dd className="break-words text-[13.5px] leading-relaxed">
                  {row[column.key] == null || row[column.key] === ''
                    ? <span className="panel-muted">—</span>
                    : String(row[column.key])}
                </dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
      {linkedPanel.rows.length > 8 ? (
        <div className="panel-footnote">Showing the first 8 rows from the linked table.</div>
      ) : null}
    </div>
  );
}
