import type { WorkspacePanel, WorkspaceState, WorkspaceViewport } from '../types';

export const PANEL_GAP = 20;

export function inferPanelLayout(panel: WorkspacePanel, index: number) {
  const width = panel.layout?.width ?? 360;
  const height = panel.layout?.height ?? (panel.type === 'table' ? 300 : 220);
  const x = panel.layout?.x ?? 32 + (index % 3) * 392;
  const y = panel.layout?.y ?? 32 + Math.floor(index / 3) * 252;
  return { x, y, width, height };
}

export type CanvasPanelLayout = ReturnType<typeof inferPanelLayout>;
export type LayoutMap = Record<string, CanvasPanelLayout>;

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasViewportSize {
  width: number;
  height: number;
}

export interface PanelPosition {
  x: number;
  y: number;
}

export function buildPanelLayouts(panels: WorkspacePanel[]): Record<string, CanvasPanelLayout> {
  return Object.fromEntries(
    panels.map((panel, index) => [panel.id, inferPanelLayout(panel, index)])
  );
}

export function rectsOverlapWithGap(
  left: CanvasRect,
  right: CanvasRect,
  gap: number,
): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

function hasLayoutOverlap(
  x: number,
  y: number,
  width: number,
  height: number,
  layouts: CanvasPanelLayout[],
): boolean {
  const candidate = { x, y, width, height };
  return layouts.some((rect) => rectsOverlapWithGap(candidate, rect, PANEL_GAP));
}

/**
 * Find an open position centered on the user's current viewport.
 *
 * React Flow's viewport is a screen-space translation plus zoom. Converting
 * the viewport center back into flow coordinates keeps a new tile near the
 * user's current working area even after they pan into negative coordinates.
 * The expanding square search has no canvas boundary: a finite set of finite
 * rectangles always leaves an open position eventually.
 */
export function findOpenPanelPosition(
  occupiedLayouts: CanvasPanelLayout[],
  width: number,
  height: number,
  viewport: WorkspaceViewport,
  viewportSize: CanvasViewportSize,
): PanelPosition {
  const zoom = Math.max(viewport.zoom, Number.EPSILON);
  const centerX = (viewportSize.width / 2 - viewport.x) / zoom;
  const centerY = (viewportSize.height / 2 - viewport.y) / zoom;
  const startX = centerX - width / 2;
  const startY = centerY - height / 2;

  if (!hasLayoutOverlap(startX, startY, width, height, occupiedLayouts)) {
    return { x: startX, y: startY };
  }

  const step = Math.max(PANEL_GAP, 48);
  for (let ring = 1; ; ring += 1) {
    for (let offset = -ring; offset <= ring; offset += 1) {
      const candidates = [
        [ring, offset],
        [-ring, offset],
        [offset, ring],
        [offset, -ring],
      ];
      for (const [xOffset, yOffset] of candidates) {
        const x = startX + xOffset * step;
        const y = startY + yOffset * step;
        if (!hasLayoutOverlap(x, y, width, height, occupiedLayouts)) {
          return { x, y };
        }
      }
    }
  }
}

export function collectLayouts(layouts: LayoutMap, panelIds: Iterable<string>) {
  const visibleLayouts: LayoutMap = {};
  for (const panelId of panelIds) {
    const layout = layouts[panelId];
    if (layout) {
      visibleLayouts[panelId] = { ...layout };
    }
  }
  return visibleLayouts;
}

/**
 * Return only panel layouts whose geometry differs from the edit's baseline.
 * Layout patches are merged per panel on the server, so sending this delta
 * keeps an edit from overwriting a concurrent change to another tile.
 */
export function computePanelLayoutsDelta(previous: LayoutMap, next: LayoutMap) {
  return Object.fromEntries(
    Object.entries(next)
      .filter(([panelId, layout]) => {
        const before = previous[panelId];
        return (
          !before ||
          before.x !== layout.x ||
          before.y !== layout.y ||
          before.width !== layout.width ||
          before.height !== layout.height
        );
      })
      .map(([panelId, layout]) => [panelId, { ...layout }]),
  );
}

export function hasOverlappingPanels(layouts: LayoutMap): boolean {
  const panelIds = Object.keys(layouts);
  for (let index = 0; index < panelIds.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
      const left = layouts[panelIds[index]];
      const right = layouts[panelIds[nextIndex]];
      if (rectsOverlapWithGap(left, right, PANEL_GAP)) return true;
    }
  }
  return false;
}

export function resolveCollisions(
  layouts: LayoutMap,
  fixedPanelIds: Set<string>,
  affectedPanelIds?: Set<string>,
): LayoutMap {
  const panelIds = Object.keys(layouts);
  const affectedIds = affectedPanelIds ? new Set(affectedPanelIds) : null;

  for (let iteration = 0; iteration < 15; iteration += 1) {
    let hadCollision = false;

    for (let index = 0; index < panelIds.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
        const leftId = panelIds[index];
        const rightId = panelIds[nextIndex];
        const left = layouts[leftId];
        const right = layouts[rightId];

        if (!rectsOverlapWithGap(left, right, PANEL_GAP)) continue;
        if (affectedIds && !affectedIds.has(leftId) && !affectedIds.has(rightId)) continue;
        if (fixedPanelIds.has(leftId) && fixedPanelIds.has(rightId)) continue;

        hadCollision = true;

        let movedId: string;
        let fixedId: string;
        if (fixedPanelIds.has(leftId)) {
          movedId = rightId;
          fixedId = leftId;
        } else if (fixedPanelIds.has(rightId)) {
          movedId = leftId;
          fixedId = rightId;
        } else if (right.y > left.y || (right.y === left.y && right.x > left.x)) {
          movedId = rightId;
          fixedId = leftId;
        } else {
          movedId = leftId;
          fixedId = rightId;
        }

        const fixed = layouts[fixedId];
        const moved = layouts[movedId];
        const fixedCenterX = fixed.x + fixed.width / 2;
        const fixedCenterY = fixed.y + fixed.height / 2;
        const movedCenterX = moved.x + moved.width / 2;
        const movedCenterY = moved.y + moved.height / 2;

        const pushRight = fixed.x + fixed.width + PANEL_GAP - moved.x;
        const pushLeft = moved.x + moved.width + PANEL_GAP - fixed.x;
        const pushDown = fixed.y + fixed.height + PANEL_GAP - moved.y;
        const pushUp = moved.y + moved.height + PANEL_GAP - fixed.y;
        const pushX = movedCenterX >= fixedCenterX ? pushRight : pushLeft;
        const pushY = movedCenterY >= fixedCenterY ? pushDown : pushUp;

        if (pushX > 0 && pushX <= pushY) {
          const dx = movedCenterX >= fixedCenterX ? pushRight : -pushLeft;
          layouts[movedId] = { ...moved, x: moved.x + dx };
          affectedIds?.add(movedId);
        } else if (pushY > 0) {
          const dy = movedCenterY >= fixedCenterY ? pushDown : -pushUp;
          layouts[movedId] = { ...moved, y: moved.y + dy };
          affectedIds?.add(movedId);
        }
      }
    }

    if (!hadCollision) break;
  }

  return layouts;
}

export function resolveVisibleLayoutCollisions(
  layouts: Record<string, CanvasPanelLayout>,
  visiblePanelIds: Iterable<string>,
  fixedPanelIds: Set<string>,
  affectedPanelIds?: Set<string>,
): LayoutMap {
  const visibleLayouts = collectLayouts(layouts, visiblePanelIds);
  return hasOverlappingPanels(visibleLayouts)
    ? resolveCollisions(visibleLayouts, fixedPanelIds, affectedPanelIds)
    : visibleLayouts;
}

export function getLayoutsBounds(layouts: CanvasPanelLayout[]) {
  if (layouts.length === 0) return null;
  const minX = Math.min(...layouts.map((layout) => layout.x));
  const minY = Math.min(...layouts.map((layout) => layout.y));
  const maxX = Math.max(...layouts.map((layout) => layout.x + layout.width));
  const maxY = Math.max(...layouts.map((layout) => layout.y + layout.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function getGroupBounds(
  group: WorkspaceState['groups'][number],
  layouts: LayoutMap,
  padding: number,
  excludedPanelId?: string
) {
  const groupLayouts = group.panelIds
    .filter((groupPanelId) => groupPanelId !== excludedPanelId)
    .map((groupPanelId) => layouts[groupPanelId])
    .filter((layout): layout is CanvasPanelLayout => layout !== undefined);

  if (groupLayouts.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  groupLayouts.forEach((layout) => {
    minX = Math.min(minX, layout.x);
    minY = Math.min(minY, layout.y);
    maxX = Math.max(maxX, layout.x + layout.width);
    maxY = Math.max(maxY, layout.y + layout.height);
  });

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function layoutOverlapsBounds(
  layout: CanvasPanelLayout,
  bounds: { x: number; y: number; width: number; height: number }
) {
  return !(
    layout.x + layout.width < bounds.x ||
    layout.x > bounds.x + bounds.width ||
    layout.y + layout.height < bounds.y ||
    layout.y > bounds.y + bounds.height
  );
}
