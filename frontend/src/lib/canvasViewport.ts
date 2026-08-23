import type { WorkspaceViewport } from '../types';

export const CANVAS_MIN_ZOOM = 0.35;
export const CANVAS_MAX_ZOOM = 2.5;
// react-zoom-pan-pinch multiplies a smooth wheel step by the device delta. A
// small step keeps ordinary mouse wheels and high-resolution trackpads on the
// same continuous scale without snapping to the bounds.
export const CANVAS_WHEEL_CONFIG = {
  step: 0.0008,
  excluded: ['no-zoom-scroll'],
};

export function zoomViewportAtPoint(
  viewport: WorkspaceViewport,
  point: { x: number; y: number },
  factor: number,
): WorkspaceViewport {
  const nextZoom = Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, viewport.zoom * factor));
  const canvasX = (point.x - viewport.x) / viewport.zoom;
  const canvasY = (point.y - viewport.y) / viewport.zoom;

  return {
    x: point.x - canvasX * nextZoom,
    y: point.y - canvasY * nextZoom,
    zoom: nextZoom,
  };
}
