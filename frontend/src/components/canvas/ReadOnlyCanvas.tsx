import { Layout } from 'lucide-react';
import { CanvasFlow } from './CanvasFlow';
import type { WorkspaceState } from '../../types';

export function ReadOnlyCanvas({
  galleryId,
  title,
  description,
  state,
  onGoHome,
}: {
  galleryId: string;
  title: string;
  description: string;
  state: WorkspaceState;
  onGoHome: () => void;
}) {
  const visiblePanels = state.panels.filter((panel) => panel.type !== 'chat');

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="canvas-header flex items-center gap-4 px-6 py-3">
        <button
          type="button"
          onClick={onGoHome}
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Back to home"
          aria-label="Back to home"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-serif text-lg font-medium">{title}</h2>
          <p className="truncate text-sm text-muted-foreground">{description}</p>
        </div>
      </header>
      <CanvasFlow
        panels={visiblePanels}
        allPanels={visiblePanels}
        groups={state.groups}
        connections={state.connections}
        viewport={state.viewport}
        fileSource={{ kind: 'gallery', id: galleryId }}
        readOnly
        emptyState={visiblePanels.length === 0 ? (
          <div className="canvas-empty pointer-events-none absolute inset-0">
            <Layout className="canvas-empty-icon" />
            <h3>No Tiles</h3>
            <p>This gallery item has no visible tiles yet.</p>
          </div>
        ) : null}
      />
    </section>
  );
}
