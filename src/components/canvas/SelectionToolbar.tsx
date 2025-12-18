'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Download as DownloadIcon,
  Minus,
  Link as LinkIcon,
  Unlink as UnlinkIcon,
  LogOut,
  Trash2,
} from 'lucide-react';

interface SelectionToolbarProps {
  // What's selected
  selectedPanelId?: string | null;
  selectedGroupId?: string | null;
  selectedPanelIds?: Set<string>;

  // Panel info (for context)
  panelType?: string;
  panelTitle?: string;
  groupName?: string;

  // Position reference (bounding box of selection in canvas coordinates)
  selectionBounds: { x: number; y: number; width: number; height: number } | null;
  canvasScale: number;

  // Actions
  onChat?: () => void;
  onDownload?: (format: 'csv' | 'json' | 'png') => void;
  onMinimize?: () => void;
  onRemove?: () => void;
  onGroup?: () => void;
  onUngroup?: () => void;
  onRename?: () => void;
  onRemoveFromGroup?: () => void;
  onAlign?: (mode: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => void;
  onDistribute?: (axis: 'horizontal' | 'vertical') => void;

  // State
  isInGroup?: boolean;
  canDownload?: boolean;
  downloadFormats?: ('csv' | 'json' | 'png')[];
}

export function SelectionToolbar({
  selectedPanelId,
  selectedGroupId,
  selectedPanelIds,
  panelTitle,
  groupName,
  selectionBounds,
  canvasScale,
  onChat,
  onDownload,
  onMinimize,
  onRemove,
  onGroup,
  onUngroup,
  onRemoveFromGroup,
  isInGroup,
  canDownload,
  downloadFormats = [],
}: SelectionToolbarProps) {
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const downloadRef = useRef<HTMLDivElement>(null);

  // Close download menu when clicking outside
  useEffect(() => {
    if (!showDownloadMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (downloadRef.current && !downloadRef.current.contains(e.target as Node)) {
        setShowDownloadMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDownloadMenu]);

  // Don't render if nothing selected or no bounds
  const hasSelection = selectedPanelId || selectedGroupId || (selectedPanelIds && selectedPanelIds.size > 0);
  if (!hasSelection || !selectionBounds) return null;

  // Toolbar dimensions (at scale 1)
  const TOOLBAR_HEIGHT = 36;
  const GAP = 8;

  // Position in canvas coordinates - center-top of selection bounds
  const canvasX = selectionBounds.x + selectionBounds.width / 2;
  const canvasY = selectionBounds.y - GAP / canvasScale - TOOLBAR_HEIGHT / canvasScale;

  // Determine what type of selection we have
  const isGroupSelection = !!selectedGroupId;
  const isMultiSelection = selectedPanelIds && selectedPanelIds.size > 1 && !selectedGroupId;
  const isSinglePanel = !!selectedPanelId && !isGroupSelection;

  return (
    <div
      className="selection-toolbar absolute"
      style={{
        left: canvasX,
        top: canvasY,
        transform: `translateX(-50%) scale(${1 / canvasScale})`,
        transformOrigin: 'bottom center',
        zIndex: 10000,
        display: 'inline-flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '2px',
        whiteSpace: 'nowrap',
        width: 'max-content',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Chat button */}
      <button
        className="toolbar-btn toolbar-btn-primary"
        onClick={onChat}
        title={`Chat about ${isGroupSelection ? (groupName || 'group') : (panelTitle || 'panel')}`}
      >
        <MessageSquare className="w-4 h-4" />
      </button>

      {/* Download dropdown - for single panels with downloadable content */}
      {isSinglePanel && canDownload && downloadFormats.length > 0 && (
        <>
          <div className="toolbar-divider" />
          <div className="relative" ref={downloadRef}>
            <button
              className="toolbar-btn"
              onClick={() => setShowDownloadMenu(!showDownloadMenu)}
              title="Download"
            >
              <DownloadIcon className="w-4 h-4" />
            </button>
            {showDownloadMenu && (
              <div className="toolbar-dropdown-menu">
                {downloadFormats.includes('csv') && (
                  <button onClick={() => { onDownload?.('csv'); setShowDownloadMenu(false); }}>
                    CSV
                  </button>
                )}
                {downloadFormats.includes('json') && (
                  <button onClick={() => { onDownload?.('json'); setShowDownloadMenu(false); }}>
                    JSON
                  </button>
                )}
                {downloadFormats.includes('png') && (
                  <button onClick={() => { onDownload?.('png'); setShowDownloadMenu(false); }}>
                    PNG
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Minimize - for single panels */}
      {isSinglePanel && onMinimize && (
        <>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={onMinimize} title="Minimize">
            <Minus className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Group actions - for multi-selection */}
      {isMultiSelection && onGroup && (
        <>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={onGroup} title="Group panels">
            <LinkIcon className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Ungroup - for groups */}
      {isGroupSelection && onUngroup && (
        <>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={onUngroup} title="Ungroup">
            <UnlinkIcon className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Remove from group - for single panel in a group */}
      {isSinglePanel && isInGroup && onRemoveFromGroup && (
        <>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={onRemoveFromGroup} title="Remove from group">
            <LogOut className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Delete/Remove */}
      <div className="toolbar-divider" />
      <button
        className="toolbar-btn toolbar-btn-danger"
        onClick={onRemove}
        title={isGroupSelection ? 'Delete group' : 'Remove panel'}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
