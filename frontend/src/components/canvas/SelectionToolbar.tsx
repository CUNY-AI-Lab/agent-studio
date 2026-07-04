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
  AlignCenter,
  GripVertical,
} from 'lucide-react';

type ToolbarDownloadFormat = 'file' | 'csv' | 'json' | 'txt' | 'png';

interface SelectionToolbarProps {
  selectedPanelId?: string | null;
  selectedGroupId?: string | null;
  selectedPanelIds?: Set<string>;
  panelTitle?: string;
  groupName?: string;
  selectionBounds: { x: number; y: number; width: number; height: number } | null;
  canvasScale: number;
  viewportOffset?: { x: number; y: number };
  viewportSize?: { width: number; height: number } | null;
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
  onAlign,
  onDistribute,
  isInGroup,
  canDownload,
  downloadFormats = [],
  onHoverChange,
}: SelectionToolbarProps) {
  const [openMenu, setOpenMenu] = useState<'download' | 'align' | 'distribute' | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const downloadRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!openMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const withinToolbar = toolbarRef.current?.contains(event.target as Node);
      const withinDownload = downloadRef.current?.contains(event.target as Node);
      if (!withinToolbar && !withinDownload) {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openMenu]);

  const hasSelection = selectedPanelId || selectedGroupId || (selectedPanelIds && selectedPanelIds.size > 0);
  const isGroupSelection = Boolean(selectedGroupId);
  const isMultiSelection = Boolean(selectedPanelIds && selectedPanelIds.size > 1 && !selectedGroupId);
  const isSinglePanel = Boolean(selectedPanelId && !selectedGroupId);

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
    onAlign ? 'align' : 'no-align',
    onDistribute ? 'distribute' : 'no-distribute',
    openMenu ?? 'menu-closed',
  ].join('|');

  useLayoutEffect(() => {
    if (!hasSelection || !selectionBounds || !toolbarRef.current) return;
    const rect = toolbarRef.current.getBoundingClientRect();
    setToolbarSize((current) => (
      current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height }
    ));
  }, [hasSelection, selectionBounds, canvasScale, toolbarKey]);

  if (!hasSelection || !selectionBounds) return null;

  const toolbarHeight = toolbarSize.height || 36;
  const gap = 8;
  const margin = 8;
  const initialCanvasX = selectionBounds.x + selectionBounds.width / 2;
  const initialCanvasY = selectionBounds.y - gap / canvasScale - toolbarHeight / canvasScale;

  const offsetX = viewportOffset?.x ?? 0;
  const offsetY = viewportOffset?.y ?? 0;
  const viewportWidth = viewportSize?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
  const viewportHeight = viewportSize?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

  const computedWidth = toolbarSize.width || 200;
  let screenX = initialCanvasX * canvasScale + offsetX;
  let screenY = initialCanvasY * canvasScale + offsetY;

  if (screenY < margin) {
    screenY = (selectionBounds.y + selectionBounds.height + gap / canvasScale) * canvasScale + offsetY;
  }

  const minCenterX = margin + computedWidth / 2;
  const maxCenterX = viewportWidth - margin - computedWidth / 2;
  const minTopY = margin;
  const maxTopY = viewportHeight - margin - toolbarHeight;

  screenX = Math.min(Math.max(screenX, minCenterX), Math.max(minCenterX, maxCenterX));
  screenY = Math.min(Math.max(screenY, minTopY), Math.max(minTopY, maxTopY));

  const canvasX = (screenX - offsetX) / canvasScale;
  const canvasY = (screenY - offsetY) / canvasScale;

  const showChatButton = canChat;
  const showDownloadSection = isSinglePanel && canDownload && downloadFormats.length > 0;
  const showMinimizeSection = isSinglePanel && Boolean(onMinimize);
  const showMaximizeSection = isSinglePanel && Boolean(onMaximize);
  const showGroupSection = isMultiSelection && Boolean(onGroup);
  const showUngroupSection = isGroupSelection && Boolean(onUngroup);
  const showRemoveFromGroupSection = isSinglePanel && isInGroup && Boolean(onRemoveFromGroup);
  const showAlignSection = Boolean(onAlign);
  const showDistributeSection = Boolean(onDistribute);
  const showRemoveSection = Boolean(onRemove);

  const chatLabel = isGroupSelection
    ? `Chat about ${groupName || 'group'}`
    : isMultiSelection
      ? 'Chat about selected tiles'
      : `Chat about ${panelTitle || 'tile'}`;
  const removeLabel = isGroupSelection
    ? 'Delete group'
    : isMultiSelection
      ? 'Remove selected tiles'
      : 'Remove tile';

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={
        isGroupSelection
          ? `Actions for ${groupName || 'group'}`
          : isMultiSelection
            ? 'Actions for selected tiles'
            : `Actions for ${panelTitle || 'tile'}`
      }
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
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {showChatButton ? (
        <button
          className="toolbar-btn toolbar-btn-primary"
          onClick={onChat}
          title={chatLabel}
          aria-label={chatLabel}
        >
          <MessageSquare className="w-4 h-4" aria-hidden="true" />
        </button>
      ) : null}

      {showDownloadSection ? (
        <>
          {showChatButton ? <div className="toolbar-divider" /> : null}
          <div className="relative" ref={downloadRef}>
            <button
              className="toolbar-btn"
              onClick={() => setOpenMenu((current) => current === 'download' ? null : 'download')}
              title="Download or export"
              aria-label="Download or export"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'download'}
            >
              <DownloadIcon className="w-4 h-4" aria-hidden="true" />
            </button>
            {openMenu === 'download' ? (
              <div className="toolbar-dropdown-menu" role="menu" aria-label="Download formats">
                {downloadFormats.map((format) => (
                  <button
                    key={format}
                    role="menuitem"
                    onClick={() => {
                      onDownload?.(format);
                      setOpenMenu(null);
                    }}
                  >
                    {format === 'txt' ? 'Text' : format === 'png' ? 'PNG Snapshot' : format.toUpperCase()}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {showAlignSection ? (
        <>
          {(showChatButton || showDownloadSection) ? <div className="toolbar-divider" /> : null}
          <div className="relative">
            <button
              className="toolbar-btn"
              onClick={() => setOpenMenu((current) => current === 'align' ? null : 'align')}
              title="Align"
              aria-label="Align tiles"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'align'}
            >
              <AlignCenter className="w-4 h-4" aria-hidden="true" />
            </button>
            {openMenu === 'align' ? (
              <div className="toolbar-dropdown-menu" role="menu" aria-label="Align options">
                {[
                  ['left', 'Left'],
                  ['centerX', 'Center X'],
                  ['right', 'Right'],
                  ['top', 'Top'],
                  ['centerY', 'Center Y'],
                  ['bottom', 'Bottom'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    role="menuitem"
                    onClick={() => {
                      onAlign?.(mode as 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom');
                      setOpenMenu(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {showDistributeSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection) ? <div className="toolbar-divider" /> : null}
          <div className="relative">
            <button
              className="toolbar-btn"
              onClick={() => setOpenMenu((current) => current === 'distribute' ? null : 'distribute')}
              title="Distribute"
              aria-label="Distribute tiles"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'distribute'}
            >
              <GripVertical className="w-4 h-4" aria-hidden="true" />
            </button>
            {openMenu === 'distribute' ? (
              <div className="toolbar-dropdown-menu" role="menu" aria-label="Distribute options">
                {[
                  ['horizontal', 'Horizontal'],
                  ['vertical', 'Vertical'],
                ].map(([axis, label]) => (
                  <button
                    key={axis}
                    role="menuitem"
                    onClick={() => {
                      onDistribute?.(axis as 'horizontal' | 'vertical');
                      setOpenMenu(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {showMinimizeSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onMinimize} title="Minimize" aria-label="Minimize tile">
            <Minus className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showMaximizeSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onMaximize} title="Maximize tile" aria-label="Maximize tile">
            <Maximize2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showGroupSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onGroup} title="Group tiles" aria-label="Group tiles">
            <LinkIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showUngroupSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onUngroup} title="Ungroup" aria-label="Ungroup">
            <UnlinkIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showRemoveFromGroupSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection || showUngroupSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onRemoveFromGroup} title="Remove from group" aria-label="Remove tile from group">
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showRemoveSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection || showUngroupSection || showRemoveFromGroupSection) ? <div className="toolbar-divider" /> : null}
          <button
            className="toolbar-btn toolbar-btn-danger"
            onClick={onRemove}
            title={removeLabel}
            aria-label={removeLabel}
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}
