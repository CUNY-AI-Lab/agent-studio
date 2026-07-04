import { useMemo } from 'react';
import { Layout } from 'lucide-react';
import { buildPanelLayouts, inferPanelLayout } from '../../lib/panelLayout';
import { getPanelTitle } from '../../lib/panelFiles';
import type { WorkspaceState } from '../../types';
import { ConnectionLines as LegacyConnectionLines } from './ConnectionLines';
import { GroupBoundary as LegacyGroupBoundary } from './GroupBoundary';
import { PanelBody } from '../panels/PanelBody';

export function ReadOnlyCanvas({
  galleryId,
  title,
  description,
  state,
}: {
  galleryId: string;
  title: string;
  description: string;
  state: WorkspaceState;
}) {
  const visiblePanels = state.panels.filter((panel) => panel.type !== 'chat');
  const panelLayouts = useMemo(() => buildPanelLayouts(visiblePanels), [visiblePanels]);
  const visiblePanelIds = useMemo(() => new Set(visiblePanels.map((panel) => panel.id)), [visiblePanels]);
  const panelTitles = useMemo(
    () => Object.fromEntries(visiblePanels.map((panel) => [panel.id, getPanelTitle(panel)])),
    [visiblePanels]
  );

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="canvas-header flex items-center gap-4 px-6 py-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-serif text-lg font-medium truncate">{title}</h2>
          <p className="text-sm text-muted-foreground truncate">{description}</p>
        </div>
      </header>

      <div className="canvas-bg flex-1 relative overflow-auto">
        {state.groups.map((group) => (
          <LegacyGroupBoundary
            key={group.id}
            group={group}
            panelLayouts={panelLayouts}
            existingPanelIds={visiblePanelIds}
            visiblePanelIds={visiblePanelIds}
            scale={1}
          />
        ))}
        <LegacyConnectionLines
          panelLayouts={panelLayouts}
          connections={state.connections.filter((connection) => visiblePanelIds.has(connection.sourceId) && visiblePanelIds.has(connection.targetId))}
          panelTitles={panelTitles}
        />
        {visiblePanels.length === 0 ? (
          <div className="canvas-empty">
            <Layout className="canvas-empty-icon" />
            <h3>No Panels</h3>
            <p>This gallery item has no visible panels yet.</p>
          </div>
        ) : null}
        {visiblePanels.map((panel, index) => {
          const layout = panelLayouts[panel.id] ?? inferPanelLayout(panel, index);
          return (
            <article
              key={panel.id}
              className="artifact-card absolute"
              style={{
                left: layout.x,
                top: layout.y,
                width: layout.width,
                height: layout.height,
              }}
            >
              <header className="artifact-header">
                <h3>{panel.title || panel.id}</h3>
                <span className="artifact-type">{panel.type}</span>
              </header>
              <div className="artifact-content">
                <PanelBody fileSource={{ kind: 'gallery', id: galleryId }} panel={panel} allPanels={visiblePanels} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
