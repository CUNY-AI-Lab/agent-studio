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

  it('renders protected markdown from the fetched response without a second blob URL fetch', async () => {
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectUrl = vi.fn(() => 'blob:notes');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const browserFetch = vi.spyOn(globalThis, 'fetch');
    fetchFile.mockResolvedValue(new Response('# Notes\n\nLoaded once.', { status: 200 }));

    try {
      render(
        <FilePreview
          fileSource={workspaceSource}
          panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
          fetchFile={fetchFile}
        />,
      );

      expect(await screen.findByText('Loaded once.')).toBeInTheDocument();
      expect(fetchFile).toHaveBeenCalledOnce();
      expect(browserFetch).not.toHaveBeenCalled();
      expect(createObjectUrl).toHaveBeenCalledOnce();
    } finally {
      browserFetch.mockRestore();
      if (createObjectUrlDescriptor) {
        Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
      }
      if (revokeObjectUrlDescriptor) {
        Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
      } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    }
  });

  it('keeps gallery text previews on their session-bound gallery URL fetch', async () => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Gallery text', { status: 200 }),
    );

    try {
      render(
        <FilePreview
          fileSource={{ kind: 'gallery', id: 'gallery-1' }}
          panel={{ id: 'panel-1', type: 'editor', filePath: 'notes.md' }}
        />,
      );

      expect(await screen.findByText('Gallery text')).toBeInTheDocument();
      expect(browserFetch).toHaveBeenCalledOnce();
      expect(String(browserFetch.mock.calls[0][0])).toContain('/api/gallery/gallery-1/files/notes.md');
    } finally {
      browserFetch.mockRestore();
    }
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
