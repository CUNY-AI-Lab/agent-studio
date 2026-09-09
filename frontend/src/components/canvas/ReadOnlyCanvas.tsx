import { ArrowLeft, Layout } from 'lucide-react';
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
      <div className="shrink-0">
        <header className="ws-header flex items-center gap-4 px-5 py-2.5">
          <button
            type="button"
            onClick={onGoHome}
            className="ui-icon-btn"
            title="Back to home"
            aria-label="Back to home"
          >
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold tracking-tight">{title}</h2>
            <p className="truncate text-[13px] text-muted-foreground">{description}</p>
          </div>
          <span className="ui-label shrink-0">Read-only</span>
        </header>
        <div className="ws-header-rule" aria-hidden="true" />
      </div>
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
