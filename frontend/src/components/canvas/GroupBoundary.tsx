'use client';

import { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { CANVAS_STEP, CANVAS_LARGE_STEP } from '../../lib/keyboardMap';

type CanvasPanelLayout = { x: number; y: number; width: number; height: number };
type PanelGroup = { id: string; name?: string; panelIds: string[]; color?: string };

interface GroupBoundaryProps {
  group: PanelGroup;
  panelLayouts: Record<string, CanvasPanelLayout>;
  existingPanelIds: Set<string>;
  visiblePanelIds?: Set<string>;
  scale: number;
  isActive?: boolean;
  onGroupClick?: (groupId: string) => void;
  onGroupRename?: (groupId: string, newName: string) => void;
  onGroupDrag?: (groupId: string, dx: number, dy: number) => void;
  onGroupDragEnd?: (groupId: string) => void;
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditStart?: (groupId: string) => void;
}

export function GroupBoundary({
  group,
  panelLayouts,
  existingPanelIds,
  visiblePanelIds,
  scale,
  isActive,
  onGroupClick,
  onGroupRename,
  onGroupDrag,
  onGroupDragEnd,
  isEditing,
  editValue,
  onEditChange,
  onEditStart,
}: GroupBoundaryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didDragRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const { bounds, validPanelCount } = useMemo(() => {
    const validIds = group.panelIds.filter((id) => existingPanelIds.has(id) && (!visiblePanelIds || visiblePanelIds.has(id)));
    const layouts = validIds.map((id) => panelLayouts[id]).filter(Boolean);
    if (layouts.length === 0) return { bounds: null, validPanelCount: 0 };

    const padding = 16;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const layout of layouts) {
      minX = Math.min(minX, layout.x);
      minY = Math.min(minY, layout.y);
      maxX = Math.max(maxX, layout.x + layout.width);
      maxY = Math.max(maxY, layout.y + layout.height);
    }

    return {
      bounds: {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      },
      validPanelCount: layouts.length,
    };
  }, [existingPanelIds, group.panelIds, panelLayouts, visiblePanelIds]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    };
  }, []);

  const handleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (isEditing || isDragging || didDragRef.current) return;
    clickTimeoutRef.current = setTimeout(() => {
      onGroupClick?.(group.id);
    }, 200);
  }, [group.id, isDragging, isEditing, onGroupClick]);

  const handleDoubleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    onEditStart?.(group.id);
  }, [group.id, onEditStart]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      onGroupRename?.(group.id, editValue ?? '');
    } else if (event.key === 'Escape') {
      onGroupRename?.(group.id, group.name || '');
    }
  }, [editValue, group.id, group.name, onGroupRename]);

  const handleBlur = useCallback(() => {
    onGroupRename?.(group.id, editValue ?? '');
  }, [editValue, group.id, onGroupRename]);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('.group-boundary-label')) return;

    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
    didDragRef.current = false;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (!isDragging) return;
    event.preventDefault();
    event.stopPropagation();

    const dx = (event.clientX - dragStartRef.current.x) / scale;
    const dy = (event.clientY - dragStartRef.current.y) / scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      didDragRef.current = true;
    }
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    onGroupDrag?.(group.id, dx, dy);
  }, [group.id, isDragging, onGroupDrag, scale]);

  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    if (!isDragging) return;
    event.preventDefault();
    setIsDragging(false);
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    onGroupDragEnd?.(group.id);
    setTimeout(() => {
      didDragRef.current = false;
    }, 0);
  }, [group.id, isDragging, onGroupDragEnd]);

  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isEditing) return;
    const target = event.target as HTMLElement;
    if (target.closest('.group-boundary-label')) return;

    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      onGroupClick?.(group.id);
      return;
    }

    if (event.key === 'F2') {
      event.preventDefault();
      onEditStart?.(group.id);
      return;
    }

    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -1;
    else if (event.key === 'ArrowRight') dx = 1;
    else if (event.key === 'ArrowUp') dy = -1;
    else if (event.key === 'ArrowDown') dy = 1;
    else return;

    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? CANVAS_LARGE_STEP : CANVAS_STEP;
    onGroupDrag?.(group.id, dx * step, dy * step);
    onGroupDragEnd?.(group.id);
  }, [group.id, isEditing, onEditStart, onGroupClick, onGroupDrag, onGroupDragEnd]);

  if (!bounds || validPanelCount < 2) return null;

  return (
    <div
      role="group"
      aria-label={`${group.name || `${validPanelCount} tiles`} group`}
      aria-pressed={isActive}
      tabIndex={0}
      className={`group-boundary absolute pointer-events-auto ${isDragging ? 'cursor-grabbing' : 'cursor-grab'} ${isActive ? 'active' : ''}`}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        borderColor: group.color || undefined,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleContainerKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div
        className="group-boundary-label"
        style={group.color ? { borderColor: group.color } : undefined}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue ?? ''}
            onChange={(event) => onEditChange?.(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="group-name-input"
            placeholder="Group name..."
            aria-label="Group name"
          />
        ) : (
          <span className="group-name-text" title="Double-click to rename">
            {group.name || `${validPanelCount} panels`}
          </span>
        )}
      </div>
    </div>
  );
}
