'use client';

import React, { useMemo } from 'react';
import type { CanvasPanelLayout, PanelConnection } from '@/lib/storage';

interface ConnectionLinesProps {
  connections: PanelConnection[];
  panelLayouts: Record<string, CanvasPanelLayout>;
  animatingConnectionIds?: Set<string>;
  panelTitles?: Record<string, string>;
}

// Calculate the best edge point for a connection line
function getEdgePoint(
  sourceLayout: CanvasPanelLayout,
  targetLayout: CanvasPanelLayout,
  isSource: boolean
): { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' } {
  const layout = isSource ? sourceLayout : targetLayout;
  const otherLayout = isSource ? targetLayout : sourceLayout;

  // Calculate centers
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  const otherCenterX = otherLayout.x + otherLayout.width / 2;
  const otherCenterY = otherLayout.y + otherLayout.height / 2;

  // Determine which edge to connect from based on relative position
  const dx = otherCenterX - centerX;
  const dy = otherCenterY - centerY;

  // Use horizontal connection if panels are more side-by-side
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > 0) {
      // Target is to the right
      return { x: layout.x + layout.width, y: centerY, side: 'right' };
    } else {
      // Target is to the left
      return { x: layout.x, y: centerY, side: 'left' };
    }
  } else {
    if (dy > 0) {
      // Target is below
      return { x: centerX, y: layout.y + layout.height, side: 'bottom' };
    } else {
      // Target is above
      return { x: centerX, y: layout.y, side: 'top' };
    }
  }
}

// Generate a smooth bezier curve path between two points
function generatePath(
  source: { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' },
  target: { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' }
): string {
  const curvature = 80;

  // Calculate control points based on edge sides
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
  // Generate paths for all valid connections
  const paths = useMemo(() => {
    return connections
      .map((conn) => {
        const sourceLayout = panelLayouts[conn.sourceId];
        const targetLayout = panelLayouts[conn.targetId];

        if (!sourceLayout || !targetLayout) return null;

        const sourcePoint = getEdgePoint(sourceLayout, targetLayout, true);
        const targetPoint = getEdgePoint(sourceLayout, targetLayout, false);
        const path = generatePath(sourcePoint, targetPoint);

        // Get source panel title for tooltip
        const sourceTitle = panelTitles[conn.sourceId] || conn.sourceId;

        return {
          id: conn.id,
          path,
          isAnimating: animatingConnectionIds.has(conn.id),
          sourceTitle,
        };
      })
      .filter(Boolean) as {
        id: string;
        path: string;
        isAnimating: boolean;
        sourceTitle: string;
      }[];
  }, [connections, panelLayouts, animatingConnectionIds, panelTitles]);

  // Calculate SVG bounds to cover all connections with padding
  // Must be before early return to satisfy React hooks rules
  const svgBounds = useMemo(() => {
    let minX = 0, minY = 0, maxX = 10000, maxY = 10000;
    for (const conn of connections) {
      const sourceLayout = panelLayouts[conn.sourceId];
      const targetLayout = panelLayouts[conn.targetId];
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
        {/* Arrow marker for line ends */}
        <marker
          id="connection-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M0,0 L0,8 L8,4 z"
            fill="oklch(0.6 0.12 75 / 0.5)"
          />
        </marker>
      </defs>

      {paths.map(({ id, path, isAnimating, sourceTitle }) => (
        <g key={id}>
          {/* Invisible wider path for easier hover */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth="16"
            style={{ pointerEvents: 'stroke', cursor: 'help' }}
          >
            <title>Created from: {sourceTitle}</title>
          </path>
          {/* Visible path */}
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
