import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { FilesShelf } from './FilesShelf';
import type { WorkspaceFileInfo } from '../../types';

interface FileCardRefs {
  current: Record<string, HTMLElement | null>;
}

function makeProps(overrides: Partial<Parameters<typeof FilesShelf>[0]> = {}) {
  const files: WorkspaceFileInfo[] = [
    { name: 'notes.md', path: 'notes.md', isDirectory: false, size: 2048 },
    { name: 'data.csv', path: 'data.csv', isDirectory: false, size: 512 },
  ];
  const fileCardRefs: FileCardRefs = { current: {} };
  return {
    sectionRef: createRef<HTMLElement>(),
    fileCardRefs,
    workspaceId: 'ws1',
    workspaceFileEntries: files,
    uploading: false,
    fileShelfCollapsed: false,
    onToggleCollapsed: vi.fn(),
    onUpload: vi.fn(),
    onOpenFilesPanel: vi.fn(),
    onDownloadFile: vi.fn(),
    filesTileActionLabel: 'Show Files on Canvas',
    activeFilePillPopover: null,
    onSetActiveFilePillPopover: vi.fn(),
    highlightedFilePaths: new Set<string>(),
    onOpenFileOnCanvas: vi.fn(),
    getFileCanvasActionLabel: () => 'Show on Canvas',
    ...overrides,
  };
}

describe('FilesShelf', () => {
  it('lists file pills with their names', () => {
    render(<FilesShelf {...makeProps()} />);
    expect(screen.getByText('notes.md')).toBeInTheDocument();
    expect(screen.getByText('data.csv')).toBeInTheDocument();
  });

  it('shows an empty message when there are no files', () => {
    render(<FilesShelf {...makeProps({ workspaceFileEntries: [] })} />);
    expect(screen.getByText('No files yet')).toBeInTheDocument();
  });

  it('reflects the uploading state on the label', () => {
    render(<FilesShelf {...makeProps({ uploading: true })} />);
    expect(screen.getByText('Uploading…')).toBeInTheDocument();
  });

  it('snapshots selected files before clearing the input', async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();
    render(<FilesShelf {...makeProps({ onUpload })} />);
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });

    await user.upload(screen.getByLabelText('Upload files to workspace'), file);

    expect(onUpload).toHaveBeenCalledWith([file]);
  });

  it('toggles the pill popover when a file pill is clicked', async () => {
    const onSetActiveFilePillPopover = vi.fn<(current: string | null | ((previous: string | null) => string | null)) => void>();
    const user = userEvent.setup();
    render(<FilesShelf {...makeProps({ onSetActiveFilePillPopover })} />);
    await user.click(screen.getByText('notes.md'));
    expect(onSetActiveFilePillPopover).toHaveBeenCalledOnce();
    // Called with an updater; verify it toggles from null -> the path.
    const updaterSchema = z.function({ input: [z.string().nullable()], output: z.string().nullable() });
    const updaterResult = updaterSchema.safeParse(onSetActiveFilePillPopover.mock.calls[0][0]);
    expect(updaterResult.success).toBe(true);
    if (updaterResult.success) {
      expect(updaterResult.data(null)).toBe('notes.md');
      expect(updaterResult.data('notes.md')).toBeNull();
    }
  });

  it('opens the files panel via the action button', async () => {
    const onOpenFilesPanel = vi.fn();
    const user = userEvent.setup();
    render(<FilesShelf {...makeProps({ onOpenFilesPanel })} />);
    await user.click(screen.getByRole('button', { name: 'Show Files on Canvas' }));
    expect(onOpenFilesPanel).toHaveBeenCalledOnce();
  });

  it('forwards a file download without owning the error state', async () => {
    const onDownloadFile = vi.fn();
    const onSetActiveFilePillPopover = vi.fn();
    const user = userEvent.setup();
    render(<FilesShelf {...makeProps({
      activeFilePillPopover: 'notes.md',
      onDownloadFile,
      onSetActiveFilePillPopover,
    })} />);

    await user.click(screen.getByRole('menuitem', { name: 'Download' }));

    expect(onDownloadFile).toHaveBeenCalledWith(
      { kind: 'workspace', id: 'ws1' },
      'notes.md',
      'notes.md',
    );
    expect(onSetActiveFilePillPopover).toHaveBeenCalledWith(expect.any(Function));
  });
});
