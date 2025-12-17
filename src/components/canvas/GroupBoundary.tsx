'use client';

import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import type { CanvasPanelLayout, PanelGroup } from '@/lib/storage';

interface GroupBoundaryProps {
  group: PanelGroup;
  panelLayouts: Record<string, CanvasPanelLayout>;
  onGroupClick?: (groupId: string) => void;
  onGroupRename?: (groupId: string, newName: string) => void;
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditStart?: (groupId: string) => void;
}

export function GroupBoundary({
  group,
  panelLayouts,
  onGroupClick,
  onGroupRename,
  isEditing,
  editValue,
  onEditChange,
  onEditStart,
}: GroupBoundaryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Calculate bounding box around all panels in the group
  const bounds = useMemo(() => {
    const layouts = group.panelIds
      .map(id => panelLayouts[id])
      .filter(Boolean);

    if (layouts.length === 0) return null;

    const padding = 16;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const layout of layouts) {
      minX = Math.min(minX, layout.x);
      minY = Math.min(minY, layout.y);
      maxX = Math.max(maxX, layout.x + layout.width);
      maxY = Math.max(maxY, layout.y + layout.height);
    }

    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }, [group.panelIds, panelLayouts]);

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

  if (!bounds) return null;

  return (
    <div
      className="group-boundary absolute pointer-events-auto cursor-pointer"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
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
            {group.name || 'Unnamed group'}
          </span>
        )}
      </div>
    </div>
  );
}
