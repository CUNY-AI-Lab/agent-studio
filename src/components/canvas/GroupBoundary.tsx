'use client';

import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import type { CanvasPanelLayout, PanelGroup } from '@/lib/storage';

interface GroupBoundaryProps {
  group: PanelGroup;
  panelLayouts: Record<string, CanvasPanelLayout>;
  existingPanelIds: Set<string>; // Source of truth for which panels actually exist
  visiblePanelIds?: Set<string>; // Optional filter for panels visible on canvas
  scale: number; // Current zoom level for drag calculations
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
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const didDragRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  // Calculate bounding box around all panels in the group
  // Only include panels that actually exist (existingPanelIds) AND have layouts
  const { bounds, validPanelCount } = useMemo(() => {
    const validIds = group.panelIds.filter(id =>
      existingPanelIds.has(id) && (!visiblePanelIds || visiblePanelIds.has(id))
    );
    const layouts = validIds
      .map(id => panelLayouts[id])
      .filter(Boolean);

    if (layouts.length === 0) return { bounds: null, validPanelCount: 0 };

    const padding = 16;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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
  }, [group.panelIds, panelLayouts, existingPanelIds, visiblePanelIds]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  // Handle single click with delay to distinguish from double-click
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Don't trigger click if editing
    if (isEditing || isDragging || didDragRef.current) return;
    // Set a timeout - if double-click happens, this will be cancelled
    clickTimeoutRef.current = setTimeout(() => {
      onGroupClick?.(group.id);
    }, 200);
  }, [group.id, isEditing, isDragging, onGroupClick]);

  // Handle double-click - cancel pending click and start editing
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Cancel the pending single-click
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    onEditStart?.(group.id);
  }, [group.id, onEditStart]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onGroupRename?.(group.id, editValue ?? '');
    } else if (e.key === 'Escape') {
      onGroupRename?.(group.id, group.name || '');
    }
  }, [group.id, group.name, editValue, onGroupRename]);

  const handleBlur = useCallback(() => {
    onGroupRename?.(group.id, editValue ?? '');
  }, [group.id, editValue, onGroupRename]);

  // Handle group drag start
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Don't start drag if clicking on label or buttons
    if ((e.target as HTMLElement).closest('.group-boundary-label')) return;

    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }

    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    didDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - dragStartRef.current.x) / scale;
    const dy = (e.clientY - dragStartRef.current.y) / scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      didDragRef.current = true;
    }

    // Update start position for continuous dragging
    dragStartRef.current = { x: e.clientX, y: e.clientY };

    onGroupDrag?.(group.id, dx, dy);
  }, [isDragging, scale, group.id, onGroupDrag]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    e.preventDefault();
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onGroupDragEnd?.(group.id);
    setTimeout(() => {
      didDragRef.current = false;
    }, 0);
  }, [isDragging, group.id, onGroupDragEnd]);

  // Don't render if no bounds or fewer than 2 valid panels
  if (!bounds || validPanelCount < 2) return null;

  return (
    <div
      className={`group-boundary absolute pointer-events-auto ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="group-boundary-label">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue ?? ''}
            onChange={(e) => onEditChange?.(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="group-name-input"
            placeholder="Group name..."
          />
        ) : (
          <span
            className="group-name-text"
            title="Double-click to rename"
          >
            {group.name || `${validPanelCount} panels`}
          </span>
        )}
      </div>
    </div>
  );
}
