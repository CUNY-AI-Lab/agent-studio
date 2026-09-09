import { useMemo } from 'react';
import { cn } from '../../lib/utils';
import type { FileDownloadHandler, FileSource } from '../../lib/fileUrls';
import { formatFileSize, formatRelativeTime } from '../../lib/format';
import { canOpenFileInPanel } from '../../lib/panelFiles';
import type { WorkspaceFileInfo } from '../../types';

export function FileTreePanelView({
  fileSource,
  files,
  highlightedPaths,
  getFileActionLabel,
  onOpenFile,
  onDownloadFile,
}: {
  fileSource: FileSource;
  files?: WorkspaceFileInfo[];
  highlightedPaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
  onDownloadFile?: FileDownloadHandler;
}) {
  const entries = useMemo(
    () => [...(files || [])].sort((left, right) => left.path.localeCompare(right.path)),
    [files]
  );

  if (!files) {
    return <div className="panel-empty">Files show up only in workspaces you can edit.</div>;
  }

  if (entries.length === 0) {
    return <div className="panel-empty">No workspace files yet.</div>;
  }

  return (
    <div className="file-list">
      {entries.map((file) => {
        const depth = Math.max(0, file.path.split('/').length - 1);
        const isHighlighted = highlightedPaths?.has(file.path) ?? false;
        const timestamp = file.modifiedAt ?? file.uploadedAt;
        return (
          <article
            className={cn('file-row', isHighlighted && 'file-row-highlighted')}
            key={file.path}
            style={{ paddingLeft: `${6 + depth * 14}px` }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="file-row-kind">{file.isDirectory ? 'Folder' : 'File'}</span>
                <span className="file-row-name">{file.name}</span>
              </div>
              <p className="file-row-path mt-1">{file.path}</p>
              {!file.isDirectory ? (
                <p className="file-row-meta mt-0.5">
                  {formatFileSize(file.size)} · {formatRelativeTime(timestamp)}
                </p>
              ) : null}
            </div>
            {!file.isDirectory ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {fileSource.kind === 'workspace' && onOpenFile && canOpenFileInPanel(file.path) ? (
                  <button
                    onClick={() => onOpenFile(file)}
                    className="ui-btn ui-btn-xs"
                  >
                    {getFileActionLabel?.(file.path) ?? 'Open'}
                  </button>
                ) : null}
                {onDownloadFile ? (
                  <button
                    onClick={() => onDownloadFile(fileSource, file.path, file.name)}
                    className="ui-btn ui-btn-xs"
                  >
                    Download File
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
