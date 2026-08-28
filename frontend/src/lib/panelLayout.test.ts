import { describe, expect, it } from 'vitest';
import {
  PANEL_GAP,
  buildPanelLayouts,
  collectLayouts,
  findOpenPanelPosition,
  getGroupBounds,
  getLayoutsBounds,
  hasOverlappingPanels,
  inferPanelLayout,
  layoutOverlapsBounds,
  resolveCollisions,
  resolveVisibleLayoutCollisions,
  rectsOverlapWithGap,
  type LayoutMap,
} from './panelLayout';
import type { MarkdownPanel, TablePanel, WorkspaceState } from '../types';

function markdownPanel(id: string, extra: Partial<MarkdownPanel> = {}): MarkdownPanel {
  return { id, type: 'markdown', content: '', ...extra };
}

function tablePanel(id: string, extra: Partial<TablePanel> = {}): TablePanel {
  return { id, type: 'table', columns: [], rows: [], ...extra };
}

describe('inferPanelLayout', () => {
  it('uses explicit layout values when present', () => {
    const p = markdownPanel('a', { layout: { x: 10, y: 20, width: 100, height: 50 } });
    expect(inferPanelLayout(p, 0)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('falls back to a grid position based on index', () => {
    expect(inferPanelLayout(markdownPanel('a'), 0)).toEqual({ x: 32, y: 32, width: 360, height: 220 });
    // index 4 => column 1, row 1
    expect(inferPanelLayout(markdownPanel('e'), 4)).toEqual({ x: 32 + 392, y: 32 + 252, width: 360, height: 220 });
  });

  it('gives tables a taller default height', () => {
    const t = tablePanel('t');
    expect(inferPanelLayout(t, 0).height).toBe(300);
  });
});

describe('hasOverlappingPanels', () => {
  it('detects overlap within the gap', () => {
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 50, y: 50, width: 100, height: 100 },
    };
    expect(hasOverlappingPanels(layouts)).toBe(true);
  });

  it('treats panels separated by more than the gap as non-overlapping', () => {
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 100 + PANEL_GAP + 1, y: 0, width: 100, height: 100 },
    };
    expect(hasOverlappingPanels(layouts)).toBe(false);
  });
});

describe('rectsOverlapWithGap', () => {
  const left = { x: 0, y: 0, width: 100, height: 100 };

  it('treats the explicit gap boundary as non-overlapping', () => {
    expect(rectsOverlapWithGap(left, { x: 120, y: 0, width: 100, height: 100 }, 20)).toBe(false);
    expect(rectsOverlapWithGap(left, { x: 119, y: 0, width: 100, height: 100 }, 20)).toBe(true);
  });

  it('uses the supplied gap rather than the canvas default', () => {
    expect(rectsOverlapWithGap(left, { x: 117, y: 0, width: 100, height: 100 }, 16)).toBe(false);
  });
});

describe('resolveCollisions', () => {
  it('separates two overlapping panels so no overlap remains', () => {
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 40, y: 10, width: 100, height: 100 },
    };
    const resolved = resolveCollisions(layouts, new Set());
    expect(hasOverlappingPanels(resolved)).toBe(false);
  });

  it('leaves a fixed panel in place while moving the other', () => {
    const layouts: LayoutMap = {
      fixed: { x: 0, y: 0, width: 100, height: 100 },
      moving: { x: 30, y: 30, width: 100, height: 100 },
    };
    resolveCollisions(layouts, new Set(['fixed']));
    expect(layouts.fixed).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(hasOverlappingPanels(layouts)).toBe(false);
  });

  it('does not move two mutually-fixed panels even if overlapping', () => {
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 20, y: 20, width: 100, height: 100 },
    };
    resolveCollisions(layouts, new Set(['a', 'b']));
    expect(layouts.a).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(layouts.b).toEqual({ x: 20, y: 20, width: 100, height: 100 });
  });
});

describe('collectLayouts', () => {
  it('returns cloned copies for the requested ids only', () => {
    const source: LayoutMap = {
      a: { x: 1, y: 2, width: 3, height: 4 },
      b: { x: 5, y: 6, width: 7, height: 8 },
    };
    const picked = collectLayouts(source, ['a']);
    expect(Object.keys(picked)).toEqual(['a']);
    expect(picked.a).not.toBe(source.a);
    expect(picked.a).toEqual(source.a);
  });
});

describe('resolveVisibleLayoutCollisions', () => {
  it('returns the untouched visible subset when nothing overlaps', () => {
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 50, height: 50 },
      b: { x: 500, y: 500, width: 50, height: 50 },
    };
    const result = resolveVisibleLayoutCollisions(layouts, ['a', 'b'], new Set());
    expect(hasOverlappingPanels(result)).toBe(false);
    expect(result.a).toEqual(layouts.a);
  });
});

describe('getLayoutsBounds', () => {
  it('returns null for an empty list', () => {
    expect(getLayoutsBounds([])).toBeNull();
  });

  it('computes the bounding box across layouts', () => {
    expect(
      getLayoutsBounds([
        { x: 10, y: 10, width: 40, height: 40 },
        { x: 100, y: 60, width: 20, height: 20 },
      ])
    ).toEqual({ x: 10, y: 10, width: 110, height: 70 });
  });
});

describe('getGroupBounds', () => {
  it('applies padding around the member layouts', () => {
    const group: WorkspaceState['groups'][number] = { id: 'g', panelIds: ['a', 'b'] };
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 200, y: 0, width: 100, height: 100 },
    };
    expect(getGroupBounds(group, layouts, 10)).toEqual({ x: -10, y: -10, width: 320, height: 120 });
  });

  it('can exclude a panel from the bounds', () => {
    const group: WorkspaceState['groups'][number] = { id: 'g', panelIds: ['a', 'b'] };
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 200, y: 0, width: 100, height: 100 },
    };
    expect(getGroupBounds(group, layouts, 0, 'b')).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('layoutOverlapsBounds', () => {
  it('reports overlap with an intersecting box', () => {
    const layout = { x: 0, y: 0, width: 100, height: 100 };
    expect(layoutOverlapsBounds(layout, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(layoutOverlapsBounds(layout, { x: 500, y: 500, width: 10, height: 10 })).toBe(false);
  });
});

describe('buildPanelLayouts', () => {
  it('keys layouts by panel id', () => {
    const layouts = buildPanelLayouts([markdownPanel('a'), markdownPanel('b')]);
    expect(Object.keys(layouts)).toEqual(['a', 'b']);
  });
});

describe('findOpenPanelPosition', () => {
  const viewportSize = { width: 1000, height: 700 };

  it('places an unassociated tile at the current viewport center', () => {
    expect(findOpenPanelPosition([], 360, 220, { x: 0, y: 0, zoom: 1 }, viewportSize)).toEqual({
      x: 320,
      y: 240,
    });
  });

  it('follows panned and zoomed viewports into negative flow coordinates', () => {
    expect(findOpenPanelPosition([], 360, 220, { x: 600, y: 400, zoom: 1.25 }, viewportSize)).toEqual({
      x: -260,
      y: -150,
    });
  });

  it('searches outward from the viewport center when the center is occupied', () => {
    const occupied = [{ x: 320, y: 240, width: 360, height: 220 }];
    const position = findOpenPanelPosition(occupied, 360, 220, { x: 0, y: 0, zoom: 1 }, viewportSize);
    expect(position).not.toEqual({ x: 320, y: 240 });
    expect(
      occupied.some((layout) => layout.x === position.x && layout.y === position.y),
    ).toBe(false);
    expect(position.x !== 320 || position.y !== 240).toBe(true);
  });
});
