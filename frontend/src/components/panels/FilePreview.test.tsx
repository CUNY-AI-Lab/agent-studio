import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreview, PreviewPanelView } from './FilePreview';
import { fetchWorkspaceFile, fetchWorkspacePanelPreview } from '../../api';

vi.mock('../../api', () => ({
  fetchWorkspaceFile: vi.fn(),
  fetchWorkspacePanelPreview: vi.fn(),
  getWorkspaceFileUrl: (id: string, path: string) => `/api/workspaces/${id}/files/${path}`,
  getGalleryFileUrl: (id: string, path: string) => `/api/gallery/${id}/files/${path}`,
  getGalleryPanelPreviewUrl: (id: string, panelId: string) => `/api/gallery/${id}/preview/${panelId}`,
}));

const workspaceSource = { kind: 'workspace', id: 'ws-1' } as const;

describe('FilePreview failure surfacing', () => {
  beforeEach(() => {
    vi.mocked(fetchWorkspaceFile).mockReset();
    vi.mocked(fetchWorkspacePanelPreview).mockReset();
  });

  it('shows the loading state while the file fetch is pending', () => {
    vi.mocked(fetchWorkspaceFile).mockReturnValue(new Promise<Response>(() => {}));
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
      />,
    );
    expect(screen.getByText('Loading file…')).toBeInTheDocument();
  });

  it('surfaces a failed workspace file fetch instead of loading forever', async () => {
    vi.mocked(fetchWorkspaceFile).mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
      />,
    );
    expect(await screen.findByText('Failed to load file (404)')).toBeInTheDocument();
    expect(screen.queryByText('Loading file…')).not.toBeInTheDocument();
  });

  it('surfaces a rejected workspace file fetch instead of loading forever', async () => {
    vi.mocked(fetchWorkspaceFile).mockRejectedValue(new Error('network down'));
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
      />,
    );
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  it('surfaces a failed panel preview fetch instead of loading forever', async () => {
    vi.mocked(fetchWorkspacePanelPreview).mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    render(
      <PreviewPanelView
        fileSource={workspaceSource}
        panel={{ id: 'panel-2', type: 'preview', content: '<p>hi</p>' }}
      />,
    );
    expect(await screen.findByText('Failed to load preview (500)')).toBeInTheDocument();
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();
  });
});
