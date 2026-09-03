import { useEffect, useState } from 'react';
import { fetchWorkspaceFile, fetchWorkspacePanelPreview, getGalleryPanelPreviewUrl } from '../../api';
import { type FileSource, type WorkspaceFileFetcher, useFileObjectUrl } from '../../lib/fileUrls';
import type { WorkspacePanel } from '../../types';
import { TextFilePreview } from './TextFilePreview';

export function FilePreview({
  fileSource,
  panel,
  cacheKey,
  fetchFile = fetchWorkspaceFile,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'pdf' | 'editor' | 'file' }>;
  cacheKey?: string | null;
  fetchFile?: WorkspaceFileFetcher;
}) {
  const { url, blob, error } = useFileObjectUrl(fileSource, panel.filePath, cacheKey, fetchFile);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(panel.filePath);
  const isPdf = panel.type === 'pdf';
  const isHtml = /\.html?$/i.test(panel.filePath);

  if (error) return <div className="panel-empty">We couldn’t load this file. Try again or download it.</div>;
  if (!url) return <div className="panel-empty">Loading file…</div>;

  if (isImage) {
    return <img key={url} className="panel-image" src={url} alt={panel.title || panel.filePath} />;
  }

  // Blob URLs do not retain the response's CSP. Only the PDF MIME may enter
  // the native, unsandboxed PDF viewer; imported files can mislabel a .pdf.
  if (isPdf && (fileSource.kind === 'gallery' || blob?.type.split(';', 1)[0] === 'application/pdf')) {
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
    return <TextFilePreview url={url} blob={blob} filePath={panel.filePath} />;
  }

  return (
    <div className="panel-file">
      <a href={url} download={panel.filePath.split('/').pop() || panel.filePath}>
        Download {panel.filePath}
      </a>
    </div>
  );
}

export function PreviewPanelView({
  fileSource,
  panel,
  cacheKey,
  fetchPreview = fetchWorkspacePanelPreview,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'preview' }>;
  cacheKey?: string | null;
  fetchPreview?: WorkspaceFileFetcher;
}) {
  if (panel.filePath) {
    return <ProtectedPreviewFrame fileSource={fileSource} panel={panel} cacheKey={cacheKey} fetchPreview={fetchPreview} />;
  }

  if (panel.content) {
    return <ProtectedPreviewFrame fileSource={fileSource} panel={panel} fetchPreview={fetchPreview} />;
  }

  return <div className="panel-empty">No preview content yet.</div>;
}

function ProtectedPreviewFrame({
  fileSource,
  panel,
  cacheKey,
  fetchPreview,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'preview' }>;
  cacheKey?: string | null;
  fetchPreview: WorkspaceFileFetcher;
}) {
  const galleryUrl = fileSource.kind === 'gallery'
    ? getGalleryPanelPreviewUrl(fileSource.id, panel.id)
    : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (fileSource.kind === 'gallery') return;
    let active = true;
    let created: string | null = null;
    setLoadError(null);
    void fetchPreview(fileSource.id, panel.id).then(async (response) => {
      if (!response.ok) throw new Error('We couldn’t load this file. Try again or download it.');
      created = URL.createObjectURL(await response.blob());
      if (active) setObjectUrl(created);
      else URL.revokeObjectURL(created);
    }).catch(() => {
      if (active) {
        setObjectUrl(null);
        setLoadError('We couldn’t load this file. Try again or download it.');
      }
    });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [fileSource.kind, fileSource.id, panel.id, cacheKey, fetchPreview]);
  const previewUrl = galleryUrl ?? objectUrl;
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
