'use client';

import { useMemo } from 'react';

type CanvasPanelLayout = { x: number; y: number; width: number; height: number };
type PanelConnection = { id: string; sourceId: string; targetId: string };

interface ConnectionLinesProps {
  connections: PanelConnection[];
  panelLayouts: Record<string, CanvasPanelLayout>;
  animatingConnectionIds?: Set<string>;
  panelTitles?: Record<string, string>;
}

function getEdgePoint(
  sourceLayout: CanvasPanelLayout,
  targetLayout: CanvasPanelLayout,
  isSource: boolean
): { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' } {
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
      ? { x: layout.x + layout.width, y: centerY, side: 'right' }
      : { x: layout.x, y: centerY, side: 'left' };
  }

  return dy > 0
    ? { x: centerX, y: layout.y + layout.height, side: 'bottom' }
    : { x: centerX, y: layout.y, side: 'top' };
}

function generatePath(
  source: { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' },
  target: { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' }
): string {
  const curvature = 80;
  let sourceControlX = source.x;
  let sourceControlY = source.y;
  let targetControlX = target.x;
  let targetControlY = target.y;

  switch (source.side) {
    case 'right':
      sourceControlX += curvature;
      break;
    case 'left':
      sourceControlX -= curvature;
      break;
    case 'bottom':
      sourceControlY += curvature;
      break;
    case 'top':
      sourceControlY -= curvature;
      break;
  }

  switch (target.side) {
    case 'right':
      targetControlX += curvature;
      break;
    case 'left':
      targetControlX -= curvature;
      break;
    case 'bottom':
      targetControlY += curvature;
      break;
    case 'top':
      targetControlY -= curvature;
      break;
  }

  return `M ${source.x} ${source.y} C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${target.x} ${target.y}`;
}

export function ConnectionLines({
  connections,
  panelLayouts,
  animatingConnectionIds = new Set(),
  panelTitles = {},
}: ConnectionLinesProps) {
  const paths = useMemo(() => {
    return connections
      .map((connection) => {
        const sourceLayout = panelLayouts[connection.sourceId];
        const targetLayout = panelLayouts[connection.targetId];

        if (!sourceLayout || !targetLayout) return null;

        const sourcePoint = getEdgePoint(sourceLayout, targetLayout, true);
        const targetPoint = getEdgePoint(sourceLayout, targetLayout, false);
        return {
          id: connection.id,
          path: generatePath(sourcePoint, targetPoint),
          isAnimating: animatingConnectionIds.has(connection.id),
          sourceTitle: panelTitles[connection.sourceId] || connection.sourceId,
        };
      })
      .filter(Boolean) as Array<{
      id: string;
      path: string;
      isAnimating: boolean;
      sourceTitle: string;
    }>;
  }, [animatingConnectionIds, connections, panelLayouts, panelTitles]);

  const svgBounds = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = 10000;
    let maxY = 10000;

    for (const connection of connections) {
      const sourceLayout = panelLayouts[connection.sourceId];
      const targetLayout = panelLayouts[connection.targetId];
      if (sourceLayout) {
        minX = Math.min(minX, sourceLayout.x - 200);
        minY = Math.min(minY, sourceLayout.y - 200);
        maxX = Math.max(maxX, sourceLayout.x + sourceLayout.width + 200);
        maxY = Math.max(maxY, sourceLayout.y + sourceLayout.height + 200);
      }
      if (targetLayout) {
        minX = Math.min(minX, targetLayout.x - 200);
        minY = Math.min(minY, targetLayout.y - 200);
        maxX = Math.max(maxX, targetLayout.x + targetLayout.width + 200);
        maxY = Math.max(maxY, targetLayout.y + targetLayout.height + 200);
      }
    }

    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [connections, panelLayouts]);

  if (paths.length === 0) return null;

  return (
    <svg
      className="connection-lines absolute"
      style={{
        left: svgBounds.minX,
        top: svgBounds.minY,
        width: svgBounds.width,
        height: svgBounds.height,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
      viewBox={`${svgBounds.minX} ${svgBounds.minY} ${svgBounds.width} ${svgBounds.height}`}
    >
      <defs>
        <marker id="connection-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,8 L8,4 z" fill="oklch(0.6 0.12 75 / 0.5)" />
        </marker>
      </defs>

      {paths.map(({ id, path, isAnimating, sourceTitle }) => (
        <g key={id}>
          <path d={path} fill="none" stroke="transparent" strokeWidth="16" style={{ pointerEvents: 'stroke', cursor: 'help' }}>
            <title>Created from: {sourceTitle}</title>
          </path>
          <path
            d={path}
            className={`connection-line ${isAnimating ? 'connection-entering' : ''}`}
            fill="none"
            stroke="oklch(0.6 0.12 75 / 0.3)"
            strokeWidth="2"
            strokeDasharray="6,4"
            markerEnd="url(#connection-arrow)"
            style={{ pointerEvents: 'none' }}
          />
        </g>
      ))}
    </svg>
  );
}
