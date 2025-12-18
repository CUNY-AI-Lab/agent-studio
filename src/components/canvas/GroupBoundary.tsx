'use client';

import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import type { CanvasPanelLayout, PanelGroup } from '@/lib/storage';

interface GroupBoundaryProps {
  group: PanelGroup;
  panelLayouts: Record<string, CanvasPanelLayout>;
  existingPanelIds: Set<string>; // Source of truth for which panels actually exist
  scale: number; // Current zoom level for drag calculations
  onGroupClick?: (groupId: string) => void;
  onGroupChatClick?: (groupId: string) => void;
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
  scale,
  onGroupClick,
  onGroupChatClick,
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
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  // Calculate bounding box around all panels in the group
  // Only include panels that actually exist (existingPanelIds) AND have layouts
  const { bounds, validPanelCount } = useMemo(() => {
    const validIds = group.panelIds.filter(id => existingPanelIds.has(id));
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
  }, [group.panelIds, panelLayouts, existingPanelIds]);

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
    if (isEditing) return;
    // Set a timeout - if double-click happens, this will be cancelled
    clickTimeoutRef.current = setTimeout(() => {
      onGroupClick?.(group.id);
    }, 200);
  }, [group.id, isEditing, onGroupClick]);

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

    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - dragStartRef.current.x) / scale;
    const dy = (e.clientY - dragStartRef.current.y) / scale;

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
        {/* Chat button */}
        <button
          className="group-chat-button"
          onClick={(e) => {
            e.stopPropagation();
            onGroupChatClick?.(group.id);
          }}
          title="Chat about this group"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
