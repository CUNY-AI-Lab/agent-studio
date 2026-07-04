import type { WorkspacePanel, WorkspaceState } from '../types';

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

export function buildPanelLayouts(panels: WorkspacePanel[]): Record<string, CanvasPanelLayout> {
  return Object.fromEntries(
    panels.map((panel, index) => [panel.id, inferPanelLayout(panel, index)])
  );
}

export function collectLayouts(layouts: Record<string, CanvasPanelLayout>, panelIds: Iterable<string>): LayoutMap {
  const visibleLayouts: LayoutMap = {};
  for (const panelId of panelIds) {
    const layout = layouts[panelId];
    if (layout) {
      visibleLayouts[panelId] = { ...layout };
    }
  }
  return visibleLayouts;
}

export function hasOverlappingPanels(layouts: LayoutMap): boolean {
  const panelIds = Object.keys(layouts);
  for (let index = 0; index < panelIds.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
      const left = layouts[panelIds[index]];
      const right = layouts[panelIds[nextIndex]];
      const overlaps = !(
        left.x + left.width + PANEL_GAP <= right.x ||
        right.x + right.width + PANEL_GAP <= left.x ||
        left.y + left.height + PANEL_GAP <= right.y ||
        right.y + right.height + PANEL_GAP <= left.y
      );
      if (overlaps) return true;
    }
  }
  return false;
}

export function resolveCollisions(layouts: LayoutMap, fixedPanelIds: Set<string>): LayoutMap {
  const panelIds = Object.keys(layouts);
  const rectsOverlap = (left: CanvasPanelLayout, right: CanvasPanelLayout) => !(
    left.x + left.width + PANEL_GAP <= right.x ||
    right.x + right.width + PANEL_GAP <= left.x ||
    left.y + left.height + PANEL_GAP <= right.y ||
    right.y + right.height + PANEL_GAP <= left.y
  );

  for (let iteration = 0; iteration < 15; iteration += 1) {
    let hadCollision = false;

    for (let index = 0; index < panelIds.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
        const leftId = panelIds[index];
        const rightId = panelIds[nextIndex];
        const left = layouts[leftId];
        const right = layouts[rightId];

        if (!rectsOverlap(left, right)) continue;
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
        } else if (pushY > 0) {
          const dy = movedCenterY >= fixedCenterY ? pushDown : -pushUp;
          layouts[movedId] = { ...moved, y: moved.y + dy };
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
  fixedPanelIds: Set<string>
): LayoutMap {
  const visibleLayouts = collectLayouts(layouts, visiblePanelIds);
  return hasOverlappingPanels(visibleLayouts)
    ? resolveCollisions(visibleLayouts, fixedPanelIds)
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
    .filter(Boolean) as CanvasPanelLayout[];

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
