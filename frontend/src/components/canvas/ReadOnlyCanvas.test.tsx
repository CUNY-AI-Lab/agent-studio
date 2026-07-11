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

describe('ReadOnlyCanvas', () => {
  it('provides an in-app route home from a shared gallery URL', async () => {
    const user = userEvent.setup();
    const onGoHome = vi.fn();
    render(
      <ReadOnlyCanvas
        galleryId="gallery-1"
        title="Shared research"
        description="A public workspace"
        state={emptyState}
        onGoHome={onGoHome}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onGoHome).toHaveBeenCalledOnce();
  });
});
