import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { getPanelTitle, getPanelTypeLabel } from '../../lib/panelFiles';
import type { FileSource } from '../../lib/fileUrls';
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
  onClose,
}: {
  panel: WorkspacePanel | null;
  fileSource: FileSource;
  allPanels: WorkspacePanel[];
  workspaceFiles: WorkspaceFileInfo[];
  highlightedFilePaths: Set<string>;
  getFileActionLabel: (filePath: string) => string;
  onOpenFile: (file: WorkspaceFileInfo) => void;
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
      className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex flex-col focus:outline-none"
    >
      <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <strong id={titleId} className="font-serif text-lg font-medium">{getPanelTitle(panel)}</strong>
          <span className="artifact-type">{getPanelTypeLabel(panel)}</span>
        </div>
        <button
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
          aria-label="Close maximized tile"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <PanelBody
            fileSource={fileSource}
            panel={panel}
            allPanels={allPanels}
            workspaceFiles={workspaceFiles}
            highlightedFilePaths={highlightedFilePaths}
            getFileActionLabel={getFileActionLabel}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
