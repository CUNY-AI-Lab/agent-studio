import type { RefObject } from 'react';
import { cn } from '../../lib/utils';
import { formatFileSize } from '../../lib/format';
import { canOpenFileInPanel, getFileName, getFileTypeBadge } from '../../lib/panelFiles';
import { downloadFileSource } from '../../lib/fileUrls';
import type { WorkspaceFileInfo } from '../../types';

/**
 * Files shelf shown above the canvas: upload control, the "show files on
 * canvas" action, and per-file pill popovers. All interaction state lives in
 * WorkspaceShell; this component only renders and forwards events.
 */
export function FilesShelf({
  sectionRef,
  fileCardRefs,
  workspaceId,
  workspaceFileEntries,
  uploading,
  fileShelfCollapsed,
  onToggleCollapsed,
  onUpload,
  onOpenFilesPanel,
  filesTileActionLabel,
  activeFilePillPopover,
  onSetActiveFilePillPopover,
  highlightedFilePaths,
  onOpenFileOnCanvas,
  getFileCanvasActionLabel,
}: {
  sectionRef: RefObject<HTMLElement | null>;
  fileCardRefs: RefObject<Record<string, HTMLElement | null>>;
  workspaceId: string;
  workspaceFileEntries: WorkspaceFileInfo[];
  uploading: boolean;
  fileShelfCollapsed: boolean;
  onToggleCollapsed: () => void;
  onUpload: (files: File[]) => void;
  onOpenFilesPanel: () => void;
  filesTileActionLabel: string;
  activeFilePillPopover: string | null;
  onSetActiveFilePillPopover: (updater: (current: string | null) => string | null) => void;
  highlightedFilePaths: Set<string>;
  onOpenFileOnCanvas: (file: WorkspaceFileInfo) => void;
  getFileCanvasActionLabel: (filePath: string) => string;
}) {
  return (
    <section ref={sectionRef} aria-label="Workspace files" className="flex-shrink-0 border-b border-border/50 bg-card/60 backdrop-blur-sm overflow-visible relative z-10">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <button
          onClick={onToggleCollapsed}
          className="flex items-center gap-2 text-xs font-medium text-foreground/70 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-expanded={!fileShelfCollapsed}
          aria-controls="files-shelf-list"
        >
          <svg className={`w-3 h-3 transition-transform duration-200 ${fileShelfCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
          <span>Files</span>
          {workspaceFileEntries.length > 0 ? (
            <span className="text-[10px] text-foreground/50 tabular-nums">{workspaceFileEntries.length}</span>
          ) : null}
        </button>
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-primary/80 hover:text-primary transition-colors cursor-pointer focus-within:ring-2 focus-within:ring-ring rounded px-1">
            {uploading ? 'Uploading…' : 'Upload'}
            <input
              className="sr-only"
              type="file"
              multiple
              aria-label="Upload files to workspace"
              accept=".pdf,.txt,.csv,.md,.json,.xlsx,.xls,.jpg,.jpeg,.png,.gif,.webp,.xml"
              onChange={(event) => {
                onUpload(Array.from(event.target.files ?? []));
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button
            onClick={onOpenFilesPanel}
            className="text-[11px] font-medium text-primary/80 hover:text-primary transition-colors"
          >
            {filesTileActionLabel}
          </button>
        </div>
      </div>
      {!fileShelfCollapsed ? (
        <div id="files-shelf-list" className="px-4 pb-2.5">
          {workspaceFileEntries.length === 0 ? (
            <p className="text-[11px] text-foreground/40 italic">No files yet</p>
          ) : (
            <ul className="flex gap-1.5 flex-wrap list-none m-0 p-0">
              {workspaceFileEntries.map((file) => (
                <li
                  key={file.path}
                  ref={(node) => {
                    fileCardRefs.current[file.path] = node;
                  }}
                  className="relative"
                >
                  <button
                    type="button"
                    data-file-pill-trigger
                    onClick={() => onSetActiveFilePillPopover((current) => current === file.path ? null : file.path)}
                    className={cn(
                      'flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] transition-all hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      highlightedFilePaths.has(file.path)
                        ? 'border-primary/40 bg-primary/5 text-foreground shadow-sm shadow-primary/10'
                        : 'border-border/50 bg-background/80 text-foreground/80',
                      activeFilePillPopover === file.path && 'ring-1 ring-primary/30'
                    )}
                    title={`${file.name} (${formatFileSize(file.size)})`}
                    aria-label={`${file.name}, ${formatFileSize(file.size)}. File actions`}
                    aria-haspopup="menu"
                    aria-expanded={activeFilePillPopover === file.path}
                  >
                    <span className="text-[10px] leading-none opacity-60">{getFileTypeBadge(file.path)}</span>
                    <span className="font-medium truncate max-w-[160px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px' }}>
                      {getFileName(file.path)}
                    </span>
                    <span className="text-foreground/35 tabular-nums" style={{ fontSize: '10px' }}>
                      {formatFileSize(file.size)}
                    </span>
                    {highlightedFilePaths.has(file.path) ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                    ) : null}
                  </button>
                  {activeFilePillPopover === file.path ? (
                    <div
                      data-file-pill-popover
                      role="menu"
                      aria-label={`Actions for ${file.name}`}
                      className="absolute top-full left-0 z-50 mt-1 flex gap-1 rounded-lg border border-border/70 bg-card p-1 shadow-lg"
                    >
                      {canOpenFileInPanel(file.path) ? (
                        <button
                          role="menuitem"
                          onClick={() => {
                            onOpenFileOnCanvas(file);
                            onSetActiveFilePillPopover(() => null);
                          }}
                          className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {getFileCanvasActionLabel(file.path)}
                        </button>
                      ) : null}
                      <button
                        role="menuitem"
                        onClick={() => {
                          void downloadFileSource({ kind: 'workspace', id: workspaceId }, file.path, file.name);
                          onSetActiveFilePillPopover(() => null);
                        }}
                        className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Download
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
