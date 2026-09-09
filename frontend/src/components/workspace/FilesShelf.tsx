import { useLayoutEffect, useRef, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatFileSize } from '../../lib/format';
import { canOpenFileInPanel, getFileName, getFileTypeBadge } from '../../lib/panelFiles';
import type { FileDownloadHandler } from '../../lib/fileUrls';
import type { WorkspaceFileInfo } from '../../types';

const FILE_MENU_VIEWPORT_GAP = 8;

function getFileMenuOffset(
  rect: Pick<DOMRect, 'left' | 'right'>,
  viewportWidth: number,
): number {
  const minOffset = FILE_MENU_VIEWPORT_GAP - rect.left;
  const maxOffset = viewportWidth - FILE_MENU_VIEWPORT_GAP - rect.right;

  if (minOffset <= 0 && maxOffset >= 0) return 0;
  if (maxOffset < 0) return maxOffset;
  return minOffset;
}

/**
 * Files shelf shown above the canvas: upload control, the "show files on
 * canvas" action, and per-file chip popovers. All interaction state lives in
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
  onDownloadFile,
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
  onDownloadFile: FileDownloadHandler;
  filesTileActionLabel: string;
  activeFilePillPopover: string | null;
  onSetActiveFilePillPopover: (updater: (current: string | null) => string | null) => void;
  highlightedFilePaths: Set<string>;
  onOpenFileOnCanvas: (file: WorkspaceFileInfo) => void;
  getFileCanvasActionLabel: (filePath: string) => string;
}) {
  const fileMenuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const menu = fileMenuRef.current;
    if (!menu) return;

    const updateMenuPosition = () => {
      // Clear the previous correction before measuring so a resize or a
      // different file always starts from the shelf's natural anchor point.
      menu.style.transform = 'none';
      const offset = getFileMenuOffset(menu.getBoundingClientRect(), window.innerWidth);
      if (offset !== 0) {
        menu.style.transform = `translateX(${offset}px)`;
      }
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    const resizeObserver = new ResizeObserver(updateMenuPosition);
    resizeObserver.observe(menu);

    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      resizeObserver.disconnect();
    };
  }, [activeFilePillPopover]);

  return (
    <section ref={sectionRef} aria-label="Workspace files" className="files-shelf relative z-20 flex-shrink-0 overflow-visible">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <button
          onClick={onToggleCollapsed}
          className="files-shelf-toggle"
          aria-expanded={!fileShelfCollapsed}
          aria-controls="files-shelf-list"
        >
          <ChevronDown size={13} strokeWidth={2.25} className="text-muted-foreground" aria-hidden="true" />
          <span className="ui-label text-foreground">Files</span>
          {workspaceFileEntries.length > 0 ? (
            <span className="files-shelf-count tabular-nums">{workspaceFileEntries.length}</span>
          ) : null}
        </button>
        <div className="flex items-center gap-4">
          <label className="ui-link cursor-pointer focus-within:outline-3 focus-within:outline-ring">
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
            className="ui-link"
          >
            {filesTileActionLabel}
          </button>
        </div>
      </div>
      {!fileShelfCollapsed ? (
        <div id="files-shelf-list" className="px-4 pb-2.5">
          {workspaceFileEntries.length === 0 ? (
            <p className="files-empty">No files yet</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
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
                      'file-chip',
                      highlightedFilePaths.has(file.path) && 'file-chip-highlighted'
                    )}
                    title={`${file.name} (${formatFileSize(file.size)})`}
                    aria-label={`${file.name}, ${formatFileSize(file.size)}. File actions`}
                    aria-haspopup="menu"
                    aria-expanded={activeFilePillPopover === file.path}
                  >
                    <span className="file-chip-type">{getFileTypeBadge(file.path)}</span>
                    <span className="file-chip-name">
                      {getFileName(file.path)}
                    </span>
                    <span className="file-chip-size tabular-nums">
                      {formatFileSize(file.size)}
                    </span>
                    {highlightedFilePaths.has(file.path) ? (
                      <span className="file-chip-dot" aria-hidden="true" />
                    ) : null}
                  </button>
                  {activeFilePillPopover === file.path ? (
                    <div
                      ref={fileMenuRef}
                      data-file-pill-popover
                      role="menu"
                      aria-label={`Actions for ${file.name}`}
                      className="files-shelf-file-menu ui-surface ui-menu absolute left-0 top-full z-50 mt-1 flex min-w-0 gap-1"
                    >
                      {canOpenFileInPanel(file.path) ? (
                        <button
                          role="menuitem"
                          onClick={() => {
                            onOpenFileOnCanvas(file);
                            onSetActiveFilePillPopover(() => null);
                          }}
                          className="ui-menu-item w-auto"
                        >
                          {getFileCanvasActionLabel(file.path)}
                        </button>
                      ) : null}
                      <button
                        role="menuitem"
                        onClick={() => {
                          onDownloadFile({ kind: 'workspace', id: workspaceId }, file.path, file.name);
                          onSetActiveFilePillPopover(() => null);
                        }}
                        className="ui-menu-item w-auto"
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
