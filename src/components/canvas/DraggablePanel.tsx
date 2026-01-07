'use client';

import React, { useState, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { CanvasPanelLayout } from '@/lib/storage';

interface DraggablePanelProps {
  id: string;
  layout: CanvasPanelLayout;
  title: string;
  type: string;
  children: React.ReactNode;
  scale: number;
  zIndex?: number;
  onLayoutChange: (id: string, layout: Partial<CanvasPanelLayout>) => void;
  onDragStart?: (id: string) => void;
  onDragEnd: (id: string) => void;
  onFocus?: (id: string) => void;
  onOpenMenu?: (id: string) => void;
  isMenuOpen?: boolean;
  menuContent?: React.ReactNode;
  // Selection
  isSelected?: boolean;
  onPanelClick?: (id: string, e: React.MouseEvent) => void;
  onPanelDoubleClick?: (id: string, e: React.MouseEvent) => void;
  isAnimating?: boolean;
  // Group dragging - disables position transitions when another panel in the same group is being dragged
  isInDraggingGroup?: boolean;
  onHoverChange?: (id: string | null) => void;
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export function DraggablePanel({
  id,
  layout,
  title,
  type,
  children,
  scale,
  zIndex,
  onLayoutChange,
  onDragStart,
  onDragEnd,
  onFocus,
  onOpenMenu,
  isMenuOpen,
  menuContent,
  isSelected,
  onPanelClick,
  onPanelDoubleClick,
  isAnimating,
  isInDraggingGroup,
  onHoverChange,
}: DraggablePanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeCorner, setResizeCorner] = useState<ResizeCorner | null>(null);
  const [didMove, setDidMove] = useState(false);

  const dragStartRef = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0, layoutX: 0, layoutY: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Handle drag start on header
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.panel-menu-trigger') ||
        (e.target as HTMLElement).closest('.panel-menu')) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    setDidMove(false);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      layoutX: layout.x,
      layoutY: layout.y,
    };

    onDragStart?.(id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [layout.x, layout.y, id, onDragStart]);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - dragStartRef.current.x) / scale;
    const dy = (e.clientY - dragStartRef.current.y) / scale;

    // Check if we've moved more than 5px (to distinguish click from drag)
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 5) {
      setDidMove(true);
    }

    onLayoutChange(id, {
      x: dragStartRef.current.layoutX + dx,
      y: dragStartRef.current.layoutY + dy,
    });
  }, [isDragging, scale, id, onLayoutChange]);

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    e.preventDefault();
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onDragEnd(id);

    // Reset didMove after a short delay to allow click events to check it first
    setTimeout(() => setDidMove(false), 0);
  }, [isDragging, id, onDragEnd]);

  // Handle resize start
  const handleResizeStart = useCallback((e: React.PointerEvent, corner: ResizeCorner) => {
    e.preventDefault();
    e.stopPropagation();

    setIsResizing(true);
    setResizeCorner(corner);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: layout.width,
      height: layout.height,
      layoutX: layout.x,
      layoutY: layout.y,
    };

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [layout]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!isResizing || !resizeCorner) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - resizeStartRef.current.x) / scale;
    const dy = (e.clientY - resizeStartRef.current.y) / scale;

    const minWidth = 200;
    const minHeight = 150;

    let newX = resizeStartRef.current.layoutX;
    let newY = resizeStartRef.current.layoutY;
    let newWidth = resizeStartRef.current.width;
    let newHeight = resizeStartRef.current.height;

    // Handle each corner correctly - anchor opposite corner
    switch (resizeCorner) {
      case 'se':
        newWidth = Math.max(minWidth, resizeStartRef.current.width + dx);
        newHeight = Math.max(minHeight, resizeStartRef.current.height + dy);
        break;
      case 'sw':
        newWidth = Math.max(minWidth, resizeStartRef.current.width - dx);
        newHeight = Math.max(minHeight, resizeStartRef.current.height + dy);
        newX = resizeStartRef.current.layoutX + resizeStartRef.current.width - newWidth;
        break;
      case 'ne':
        newWidth = Math.max(minWidth, resizeStartRef.current.width + dx);
        newHeight = Math.max(minHeight, resizeStartRef.current.height - dy);
        newY = resizeStartRef.current.layoutY + resizeStartRef.current.height - newHeight;
        break;
      case 'nw':
        newWidth = Math.max(minWidth, resizeStartRef.current.width - dx);
        newHeight = Math.max(minHeight, resizeStartRef.current.height - dy);
        newX = resizeStartRef.current.layoutX + resizeStartRef.current.width - newWidth;
        newY = resizeStartRef.current.layoutY + resizeStartRef.current.height - newHeight;
        break;
    }

    onLayoutChange(id, {
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight,
    });
  }, [isResizing, resizeCorner, scale, id, onLayoutChange]);

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!isResizing) return;

    e.preventDefault();
    setIsResizing(false);
    setResizeCorner(null);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onDragEnd(id);
  }, [isResizing, id, onDragEnd]);

  // Handle single click on panel - for selection
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    // Don't trigger if we were dragging
    if (didMove) return;
    // Only trigger on clickable areas
    if ((e.target as HTMLElement).closest('.no-zoom-scroll')) {
      onPanelClick?.(id, e);
    }
  }, [didMove, id, onPanelClick]);

  // Handle double-click on panel - for contextual chat
  const handleContentDoubleClick = useCallback((e: React.MouseEvent) => {
    // Don't trigger if we were dragging
    if (didMove) return;
    // Only trigger on clickable areas (same check as single click for consistency)
    if ((e.target as HTMLElement).closest('.no-zoom-scroll')) {
      e.stopPropagation();
      onPanelDoubleClick?.(id, e);
    }
  }, [didMove, id, onPanelDoubleClick]);

  return (
    <div
      ref={panelRef}
      className={cn(
        "artifact-card absolute flex flex-col",
        isDragging && "dragging",
        isResizing && "resizing",
        isSelected && "panel-selected",
        isAnimating && "panel-entering",
        isInDraggingGroup && "group-dragging"
      )}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        zIndex: zIndex ?? 1,
      }}
      onPointerDown={() => onFocus?.(id)}
      onPointerEnter={() => onHoverChange?.(id)}
      onPointerLeave={() => onHoverChange?.(null)}
      onClick={handleContentClick}
      onDoubleClick={handleContentDoubleClick}
    >
      {/* Drag handle header */}
      <div
        className="artifact-header cursor-grab active:cursor-grabbing"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onClick={(e) => {
          // If header was clicked without dragging, treat like panel click to trigger toolbar
          if (!didMove) {
            onPanelClick?.(id, e as unknown as React.MouseEvent);
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h3 className="truncate" title={title}>{title}</h3>
          <span className="artifact-type flex-shrink-0">{type}</span>
        </div>
        <div className="relative flex-shrink-0">
          <button
            className="panel-menu-trigger p-1 rounded hover:bg-white/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu?.(isMenuOpen ? '' : id);
            }}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
            </svg>
          </button>
          {isMenuOpen && menuContent && (
            <div
              className="panel-menu absolute right-0 top-full mt-1 w-40 bg-popover border border-border rounded-lg shadow-lg py-1 z-50"
              onClick={(e) => e.stopPropagation()}
            >
              {menuContent}
            </div>
          )}
        </div>
      </div>

      {/* Content area - no-zoom-scroll class excludes from canvas zoom via react-zoom-pan-pinch */}
      <div
        className="artifact-content flex-1 overflow-auto no-zoom-scroll"
        onWheel={(e) => e.stopPropagation()}
      >
        {children}
      </div>

      {/* Resize handles - corners only */}
      {['nw', 'ne', 'sw', 'se'].map((corner) => (
        <div
          key={corner}
          className={cn("resize-handle", corner)}
          onPointerDown={(e) => handleResizeStart(e, corner as ResizeCorner)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
      ))}
    </div>
  );
}
