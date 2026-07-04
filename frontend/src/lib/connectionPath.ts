import type { CanvasPanelLayout } from './panelLayout';

export function getConnectionEdgePoint(
  sourceLayout: CanvasPanelLayout,
  targetLayout: CanvasPanelLayout,
  isSource: boolean
) {
  const layout = isSource ? sourceLayout : targetLayout;
  const otherLayout = isSource ? targetLayout : sourceLayout;
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  const otherCenterX = otherLayout.x + otherLayout.width / 2;
  const otherCenterY = otherLayout.y + otherLayout.height / 2;
  const dx = otherCenterX - centerX;
  const dy = otherCenterY - centerY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0
      ? { x: layout.x + layout.width, y: centerY, side: 'right' as const }
      : { x: layout.x, y: centerY, side: 'left' as const };
  }

  return dy > 0
    ? { x: centerX, y: layout.y + layout.height, side: 'bottom' as const }
    : { x: centerX, y: layout.y, side: 'top' as const };
}

export function generateConnectionPath(
  source: ReturnType<typeof getConnectionEdgePoint>,
  target: ReturnType<typeof getConnectionEdgePoint>
) {
  const curvature = 80;
  let sourceControlX = source.x;
  let sourceControlY = source.y;
  let targetControlX = target.x;
  let targetControlY = target.y;

  if (source.side === 'right') sourceControlX += curvature;
  if (source.side === 'left') sourceControlX -= curvature;
  if (source.side === 'bottom') sourceControlY += curvature;
  if (source.side === 'top') sourceControlY -= curvature;
  if (target.side === 'right') targetControlX += curvature;
  if (target.side === 'left') targetControlX -= curvature;
  if (target.side === 'bottom') targetControlY += curvature;
  if (target.side === 'top') targetControlY -= curvature;

  return `M ${source.x} ${source.y} C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${target.x} ${target.y}`;
}
