'use client';

import { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Download as DownloadIcon,
  Minus,
  Maximize2,
  Link as LinkIcon,
  Link2,
  Link2Off,
  Unlink as UnlinkIcon,
  LogOut,
  Trash2,
  AlignCenter,
  GripVertical,
} from 'lucide-react';

type ToolbarDownloadFormat = 'file' | 'csv' | 'json' | 'txt' | 'png';
type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';
type DistributeAxis = 'horizontal' | 'vertical';

const TOOLBAR_SIZE = { width: 200, height: 36 } as const;

const ALIGN_OPTIONS: ReadonlyArray<readonly [AlignMode, string]> = [
  ['left', 'Left'],
  ['centerX', 'Center X'],
  ['right', 'Right'],
  ['top', 'Top'],
  ['centerY', 'Center Y'],
  ['bottom', 'Bottom'],
];
const DISTRIBUTE_OPTIONS: ReadonlyArray<readonly [DistributeAxis, string]> = [
  ['horizontal', 'Horizontal'],
  ['vertical', 'Vertical'],
];

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
  onToggleConnection?: () => void;
  isConnected?: boolean;
  onUngroup?: () => void;
  onRemoveFromGroup?: () => void;
  onAlign?: (mode: AlignMode) => void;
  onDistribute?: (axis: DistributeAxis) => void;
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
  onToggleConnection,
  isConnected = false,
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

  useEffect(() => {
    if (!openMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const eventTarget = event.target;
      const targetNode = eventTarget instanceof Node ? eventTarget : null;
      const withinToolbar = targetNode ? toolbarRef.current?.contains(targetNode) : false;
      const withinDownload = targetNode ? downloadRef.current?.contains(targetNode) : false;
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

  if (!hasSelection || !selectionBounds) return null;

  const toolbarHeight = TOOLBAR_SIZE.height;
  const gap = 8;
  const margin = 8;
  const initialCanvasX = selectionBounds.x + selectionBounds.width / 2;
  const initialCanvasY = selectionBounds.y - gap / canvasScale - toolbarHeight / canvasScale;

  const offsetX = viewportOffset?.x ?? 0;
  const offsetY = viewportOffset?.y ?? 0;
  const viewportWidth = viewportSize?.width ?? globalThis.window?.innerWidth ?? 1920;
  const viewportHeight = viewportSize?.height ?? globalThis.window?.innerHeight ?? 1080;

  const computedWidth = TOOLBAR_SIZE.width;
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
  const showConnectionSection = isMultiSelection && Boolean(onToggleConnection);
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
      className="selection-toolbar absolute nodrag nopan nowheel"
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
                {ALIGN_OPTIONS.map(([mode, label]) => (
                  <button
                    key={mode}
                    role="menuitem"
                    onClick={() => {
                      onAlign?.(mode);
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
                {DISTRIBUTE_OPTIONS.map(([axis, label]) => (
                  <button
                    key={axis}
                    role="menuitem"
                    onClick={() => {
                      onDistribute?.(axis);
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

      {showConnectionSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection) ? <div className="toolbar-divider" /> : null}
          <button
            className="toolbar-btn"
            onClick={onToggleConnection}
            title={isConnected ? 'Disconnect tiles' : 'Associate tiles'}
            aria-label={isConnected ? 'Disconnect selected tiles' : 'Associate selected tiles'}
          >
            {isConnected ? <Link2Off className="w-4 h-4" aria-hidden="true" /> : <Link2 className="w-4 h-4" aria-hidden="true" />}
          </button>
        </>
      ) : null}

      {showUngroupSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection || showConnectionSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onUngroup} title="Ungroup" aria-label="Ungroup">
            <UnlinkIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showRemoveFromGroupSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection || showConnectionSection || showUngroupSection) ? <div className="toolbar-divider" /> : null}
          <button className="toolbar-btn" onClick={onRemoveFromGroup} title="Remove from group" aria-label="Remove tile from group">
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      ) : null}

      {showRemoveSection ? (
        <>
          {(showChatButton || showDownloadSection || showAlignSection || showDistributeSection || showMinimizeSection || showMaximizeSection || showGroupSection || showConnectionSection || showUngroupSection || showRemoveFromGroupSection) ? <div className="toolbar-divider" /> : null}
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
