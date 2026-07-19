import { useEffect, useState } from 'react';
import { fetchWorkspacePanelPreview, getGalleryPanelPreviewUrl } from '../../api';
import { type FileSource, useFileObjectUrl } from '../../lib/fileUrls';
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
  const { url, error } = useFileObjectUrl(fileSource, panel.filePath, cacheKey);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(panel.filePath);
  const isPdf = panel.type === 'pdf';
  const isHtml = /\.html?$/i.test(panel.filePath);

  if (error) return <div className="panel-empty">{error}</div>;
  if (!url) return <div className="panel-empty">Loading file…</div>;

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
    return <ProtectedPreviewFrame fileSource={fileSource} panel={panel} />;
  }

  return <div className="panel-empty">No preview content yet.</div>;
}

function ProtectedPreviewFrame({
  fileSource,
  panel,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'preview' }>;
}) {
  const publicUrl = fileSource.kind === 'gallery'
    ? getGalleryPanelPreviewUrl(fileSource.id, panel.id)
    : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (fileSource.kind === 'gallery') return;
    let active = true;
    let created: string | null = null;
    setLoadError(null);
    void fetchWorkspacePanelPreview(fileSource.id, panel.id).then(async (response) => {
      if (!response.ok) throw new Error(`Failed to load preview (${response.status})`);
      created = URL.createObjectURL(await response.blob());
      if (active) setObjectUrl(created);
      else URL.revokeObjectURL(created);
    }).catch((fetchError) => {
      if (active) {
        setObjectUrl(null);
        setLoadError(fetchError instanceof Error ? fetchError.message : 'Failed to load preview');
      }
    });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [fileSource.kind, fileSource.id, panel.id]);
  const previewUrl = publicUrl ?? objectUrl;
  if (!previewUrl && loadError) return <div className="panel-empty">{loadError}</div>;
  if (!previewUrl) return <div className="panel-empty">Loading preview…</div>;
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
