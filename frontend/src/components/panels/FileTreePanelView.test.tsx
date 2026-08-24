import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileTreePanelView } from './FileTreePanelView';
import { downloadFileSource, type FileDownloadHandler } from '../../lib/fileUrls';
import type { WorkspaceFileInfo } from '../../types';

const file: WorkspaceFileInfo = {
  name: 'notes.md',
  path: 'notes.md',
  isDirectory: false,
  size: 12,
};

function DownloadHarness() {
  const [error, setError] = useState<string | null>(null);
  const handleDownload: FileDownloadHandler = (source, filePath, filename) => {
    setError(null);
    void downloadFileSource(source, filePath, filename).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : 'The file didn’t download. Try again.');
    });
  };

  return (
    <>
      <FileTreePanelView
        fileSource={{ kind: 'gallery', id: 'gallery-1' }}
        files={[file]}
        onDownloadFile={handleDownload}
      />
      {error ? <div role="alert">{error}</div> : null}
    </>
  );
}

describe('FileTreePanelView download recovery', () => {
  it('keeps the download action available after a rejected download is surfaced', async () => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    try {
      render(<DownloadHarness />);
      const downloadButton = screen.getByRole('button', { name: 'Download File' });

      await user.click(downloadButton);
      expect(await screen.findByRole('alert')).toHaveTextContent('network down');
      expect(screen.getByRole('button', { name: 'Download File' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Download File' }));
      expect(browserFetch).toHaveBeenCalledTimes(2);
    } finally {
      browserFetch.mockRestore();
    }
  });
});
