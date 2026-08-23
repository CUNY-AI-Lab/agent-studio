import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, zoomViewportAtPoint } from './canvasViewport';

describe('zoomViewportAtPoint', () => {
  it('keeps the canvas point under the cursor fixed while zooming', () => {
    const viewport = { x: -120, y: 40, zoom: 1 };
    const point = { x: 420, y: 260 };
    const next = zoomViewportAtPoint(viewport, point, 1.5);
    const canvasPointBefore = {
      x: (point.x - viewport.x) / viewport.zoom,
      y: (point.y - viewport.y) / viewport.zoom,
    };
    const canvasPointAfter = {
      x: (point.x - next.x) / next.zoom,
      y: (point.y - next.y) / next.zoom,
    };

    expect(next.zoom).toBe(1.5);
    expect(canvasPointAfter.x).toBeCloseTo(canvasPointBefore.x);
    expect(canvasPointAfter.y).toBeCloseTo(canvasPointBefore.y);
  });

  it('uses the same bounds as the interactive canvas', () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    expect(zoomViewportAtPoint(viewport, { x: 0, y: 0 }, 100).zoom).toBe(CANVAS_MAX_ZOOM);
    expect(zoomViewportAtPoint(viewport, { x: 0, y: 0 }, 0.001).zoom).toBe(CANVAS_MIN_ZOOM);
  });
});
