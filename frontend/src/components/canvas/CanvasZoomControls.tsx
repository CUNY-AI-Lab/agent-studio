import { useCallback } from 'react';
import { useControls } from 'react-zoom-pan-pinch';
import { Minus, Plus } from 'lucide-react';
import { zoomViewportAtPoint } from '../../lib/canvasViewport';

export function CanvasZoomControls({ zoom, viewportX, viewportY }: { zoom: number; viewportX: number; viewportY: number }) {
  const { instance, state, setTransform } = useControls();
  const showReset = Math.abs(zoom - 1) > 0.01 || Math.abs(viewportX) > 1 || Math.abs(viewportY) > 1;

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const { scale, positionX, positionY } = state;
    const factor = direction === 'in' ? 1.2 : 1 / 1.2;
    // Zoom toward the center of the viewport
    const wrapper = instance.wrapperComponent;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const next = zoomViewportAtPoint({ x: positionX, y: positionY, zoom: scale }, { x: cx, y: cy }, factor);
      setTransform(next.x, next.y, next.zoom, 0);
    } else {
      const next = zoomViewportAtPoint({ x: positionX, y: positionY, zoom: scale }, { x: 0, y: 0 }, factor);
      setTransform(next.x, next.y, next.zoom, 0);
    }
  }, [instance, setTransform, state]);

  return (
    <div
      className="fixed bottom-4 left-4 z-40 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur"
      role="group"
      aria-label="Canvas zoom"
    >
      <button
        onClick={() => handleZoom('out')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <span className="w-12 text-center font-mono text-xs text-muted-foreground" aria-live="polite" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => handleZoom('in')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {showReset ? (
        <button
          onClick={() => setTransform(0, 0, 1, 0)}
          className="rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Reset view"
          aria-label="Reset zoom and position"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
