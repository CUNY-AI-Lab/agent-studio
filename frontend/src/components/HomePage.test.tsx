import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import type { GalleryItem, WorkspaceRecord } from '../types';

const now = '2026-07-11T12:00:00.000Z';

function workspace(index: number): WorkspaceRecord {
  return {
    id: `workspace-${index}`,
    name: `Workspace ${index}`,
    description: '',
    createdAt: now,
    updatedAt: now,
  };
}

function galleryItem(index: number): GalleryItem {
  return {
    id: `gallery-${index}`,
    title: `Gallery ${index}`,
    description: `Shared workspace ${index}`,
    artifactCount: index,
    publishedAt: now,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof HomePage>> = {}) {
  return {
    workspaces: [],
    galleryItems: [],
    onCreateWorkspace: vi.fn(async () => true),
    onSelectWorkspace: vi.fn(),
    onOpenGalleryItem: vi.fn(),
    onCloneGalleryItem: vi.fn(async () => {}),
    onStartBlank: vi.fn(async () => true),
    onImportWorkspace: vi.fn(async () => {}),
    busy: false,
    importing: false,
    ...overrides,
  };
}

describe('HomePage', () => {
  it('keeps every returned workspace and gallery item reachable', () => {
    render(
      <HomePage
        {...props({
          workspaces: Array.from({ length: 10 }, (_, index) => workspace(index + 1)),
          galleryItems: Array.from({ length: 7 }, (_, index) => galleryItem(index + 1)),
        })}
      />
    );

    expect(screen.getByRole('button', { name: /Workspace 10/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Gallery 7 gallery item' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('passes a selected workspace bundle to the import handler', async () => {
    const user = userEvent.setup();
    const onImportWorkspace = vi.fn(async () => {});
    render(<HomePage {...props({ onImportWorkspace })} />);

    const bundle = new File(['{"version":1}'], 'research.agent-studio.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText('Import workspace bundle'), bundle);

    expect(onImportWorkspace).toHaveBeenCalledWith(bundle);
  });

  it('opens a gallery item read-only without cloning it', async () => {
    const user = userEvent.setup();
    const onOpenGalleryItem = vi.fn();
    const onCloneGalleryItem = vi.fn(async () => {});
    render(
      <HomePage
        {...props({
          galleryItems: [galleryItem(1)],
          onOpenGalleryItem,
          onCloneGalleryItem,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open read-only' }));

    expect(onOpenGalleryItem).toHaveBeenCalledWith('gallery-1');
    expect(onCloneGalleryItem).not.toHaveBeenCalled();
  });

  it('disables creation and import controls while importing', () => {
    render(<HomePage {...props({ busy: true, importing: true })} />);

    expect(screen.getByText('Importing…')).toBeInTheDocument();
    expect(screen.getByLabelText('Import workspace bundle')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeDisabled();
  });

  it('does not navigate to a workspace while another home action is pending', async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    render(
      <HomePage
        {...props({
          workspaces: [workspace(1)],
          busy: true,
          onSelectWorkspace,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: /Workspace 1/ }));

    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('keeps a typed prompt when workspace creation fails', async () => {
    const user = userEvent.setup();
    const onCreateWorkspace = vi.fn(async () => false);
    render(<HomePage {...props({ onCreateWorkspace })} />);

    const input = screen.getByRole('textbox', { name: 'What would you like to work on?' });
    await user.type(input, 'Keep this prompt');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(onCreateWorkspace).toHaveBeenCalledWith('Keep this prompt');
    expect(input).toHaveValue('Keep this prompt');
  });

  it('owns a pending clone action so a second click cannot create another workspace', async () => {
    const user = userEvent.setup();
    let resolveClone!: () => void;
    const onCloneGalleryItem = vi.fn(() => new Promise<void>((resolve) => {
      resolveClone = resolve;
    }));
    render(<HomePage {...props({ galleryItems: [galleryItem(1)], onCloneGalleryItem })} />);

    const cloneButton = screen.getByRole('button', { name: 'Use as workspace' });
    await user.click(cloneButton);
    await user.click(cloneButton);

    expect(onCloneGalleryItem).toHaveBeenCalledTimes(1);
    expect(cloneButton).toBeDisabled();
    resolveClone();
    await waitFor(() => expect(cloneButton).not.toBeDisabled());
  });
});
