import { render, screen } from '@testing-library/react';
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
    onCreateWorkspace: vi.fn(async () => {}),
    onSelectWorkspace: vi.fn(),
    onCloneGalleryItem: vi.fn(async () => {}),
    onStartBlank: vi.fn(async () => {}),
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
    expect(screen.getByRole('button', { name: /Gallery 7/ })).toBeInTheDocument();
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

  it('disables creation and import controls while importing', () => {
    render(<HomePage {...props({ busy: true, importing: true })} />);

    expect(screen.getByText('Importing…')).toBeInTheDocument();
    expect(screen.getByLabelText('Import workspace bundle')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeDisabled();
  });
});
