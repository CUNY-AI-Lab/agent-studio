import { getWorkspacePanelPreviewUrl, getGalleryPanelPreviewUrl } from '../../api';
import { type FileSource, getFileUrl, withCacheKey } from '../../lib/fileUrls';
import type { WorkspacePanel } from '../../types';
import { TextFilePreview } from './TextFilePreview';

export function FilePreview({
  fileSource,
  panel,
  cacheKey,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'pdf' | 'editor' | 'file' }>;
  cacheKey?: string | null;
}) {
  const url = withCacheKey(getFileUrl(fileSource, panel.filePath), cacheKey);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(panel.filePath);
  const isPdf = panel.type === 'pdf';
  const isHtml = /\.html?$/i.test(panel.filePath);

  if (isImage) {
    return <img key={url} className="panel-image" src={url} alt={panel.title || panel.filePath} />;
  }

  if (isPdf) {
    return <iframe key={url} className="panel-frame" src={url} title={panel.title || panel.filePath} />;
  }

  if (isHtml) {
    return (
      <iframe
        key={url}
        className="panel-frame"
        src={url}
        title={panel.title || panel.filePath}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    );
  }

  if (/\.(md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css)$/i.test(panel.filePath)) {
    return <TextFilePreview url={url} filePath={panel.filePath} />;
  }

  // Raw same-origin open is safe: the file-serving route sends
  // `Content-Security-Policy: default-src 'none'; sandbox` + nosniff on every
  // file, and `Content-Disposition: attachment` for active types
  // (html/svg/xml). An active-type open downloads rather than executing on our
  // origin; safe inline types still open/render normally.
  return (
    <div className="panel-file">
      <a href={url} target="_blank" rel="noreferrer">
        Open {panel.filePath}
      </a>
    </div>
  );
}

export function PreviewPanelView({
  fileSource,
  panel,
  cacheKey,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'preview' }>;
  cacheKey?: string | null;
}) {
  if (panel.filePath) {
    return (
      <FilePreview
        fileSource={fileSource}
        panel={{ ...panel, type: 'editor', filePath: panel.filePath }}
        cacheKey={cacheKey}
      />
    );
  }

  if (panel.content) {
    const previewUrl = fileSource.kind === 'workspace'
      ? getWorkspacePanelPreviewUrl(fileSource.id, panel.id)
      : getGalleryPanelPreviewUrl(fileSource.id, panel.id);
    return (
      <iframe
        className="panel-frame"
        src={previewUrl}
        title={panel.title || panel.id}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    );
  }

  return <div className="panel-empty">No preview content yet.</div>;
}
