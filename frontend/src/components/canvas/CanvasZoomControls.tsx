import { useCallback } from 'react';
import { useControls } from 'react-zoom-pan-pinch';
import { Minus, Plus } from 'lucide-react';

export function CanvasZoomControls({ zoom, viewportX, viewportY }: { zoom: number; viewportX: number; viewportY: number }) {
  const { instance } = useControls();
  const showReset = Math.abs(zoom - 1) > 0.01 || Math.abs(viewportX) > 1 || Math.abs(viewportY) > 1;

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const { scale, positionX, positionY } = instance.transformState;
    const factor = direction === 'in' ? 1.2 : 1 / 1.2;
    const newScale = Math.min(3, Math.max(0.1, scale * factor));
    // Zoom toward the center of the viewport
    const wrapper = instance.wrapperComponent;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const newX = cx - (cx - positionX) * (newScale / scale);
      const newY = cy - (cy - positionY) * (newScale / scale);
      instance.setTransformState(newScale, newX, newY);
    } else {
      instance.setTransformState(newScale, positionX, positionY);
    }
  }, [instance]);

  return (
    <div className="fixed bottom-4 left-4 z-40 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur">
      <button
        onClick={() => handleZoom('out')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Zoom out"
      >
        <Minus size={14} />
      </button>
      <span className="w-12 text-center font-mono text-xs text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => handleZoom('in')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Zoom in"
      >
        <Plus size={14} />
      </button>
      {showReset ? (
        <button
          onClick={() => instance.setTransformState(1, 0, 0)}
          className="rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Reset viewport"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
