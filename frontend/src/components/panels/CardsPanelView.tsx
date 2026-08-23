import type { CardsPanel } from '../../types';

export function CardsPanelView({ panel }: { panel: CardsPanel }) {
  if (panel.items.length === 0) {
    return <div className="panel-empty">No cards yet.</div>;
  }

  return (
    <div className="panel-cards" aria-label={`${panel.items.length} cards`}>
      {panel.items.map((item, index) => (
        <article className="panel-card" key={item.id || index}>
          <div className="panel-card-heading">
            <h4>{item.title}</h4>
            {item.badge ? <span className="panel-card-badge">{item.badge}</span> : null}
          </div>
          {item.subtitle ? <p className="panel-card-subtitle">{item.subtitle}</p> : null}
          {item.description ? <p className="panel-card-description">{item.description}</p> : null}
          {item.metadata && Object.keys(item.metadata).length > 0 ? (
            <dl className="panel-card-metadata">
              {Object.entries(item.metadata).map(([label, value]) => (
                <div className="panel-card-metadata-row" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </article>
      ))}
    </div>
  );
}
