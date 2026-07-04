'use client';

import { useState, useRef, useCallback } from 'react';
import { cn } from '../../lib/utils';
import {
  CANVAS_STEP,
  CANVAS_LARGE_STEP,
  CANVAS_RESIZE_STEP,
} from '../../lib/keyboardMap';

type CanvasPanelLayout = { x: number; y: number; width: number; height: number };

const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 150;

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
  isSelected?: boolean;
  onPanelClick?: (id: string, e: React.MouseEvent) => void;
  onPanelDoubleClick?: (id: string, e: React.MouseEvent) => void;
  /** Toggle selection from a keyboard interaction (Enter / Space on the tile). */
  onKeyboardSelect?: (id: string, additive: boolean) => void;
  /**
   * Whether this tile is the current roving-tabindex target. Exactly one tile
   * carries tabIndex=0 at a time; the rest are -1 so Tab lands once on the group
   * and arrow keys move focus/geometry from there.
   */
  isFocusTarget?: boolean;
  isAnimating?: boolean;
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
  onKeyboardSelect,
  isFocusTarget = true,
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

    setTimeout(() => setDidMove(false), 0);
  }, [isDragging, id, onDragEnd]);

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

    onLayoutChange(id, { x: newX, y: newY, width: newWidth, height: newHeight });
  }, [isResizing, resizeCorner, scale, id, onLayoutChange]);

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!isResizing) return;

    e.preventDefault();
    setIsResizing(false);
    setResizeCorner(null);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onDragEnd(id);
  }, [isResizing, id, onDragEnd]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    if (didMove) return;
    if ((e.target as HTMLElement).closest('.no-zoom-scroll')) {
      onPanelClick?.(id, e);
    }
  }, [didMove, id, onPanelClick]);

  const handleContentDoubleClick = useCallback((e: React.MouseEvent) => {
    if (didMove) return;
    if ((e.target as HTMLElement).closest('.no-zoom-scroll')) {
      e.stopPropagation();
      onPanelDoubleClick?.(id, e);
    }
  }, [didMove, id, onPanelDoubleClick]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Ignore keystrokes originating in the tile body (inputs, editable content,
    // the menu). The tile-level shortcuts only apply when the card chrome itself
    // holds focus.
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget) {
      if (
        target.closest('.artifact-content') ||
        target.closest('.panel-menu') ||
        target.closest('.panel-menu-trigger')
      ) {
        return;
      }
    }

    const key = e.key;

    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      onKeyboardSelect?.(id, e.metaKey || e.ctrlKey || e.shiftKey);
      return;
    }

    if ((key === 'm' || key === 'M') && (onOpenMenu || menuContent)) {
      e.preventDefault();
      onFocus?.(id);
      onOpenMenu?.(isMenuOpen ? '' : id);
      return;
    }

    let dx = 0;
    let dy = 0;
    if (key === 'ArrowLeft') dx = -1;
    else if (key === 'ArrowRight') dx = 1;
    else if (key === 'ArrowUp') dy = -1;
    else if (key === 'ArrowDown') dy = 1;
    else return;

    e.preventDefault();
    e.stopPropagation();
    onFocus?.(id);

    // Alt (Option) resizes from the SE corner; otherwise the tile moves. Shift
    // uses the larger step for coarse positioning.
    if (e.altKey) {
      const nextWidth = Math.max(MIN_PANEL_WIDTH, layout.width + dx * CANVAS_RESIZE_STEP);
      const nextHeight = Math.max(MIN_PANEL_HEIGHT, layout.height + dy * CANVAS_RESIZE_STEP);
      onLayoutChange(id, { width: nextWidth, height: nextHeight });
    } else {
      const step = e.shiftKey ? CANVAS_LARGE_STEP : CANVAS_STEP;
      onLayoutChange(id, {
        x: layout.x + dx * step,
        y: layout.y + dy * step,
      });
    }
    onDragEnd(id);
  }, [
    id,
    isMenuOpen,
    layout.height,
    layout.width,
    layout.x,
    layout.y,
    menuContent,
    onDragEnd,
    onFocus,
    onKeyboardSelect,
    onLayoutChange,
    onOpenMenu,
  ]);

  const showMenuTrigger = Boolean(onOpenMenu || menuContent);

  return (
    <div
      role="group"
      aria-label={`${title} (${type} tile)`}
      aria-pressed={isSelected}
      tabIndex={isFocusTarget ? 0 : -1}
      data-panel-id={id}
      className={cn(
        'artifact-card absolute flex flex-col',
        isDragging && 'dragging',
        isResizing && 'resizing',
        isSelected && 'panel-selected',
        isAnimating && 'panel-entering',
        isInDraggingGroup && 'group-dragging'
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
      onFocus={() => onFocus?.(id)}
      onKeyDown={handleKeyDown}
      onClick={handleContentClick}
      onDoubleClick={handleContentDoubleClick}
    >
      <div
        className="artifact-header cursor-grab active:cursor-grabbing"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onClick={(e) => {
          if (!didMove) {
            onPanelClick?.(id, e as unknown as React.MouseEvent);
          }
        }}
        onDoubleClick={(e) => {
          if (!didMove) {
            e.stopPropagation();
            onPanelDoubleClick?.(id, e as unknown as React.MouseEvent);
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h3 className="truncate" title={title}>{title}</h3>
          <span className="artifact-type flex-shrink-0">{type}</span>
        </div>
        {showMenuTrigger ? (
          <div className="relative flex-shrink-0">
            <button
              type="button"
              aria-label={`Open menu for ${title}`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              className="panel-menu-trigger inline-flex h-8 w-8 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenMenu?.(isMenuOpen ? '' : id);
              }}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </button>
            {isMenuOpen && menuContent ? (
              <div
                role="menu"
                aria-label={`Actions for ${title}`}
                className="panel-menu absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {menuContent}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Content area - no-zoom-scroll class excludes from canvas zoom via react-zoom-pan-pinch */}
      <div className="artifact-content flex-1 min-h-0 overflow-auto no-zoom-scroll" onWheel={(e) => e.stopPropagation()}>
        {children}
      </div>

      {(['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => (
        <div
          key={corner}
          aria-hidden="true"
          className={cn('resize-handle', corner)}
          onPointerDown={(e) => handleResizeStart(e, corner)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
      ))}
    </div>
  );
}
