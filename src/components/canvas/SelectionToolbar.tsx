'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import {
  MessageSquare,
  Download as DownloadIcon,
  Minus,
  Maximize2,
  Link as LinkIcon,
  Unlink as UnlinkIcon,
  LogOut,
  Trash2,
} from 'lucide-react';

type ToolbarDownloadFormat = 'file' | 'csv' | 'json' | 'png';

interface SelectionToolbarProps {
  // What's selected
  selectedPanelId?: string | null;
  selectedGroupId?: string | null;
  selectedPanelIds?: Set<string>;

  // Panel info (for context)
  panelTitle?: string;
  groupName?: string;

  // Position reference (bounding box of selection in canvas coordinates)
  selectionBounds: { x: number; y: number; width: number; height: number } | null;
  canvasScale: number;
  viewportOffset?: { x: number; y: number };
  viewportSize?: { width: number; height: number };

  // Actions
  canChat?: boolean;
  onChat?: () => void;
  onDownload?: (format: ToolbarDownloadFormat) => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onRemove?: () => void;
  onGroup?: () => void;
  onUngroup?: () => void;
  onRemoveFromGroup?: () => void;
  onAlign?: (mode: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => void;
  onDistribute?: (axis: 'horizontal' | 'vertical') => void;

  // State
  isInGroup?: boolean;
  canDownload?: boolean;
  downloadFormats?: ToolbarDownloadFormat[];
  onHoverChange?: (hovering: boolean) => void;
}

export function SelectionToolbar({
  selectedPanelId,
  selectedGroupId,
  selectedPanelIds,
  panelTitle,
  groupName,
  selectionBounds,
  canvasScale,
  viewportOffset,
  viewportSize,
  canChat = true,
  onChat,
  onDownload,
  onMinimize,
  onMaximize,
  onRemove,
  onGroup,
  onUngroup,
  onRemoveFromGroup,
  isInGroup,
  canDownload,
  downloadFormats = [],
  onHoverChange,
}: SelectionToolbarProps) {
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const downloadRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });

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

  // Selection types
  const hasSelection = selectedPanelId || selectedGroupId || (selectedPanelIds && selectedPanelIds.size > 0);
  const isGroupSelection = !!selectedGroupId;
  const isMultiSelection = selectedPanelIds && selectedPanelIds.size > 1 && !selectedGroupId;
  const isSinglePanel = !!selectedPanelId && !isGroupSelection;

  const toolbarKey = [
    isGroupSelection ? 'group' : 'panel',
    isMultiSelection ? 'multi' : 'single',
    isInGroup ? 'in-group' : 'no-group',
    canChat ? 'chat' : 'no-chat',
    canDownload ? `download-${downloadFormats.join(',')}` : 'no-download',
    onMinimize ? 'minimize' : 'no-minimize',
    onMaximize ? 'maximize' : 'no-maximize',
    onRemove ? 'remove' : 'no-remove',
    onGroup ? 'group-action' : 'no-group-action',
    onUngroup ? 'ungroup' : 'no-ungroup',
    onRemoveFromGroup ? 'remove-from-group' : 'no-remove-from-group',
    showDownloadMenu ? 'menu-open' : 'menu-closed',
  ].join('|');

  useLayoutEffect(() => {
    if (!hasSelection || !selectionBounds) return;
    if (!toolbarRef.current) return;
    const rect = toolbarRef.current.getBoundingClientRect();
    setToolbarSize(prev => (
      prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height }
    ));
  }, [hasSelection, selectionBounds, canvasScale, toolbarKey]);

  if (!hasSelection || !selectionBounds) return null;

  // Toolbar dimensions (at scale 1)
  const TOOLBAR_HEIGHT = 36;
  const GAP = 8;
  const MARGIN = 8;

  // Position in canvas coordinates - center-top of selection bounds
  const initialCanvasX = selectionBounds.x + selectionBounds.width / 2;
  const initialCanvasY = selectionBounds.y - GAP / canvasScale - TOOLBAR_HEIGHT / canvasScale;

  const offsetX = viewportOffset?.x ?? 0;
  const offsetY = viewportOffset?.y ?? 0;
  const viewportWidth = viewportSize?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
  const viewportHeight = viewportSize?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

  const toolbarWidth = toolbarSize.width || 200;
  const toolbarHeight = toolbarSize.height || TOOLBAR_HEIGHT;
  const showChatButton = canChat;
  const showDownloadSection = isSinglePanel && canDownload && downloadFormats.length > 0;
  const showMinimizeSection = isSinglePanel && !!onMinimize;
  const showMaximizeSection = isSinglePanel && !!onMaximize;
  const showGroupSection = isMultiSelection && !!onGroup;
  const showUngroupSection = isGroupSelection && !!onUngroup;
  const showRemoveFromGroupSection = isSinglePanel && isInGroup && !!onRemoveFromGroup;
  const showRemoveSection = !!onRemove;

  const screenX = initialCanvasX * canvasScale + offsetX;
  let screenY = initialCanvasY * canvasScale + offsetY;

  // If toolbar would be above the viewport, place it below the selection instead.
  if (screenY < MARGIN) {
    screenY = (selectionBounds.y + selectionBounds.height + GAP / canvasScale) * canvasScale + offsetY;
  }

  const minCenterX = MARGIN + toolbarWidth / 2;
  const maxCenterX = viewportWidth - MARGIN - toolbarWidth / 2;
  const minTopY = MARGIN;
  const maxTopY = viewportHeight - MARGIN - toolbarHeight;

  const safeMaxCenterX = Math.max(minCenterX, maxCenterX);
  const safeMaxTopY = Math.max(minTopY, maxTopY);

  const clampedScreenX = Math.min(Math.max(screenX, minCenterX), safeMaxCenterX);
  const clampedScreenY = Math.min(Math.max(screenY, minTopY), safeMaxTopY);

  const canvasX = (clampedScreenX - offsetX) / canvasScale;
  const canvasY = (clampedScreenY - offsetY) / canvasScale;

  return (
    <div
      ref={toolbarRef}
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
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {/* Chat button */}
      {showChatButton && (
        <button
          className="toolbar-btn toolbar-btn-primary"
          onClick={onChat}
          title={
            isGroupSelection
              ? `Chat about ${groupName || 'group'}`
              : isMultiSelection
                ? 'Chat about selected tiles'
                : `Chat about ${panelTitle || 'tile'}`
          }
        >
          <MessageSquare className="w-4 h-4" />
        </button>
      )}

      {/* Download dropdown - for single panels with downloadable content */}
      {showDownloadSection && (
        <>
          {showChatButton && <div className="toolbar-divider" />}
          <div className="relative" ref={downloadRef}>
            <button
              className="toolbar-btn"
              onClick={() => setShowDownloadMenu(!showDownloadMenu)}
              title="Download or export"
            >
              <DownloadIcon className="w-4 h-4" />
            </button>
            {showDownloadMenu && (
              <div className="toolbar-dropdown-menu">
                {downloadFormats.includes('file') && (
                  <button onClick={() => { onDownload?.('file'); setShowDownloadMenu(false); }}>
                    File
                  </button>
                )}
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
                    PNG Snapshot
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Minimize - for single panels */}
      {showMinimizeSection && (
        <>
          {(showChatButton || showDownloadSection) && <div className="toolbar-divider" />}
          <button className="toolbar-btn" onClick={onMinimize} title="Minimize">
            <Minus className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Maximize - for single panels */}
      {showMaximizeSection && (
        <>
          {(showChatButton || showDownloadSection || showMinimizeSection) && <div className="toolbar-divider" />}
          <button className="toolbar-btn" onClick={onMaximize} title="Maximize tile">
            <Maximize2 className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Group actions - for multi-selection */}
      {showGroupSection && (
        <>
          {(showChatButton || showDownloadSection || showMinimizeSection || showMaximizeSection) && <div className="toolbar-divider" />}
          <button className="toolbar-btn" onClick={onGroup} title="Group tiles">
            <LinkIcon className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Ungroup - for groups */}
      {showUngroupSection && (
        <>
          {(showChatButton || showDownloadSection || showMinimizeSection || showMaximizeSection || showGroupSection) && <div className="toolbar-divider" />}
          <button className="toolbar-btn" onClick={onUngroup} title="Ungroup">
            <UnlinkIcon className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Remove from group - for single panel in a group */}
      {showRemoveFromGroupSection && (
        <>
          {(showChatButton || showDownloadSection || showMinimizeSection || showMaximizeSection || showGroupSection || showUngroupSection) && <div className="toolbar-divider" />}
          <button className="toolbar-btn" onClick={onRemoveFromGroup} title="Remove from group">
            <LogOut className="w-4 h-4" />
          </button>
        </>
      )}

      {/* Delete/Remove */}
      {showRemoveSection && (
        <>
          {(showChatButton || showDownloadSection || showMinimizeSection || showMaximizeSection || showGroupSection || showUngroupSection || showRemoveFromGroupSection) && <div className="toolbar-divider" />}
          <button
            className="toolbar-btn toolbar-btn-danger"
            onClick={onRemove}
            title={isGroupSelection ? 'Delete group' : isMultiSelection ? 'Remove selected tiles' : 'Remove tile'}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
}
