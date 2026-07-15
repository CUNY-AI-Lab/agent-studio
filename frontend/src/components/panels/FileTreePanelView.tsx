import { useMemo } from 'react';
import { cn } from '../../lib/utils';
import { downloadFileSource, type FileSource } from '../../lib/fileUrls';
import { formatFileSize, formatRelativeTime } from '../../lib/format';
import { canOpenFileInPanel } from '../../lib/panelFiles';
import type { WorkspaceFileInfo } from '../../types';

export function FileTreePanelView({
  fileSource,
  files,
  highlightedPaths,
  getFileActionLabel,
  onOpenFile,
}: {
  fileSource: FileSource;
  files?: WorkspaceFileInfo[];
  highlightedPaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
}) {
  const entries = useMemo(
    () => [...(files || [])].sort((left, right) => left.path.localeCompare(right.path)),
    [files]
  );

  if (!files) {
    return <div className="panel-empty">File tree data is only available inside editable workspaces.</div>;
  }

  if (entries.length === 0) {
    return <div className="panel-empty">No workspace files yet.</div>;
  }

  return (
    <div className="p-3 space-y-1">
      {entries.map((file) => {
        const depth = Math.max(0, file.path.split('/').length - 1);
        const isHighlighted = highlightedPaths?.has(file.path) ?? false;
        const timestamp = file.modifiedAt ?? file.uploadedAt;
        return (
          <article
            className={cn(
              'rounded-lg border px-3 py-2',
              isHighlighted ? 'border-primary bg-primary/5' : 'border-border/60 bg-background/70'
            )}
            key={file.path}
            style={{ marginLeft: `${depth * 14}px` }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{file.isDirectory ? 'Folder' : 'File'}</span>
                  <span className="truncate text-sm font-medium">{file.name}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground mt-1">{file.path}</p>
              </div>
              {!file.isDirectory ? (
                <div className="flex items-center gap-2">
                  {fileSource.kind === 'workspace' && onOpenFile && canOpenFileInPanel(file.path) ? (
                    <button
                      onClick={() => onOpenFile(file)}
                      className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 transition-colors"
                    >
                      {getFileActionLabel?.(file.path) ?? 'Open'}
                    </button>
                  ) : null}
                  <button
                    onClick={() => void downloadFileSource(fileSource, file.path, file.name)}
                    className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 transition-colors"
                  >
                    Download File
                  </button>
                </div>
              ) : null}
            </div>
            {!file.isDirectory ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {formatFileSize(file.size)} · {formatRelativeTime(timestamp)}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
