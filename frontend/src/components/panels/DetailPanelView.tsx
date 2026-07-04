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
        <article key={index} className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Row {index + 1}
          </div>
          <dl className="space-y-2">
            {linkedPanel.columns.map((column) => (
              <div key={column.key} className="grid grid-cols-[minmax(0,140px)_1fr] gap-3 items-start">
                <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {column.label}
                </dt>
                <dd className="text-sm leading-relaxed break-words">
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
