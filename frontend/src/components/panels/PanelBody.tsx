import { Suspense, lazy } from 'react';
import { type FileSource, getWorkspaceFileCacheKey } from '../../lib/fileUrls';
import type { WorkspaceFileInfo, WorkspacePanel } from '../../types';
import { DetailPanelView } from './DetailPanelView';
import { FilePreview, PreviewPanelView } from './FilePreview';
import { FileTreePanelView } from './FileTreePanelView';
import { TablePanelView } from './TablePanelView';

const LazyChartPanelView = lazy(() => import('./ChartPanelView'));
const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

export function PanelBody({
  fileSource,
  panel,
  allPanels,
  workspaceFiles,
  highlightedFilePaths,
  getFileActionLabel,
  onOpenFile,
}: {
  fileSource: FileSource;
  panel: WorkspacePanel;
  allPanels: WorkspacePanel[];
  workspaceFiles?: WorkspaceFileInfo[];
  highlightedFilePaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
}) {
  switch (panel.type) {
    case 'markdown':
      return (
        <Suspense fallback={<div className="panel-richtext whitespace-pre-wrap">{panel.content}</div>}>
          <LazyMarkdownRenderer
            className="panel-richtext"
            content={panel.content}
          />
        </Suspense>
      );
    case 'table':
      return <TablePanelView panel={panel} />;
    case 'chart':
      return (
        <Suspense fallback={<div className="panel-empty">Loading chart…</div>}>
          <LazyChartPanelView panel={panel} />
        </Suspense>
      );
    case 'cards':
      return (
        <div className="panel-cards">
          {panel.items.map((item, index) => (
            <article className="panel-card" key={item.id || index}>
              <h4>{item.title}</h4>
              {item.subtitle ? <p>{item.subtitle}</p> : null}
              {item.description ? <span>{item.description}</span> : null}
            </article>
          ))}
        </div>
      );
    case 'pdf':
    case 'editor':
    case 'file':
      return (
        <FilePreview
          fileSource={fileSource}
          panel={panel}
          cacheKey={fileSource.kind === 'workspace' ? getWorkspaceFileCacheKey(workspaceFiles, panel.filePath) : null}
        />
      );
    case 'preview':
      return (
        <PreviewPanelView
          fileSource={fileSource}
          panel={panel}
          cacheKey={fileSource.kind === 'workspace' && panel.filePath
            ? getWorkspaceFileCacheKey(workspaceFiles, panel.filePath)
            : null}
        />
      );
    case 'detail':
      return <DetailPanelView panel={panel} panels={allPanels} />;
    case 'fileTree':
      return (
        <FileTreePanelView
          fileSource={fileSource}
          files={workspaceFiles}
          highlightedPaths={highlightedFilePaths}
          getFileActionLabel={getFileActionLabel}
          onOpenFile={onOpenFile}
        />
      );
    default:
      return <div className="panel-file">Panel type not rendered yet.</div>;
  }
}
