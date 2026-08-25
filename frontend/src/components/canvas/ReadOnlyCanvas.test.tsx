import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyCanvas } from './ReadOnlyCanvas';
import type { WorkspaceState } from '../../types';

const emptyState: WorkspaceState = {
  workspace: null,
  sessionId: null,
  panels: [],
  groups: [],
  connections: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

const stateWithTable: WorkspaceState = {
  ...emptyState,
  panels: [
    {
      id: 'sales-report',
      type: 'table',
      title: 'Sales Report',
      columns: [{ key: 'region', label: 'Region' }],
      rows: [{ region: 'North' }],
    },
  ],
};

describe('ReadOnlyCanvas', () => {
  it('provides an in-app route home from a shared gallery URL', async () => {
    const user = userEvent.setup();
    const onGoHome = vi.fn();
    render(
      <ReadOnlyCanvas
        galleryId="gallery-1"
        title="Shared research"
        description="A shared workspace"
        state={emptyState}
        onGoHome={onGoHome}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onGoHome).toHaveBeenCalledOnce();
  });

  it('exposes each read-only tile as a labeled, keyboard-focusable group', () => {
    render(
      <ReadOnlyCanvas
        galleryId="gallery-1"
        title="Shared research"
        description="A shared workspace"
        state={stateWithTable}
        onGoHome={vi.fn()}
      />
    );

    const tile = screen.getByRole('group', { name: 'Sales Report (table tile)' });
    expect(tile).toHaveAttribute('tabindex', '0');

    tile.focus();
    expect(tile).toHaveFocus();
  });
});
