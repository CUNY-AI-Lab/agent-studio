import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { getPanelTitle, getPanelTypeLabel } from '../../lib/panelFiles';
import type { FileDownloadHandler, FileSource } from '../../lib/fileUrls';
import type { WorkspaceFileInfo, WorkspacePanel } from '../../types';
import { createFocusTrap } from '../../lib/focusTrap';
import { PanelBody } from '../panels/PanelBody';

export function MaximizedPanelOverlay({
  panel,
  fileSource,
  allPanels,
  workspaceFiles,
  highlightedFilePaths,
  getFileActionLabel,
  onOpenFile,
  onDownloadFile,
  onClose,
}: {
  panel: WorkspacePanel | null;
  fileSource: FileSource;
  allPanels: WorkspacePanel[];
  workspaceFiles: WorkspaceFileInfo[];
  highlightedFilePaths: Set<string>;
  getFileActionLabel: (filePath: string) => string;
  onOpenFile: (file: WorkspaceFileInfo) => void;
  onDownloadFile: FileDownloadHandler;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!panel || !dialogRef.current) return;
    const trap = createFocusTrap(dialogRef.current, { onEscape: onClose });
    return () => trap.release();
  }, [panel, onClose]);

  if (!panel) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-background/92 backdrop-blur-sm focus:outline-none"
    >
      <div className="shrink-0">
        <div className="ws-header flex items-center justify-between px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <strong id={titleId} className="truncate font-serif text-lg font-semibold tracking-tight">{getPanelTitle(panel)}</strong>
            <span className="artifact-type">{getPanelTypeLabel(panel)}</span>
          </div>
          <button
            className="ui-icon-btn"
            onClick={onClose}
            aria-label="Close maximized tile"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="ws-header-rule" aria-hidden="true" />
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="max-sheet rule-lead mx-auto max-w-4xl">
          <PanelBody
            fileSource={fileSource}
            panel={panel}
            allPanels={allPanels}
            workspaceFiles={workspaceFiles}
            highlightedFilePaths={highlightedFilePaths}
            getFileActionLabel={getFileActionLabel}
            onOpenFile={onOpenFile}
            onDownloadFile={onDownloadFile}
          />
        </div>
      </div>
    </div>
  );
}
