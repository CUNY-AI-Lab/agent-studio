import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderCanvas(
  selectedPanelIds: Set<string>,
  overrides: Partial<Parameters<typeof CanvasFlow>[0]> = {},
) {
  return render(
    <CanvasFlow
      panels={panels}
      groups={[]}
      connections={[]}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      fileSource={{ kind: 'workspace', id: 'workspace-test' }}
      selectedPanelIds={selectedPanelIds}
      readOnly
      {...overrides}
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

  it('does not reseed React Flow when streamed state clones unchanged canvas data', async () => {
    const { rerender } = renderCanvas(new Set(['panel-one']), {
      allPanels: panels,
      workspaceFiles: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();
    });

    for (let index = 0; index < 20; index += 1) {
      rerender(
        <CanvasFlow
          panels={panels.map((panel) => ({ ...panel, layout: panel.layout ? { ...panel.layout } : undefined }))}
          allPanels={panels.map((panel) => ({ ...panel }))}
          groups={[]}
          connections={[]}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          fileSource={{ kind: 'workspace', id: 'workspace-test' }}
          selectedPanelIds={new Set(['panel-one'])}
          workspaceFiles={[]}
          readOnly
        />,
      );
    }

    expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Two (markdown tile)' })).toBeInTheDocument();
  });

  it('deletes the current same-size selection after the selected tile changes', async () => {
    const onPanelDelete = vi.fn();
    const { rerender } = renderCanvas(new Set(['panel-one']), { onPanelDelete, readOnly: false });

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();
    });

    rerender(
      <CanvasFlow
        panels={panels}
        groups={[]}
        connections={[]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        fileSource={{ kind: 'workspace', id: 'workspace-test' }}
        selectedPanelIds={new Set(['panel-two'])}
        onPanelDelete={onPanelDelete}
      />,
    );

    const selectedNode = await screen.findByRole('group', { name: 'Two (markdown tile), selected' });
    fireEvent.keyDown(selectedNode, { key: 'Delete' });

    expect(onPanelDelete).toHaveBeenCalledOnce();
    expect(onPanelDelete).toHaveBeenCalledWith(['panel-two']);
  });
});

describe('CanvasFlow keyboard view shortcuts', () => {
  it('uses the React Flow viewport helpers and opens the shortcut dialog', async () => {
    const onViewportChange = vi.fn();
    const onOpenShortcuts = vi.fn();
    renderCanvas(new Set(), { onViewportChange, onOpenShortcuts });

    const canvas = screen.getByRole('region', { name: /Workspace canvas, 2 tiles/ });
    canvas.focus();
    fireEvent.keyDown(canvas, { key: '+' });
    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());

    onViewportChange.mockClear();
    fireEvent.keyDown(canvas, { key: '-' });
    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());

    fireEvent.keyDown(canvas, { key: '?' });
    expect(onOpenShortcuts).toHaveBeenCalledOnce();

    onViewportChange.mockClear();
    fireEvent.keyDown(canvas, { key: '0' });
    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
  });
});
