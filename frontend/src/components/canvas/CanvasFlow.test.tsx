import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CanvasFlow } from './CanvasFlow';
import type { MarkdownPanel } from '../../types';

const panels: MarkdownPanel[] = [
  {
    id: 'panel-one',
    type: 'markdown',
    title: 'One',
    content: 'First tile',
    layout: { x: 40, y: 40, width: 280, height: 180 },
  },
  {
    id: 'panel-two',
    type: 'markdown',
    title: 'Two',
    content: 'Second tile',
    layout: { x: 360, y: 40, width: 280, height: 180 },
  },
];

function renderCanvas(selectedPanelIds: Set<string>) {
  return render(
    <CanvasFlow
      panels={panels}
      groups={[]}
      connections={[]}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      fileSource={{ kind: 'workspace', id: 'workspace-test' }}
      selectedPanelIds={selectedPanelIds}
      readOnly
    />,
  );
}

describe('CanvasFlow selection state', () => {
  it('updates every selected tile’s accessible label when controlled selection changes', async () => {
    const { rerender } = renderCanvas(new Set(['panel-one']));

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Two (markdown tile)' })).toBeInTheDocument();
    });

    rerender(
      <CanvasFlow
        panels={panels}
        groups={[]}
        connections={[]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        fileSource={{ kind: 'workspace', id: 'workspace-test' }}
        selectedPanelIds={new Set(['panel-one', 'panel-two'])}
        readOnly
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Two (markdown tile), selected' })).toBeInTheDocument();
    });
  });
});
