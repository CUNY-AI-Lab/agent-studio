import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GalleryView, startFileDownload } from './App';
import type { GalleryItemFull, WorkspaceState } from './types';

const galleryState: WorkspaceState = {
  sessionId: null,
  workspace: null,
  panels: [],
  groups: [],
  connections: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

const gallery: GalleryItemFull = {
  id: 'gallery-1',
  title: 'Shared research',
  description: 'A public workspace',
  publishedAt: '2026-08-24T00:00:00.000Z',
  artifactCount: 0,
  state: galleryState,
};

function GalleryDownloadOwner() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <GalleryView
        gallery={gallery}
        error={error}
        onGoHome={vi.fn()}
        onDownloadFile={vi.fn()}
      />
      <button
        type="button"
        onClick={() => startFileDownload(
          { kind: 'gallery', id: gallery.id },
          'notes.md',
          'notes.md',
          setError,
        )}
      >
        Retry gallery download
      </button>
    </>
  );
}

describe('gallery download error ownership', () => {
  it('shows a rejected gallery download in the App-owned banner and keeps retry available', async () => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();

    try {
      render(<GalleryDownloadOwner />);
      await user.click(screen.getByRole('button', { name: 'Retry gallery download' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('network down');
      expect(screen.getByRole('button', { name: 'Retry gallery download' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Retry gallery download' }));
      expect(browserFetch).toHaveBeenCalledTimes(2);
    } finally {
      browserFetch.mockRestore();
    }
  });
});
