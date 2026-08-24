import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreview, PreviewPanelView } from './FilePreview';
import type { WorkspaceFileFetcher } from '../../lib/fileUrls';

const fetchFile = vi.fn<WorkspaceFileFetcher>();
const fetchPreview = vi.fn<WorkspaceFileFetcher>();

const workspaceSource = { kind: 'workspace', id: 'ws-1' } as const;

describe('FilePreview failure surfacing', () => {
  beforeEach(() => {
    fetchFile.mockReset();
    fetchPreview.mockReset();
  });

  it('shows the loading state while the file fetch is pending', () => {
    fetchFile.mockReturnValue(new Promise<Response>(() => {}));
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
        fetchFile={fetchFile}
      />,
    );
    expect(screen.getByText('Loading file…')).toBeInTheDocument();
  });

  it('surfaces a failed workspace file fetch instead of loading forever', async () => {
    fetchFile.mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
        fetchFile={fetchFile}
      />,
    );
    expect(await screen.findByText('We couldn’t load this file. Try again or download it.')).toBeInTheDocument();
    expect(screen.queryByText('Loading file…')).not.toBeInTheDocument();
  });

  it('surfaces a rejected workspace file fetch instead of loading forever', async () => {
    fetchFile.mockRejectedValue(new Error('network down'));
    render(
      <FilePreview
        fileSource={workspaceSource}
        panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
        fetchFile={fetchFile}
      />,
    );
    expect(await screen.findByText('We couldn’t load this file. Try again or download it.')).toBeInTheDocument();
  });

  it('surfaces a failed panel preview fetch instead of loading forever', async () => {
    fetchPreview.mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    render(
      <PreviewPanelView
        fileSource={workspaceSource}
        panel={{ id: 'panel-2', type: 'preview', content: '<p>hi</p>' }}
        fetchPreview={fetchPreview}
      />,
    );
    expect(await screen.findByText('We couldn’t load this file. Try again or download it.')).toBeInTheDocument();
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();
  });

  it('loads a file-backed HTML preview through the sandboxed preview endpoint', async () => {
    fetchPreview.mockResolvedValue(new Response('<h1>hello</h1>', { status: 200 }));
    render(
      <PreviewPanelView
        fileSource={workspaceSource}
        panel={{ id: 'panel-3', type: 'preview', filePath: 'app.html' }}
        fetchPreview={fetchPreview}
      />,
    );
    await waitFor(() => expect(fetchPreview).toHaveBeenCalledWith('ws-1', 'panel-3'));
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();
  });
});
