import { describe, expect, it } from 'vitest';
import {
  PANEL_GAP,
  buildPanelLayouts,
  collectLayouts,
  getGroupBounds,
  getLayoutsBounds,
  hasOverlappingPanels,
  inferPanelLayout,
  layoutOverlapsBounds,
  resolveCollisions,
  resolveVisibleLayoutCollisions,
  type LayoutMap,
} from './panelLayout';
import type { WorkspacePanel, WorkspaceState } from '../types';

function panel(id: string, extra: Partial<WorkspacePanel> = {}): WorkspacePanel {
  return { id, type: 'markdown', content: '', ...extra } as WorkspacePanel;
}

describe('inferPanelLayout', () => {
  it('uses explicit layout values when present', () => {
    const p = panel('a', { layout: { x: 10, y: 20, width: 100, height: 50 } });
    expect(inferPanelLayout(p, 0)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('falls back to a grid position based on index', () => {
    expect(inferPanelLayout(panel('a'), 0)).toEqual({ x: 32, y: 32, width: 360, height: 220 });
    // index 4 => column 1, row 1
    expect(inferPanelLayout(panel('e'), 4)).toEqual({ x: 32 + 392, y: 32 + 252, width: 360, height: 220 });
  });

  it('gives tables a taller default height', () => {
    const t = panel('t', { type: 'table', columns: [], rows: [] });
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
    const group = { id: 'g', panelIds: ['a', 'b'] } as WorkspaceState['groups'][number];
    const layouts: LayoutMap = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 200, y: 0, width: 100, height: 100 },
    };
    expect(getGroupBounds(group, layouts, 10)).toEqual({ x: -10, y: -10, width: 320, height: 120 });
  });

  it('can exclude a panel from the bounds', () => {
    const group = { id: 'g', panelIds: ['a', 'b'] } as WorkspaceState['groups'][number];
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
    const layouts = buildPanelLayouts([panel('a'), panel('b')]);
    expect(Object.keys(layouts)).toEqual(['a', 'b']);
  });
});
