import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasFlow, flowEdgesMatch, flowNodesMatch } from './CanvasFlow';
import { ContextualChatPopover } from './ContextualChatPopover';
import type { ChartPanel, MarkdownPanel, WorkspacePanel } from '../../types';

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

const chartContextualPanels: WorkspacePanel[] = [
  {
    id: 'chart-notes',
    type: 'markdown',
    title: 'Chart notes',
    content: 'Double-click me to ask a question.',
    layout: { x: 40, y: 40, width: 320, height: 200 },
  },
  {
    id: 'chart-enrollment',
    type: 'chart',
    title: 'Enrollment',
    chartType: 'bar',
    data: [
      { label: 'Fall', value: 24 },
      { label: 'Spring', value: 31 },
      { label: 'Summer', value: 18 },
    ],
    layout: { x: 400, y: 40, width: 520, height: 320 },
  } satisfies ChartPanel,
  {
    id: 'chart-followup',
    type: 'markdown',
    title: 'Follow-up notes',
    content: 'A second card keeps the graph multi-edge during contextual chat.',
    layout: { x: 40, y: 280, width: 320, height: 180 },
  },
];

async function preloadChartPanel() {
  // PanelBody loads chart rendering through React.lazy. Resolve that module
  // before mounting a chart fixture so the test observes the loaded boundary,
  // not an import-scheduling race.
  await import('../panels/ChartPanelView');
}

const manualResizeObservers = new Set<ManualResizeObserver>();

class ManualResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    manualResizeObservers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    manualResizeObservers.delete(this);
  }

  notify() {
    for (const target of this.targets) {
      if (!(target instanceof HTMLElement)) continue;
      Object.defineProperty(target, 'offsetWidth', {
        configurable: true,
        value: Number.parseFloat(target.style.width) || 320,
      });
      Object.defineProperty(target, 'offsetHeight', {
        configurable: true,
        value: Number.parseFloat(target.style.height) || 200,
      });
    }
    const entries = Array.from(this.targets, (target) => ({
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } satisfies ResizeObserverEntry));
    if (entries.length > 0) this.callback(entries, this);
  }

  static notifyAll() {
    for (const observer of manualResizeObservers) observer.notify();
  }
}

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

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
  it('keeps a chart mounted while opening contextual chat from another tile', async () => {
    function ChartContextualHarness() {
      const [contextualOpen, setContextualOpen] = useState(false);
      const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });

      return (
        <>
          <CanvasFlow
            panels={chartContextualPanels}
            allPanels={chartContextualPanels}
            groups={[]}
            connections={[{ id: 'chart-association', sourceId: 'chart-notes', targetId: 'chart-enrollment' }]}
            viewport={viewport}
            fileSource={{ kind: 'workspace', id: 'chart-contextual-test' }}
            selectedPanelIds={new Set()}
            readOnly
            onNodeDoubleClick={() => {
              setContextualOpen(true);
              setViewport({ x: -120, y: -40, zoom: 1 });
            }}
          />
          {contextualOpen ? (
            <ContextualChatPopover
              anchor={{ x: 40, y: 40, width: 320, height: 200 }}
              viewport={viewport}
              title="Chart notes"
              typeLabel="Markdown"
              input=""
              onInputChange={() => undefined}
              onSubmit={() => undefined}
              onClose={() => setContextualOpen(false)}
            />
          ) : null}
        </>
      );
    }

    await preloadChartPanel();
    render(<ChartContextualHarness />);

    await waitFor(() => {
      const chartTile = screen.getByRole('group', { name: 'Enrollment (chart tile)' });
      expect(chartTile).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByRole('group', { name: 'Chart notes (markdown tile)' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Ask about Chart notes' })).toBeInTheDocument();
      const chartTile = screen.getByRole('group', { name: 'Enrollment (chart tile)' });
      expect(chartTile).toBeInTheDocument();
    });
  });

  it('keeps chart associations rendered through contextual auto-pan, close, and zoom', async () => {
    const nativeResizeObserver = globalThis.ResizeObserver;
    const nativeDOMMatrixReadOnly = globalThis.DOMMatrixReadOnly;
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1; });

    try {
      function ChartAssociationHarness() {
        const [contextualOpen, setContextualOpen] = useState(false);
        const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
        const connections = [
          { id: 'chart-association', sourceId: 'chart-notes', targetId: 'chart-enrollment' },
          { id: 'followup-association', sourceId: 'chart-followup', targetId: 'chart-enrollment' },
        ];

        return (
          <>
            <CanvasFlow
              panels={chartContextualPanels}
              allPanels={chartContextualPanels}
              groups={[]}
              connections={connections}
              viewport={viewport}
              fileSource={{ kind: 'workspace', id: 'chart-association-test' }}
              selectedPanelIds={new Set()}
              readOnly
              onNodeDoubleClick={() => {
                setContextualOpen(true);
                setViewport({ x: -120, y: -40, zoom: 1 });
              }}
              onViewportChange={setViewport}
            />
            {contextualOpen ? (
              <ContextualChatPopover
                anchor={{ x: 40, y: 40, width: 320, height: 200 }}
                viewport={viewport}
                title="Chart notes"
                typeLabel="Markdown"
                input=""
                onInputChange={() => undefined}
                onSubmit={() => undefined}
                onClose={() => setContextualOpen(false)}
              />
            ) : null}
          </>
        );
      }

      await preloadChartPanel();
      render(<ChartAssociationHarness />);
      ManualResizeObserver.notifyAll();

      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'Enrollment (chart tile)' })).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Follow-up notes (markdown tile)' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(2);
      });

      fireEvent.doubleClick(screen.getByRole('group', { name: 'Chart notes (markdown tile)' }));
      ManualResizeObserver.notifyAll();

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: 'Ask about Chart notes' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(2);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Ask about Chart notes' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(2);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(2));
    } finally {
      vi.stubGlobal('ResizeObserver', nativeResizeObserver);
      vi.stubGlobal('DOMMatrixReadOnly', nativeDOMMatrixReadOnly);
      manualResizeObservers.clear();
    }
  });

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

  it('compares shared collections once for many large cards', () => {
    type FlowNode = Parameters<typeof flowNodesMatch>[0][number];
    const largePanels: MarkdownPanel[] = Array.from({ length: 128 }, (_, index) => ({
      id: `large-panel-${index}`,
      type: 'markdown',
      title: `Card ${index}`,
      content: `${'large card content '.repeat(512)}-${index}`,
      layout: { x: index * 20, y: index * 12, width: 280, height: 180 },
    }));
    const clonedPanels: MarkdownPanel[] = largePanels.map((panel) => ({
      ...panel,
      layout: panel.layout ? { ...panel.layout } : undefined,
    }));
    let sharedCollectionReads = 0;
    const leftSharedPanels = largePanels.slice();
    largePanels.forEach((panel, index) => {
      Object.defineProperty(leftSharedPanels, String(index), {
        configurable: true,
        enumerable: true,
        get: () => {
          sharedCollectionReads += 1;
          return panel;
        },
      });
    });
    const leftHighlighted = new Set(['app.html']);
    const rightHighlighted = new Set(['app.html']);
    const leftFiles = [{ name: 'app.html', path: 'app.html', isDirectory: false }];
    const rightFiles = [{ name: 'app.html', path: 'app.html', isDirectory: false }];
    const makeNode = (
      panel: WorkspacePanel,
      allPanels: WorkspacePanel[],
      workspaceFiles: typeof leftFiles,
      highlightedFilePaths: Set<string>,
    ): FlowNode => ({
      id: panel.id,
      type: 'panel',
      position: { x: panel.layout?.x || 0, y: panel.layout?.y || 0 },
      style: { width: panel.layout?.width, height: panel.layout?.height },
      selected: false,
      zIndex: 1,
      draggable: true,
      focusable: true,
      ariaLabel: `${panel.title} (markdown tile)`,
      data: {
        panel,
        allPanels,
        workspaceFiles,
        fileSource: { kind: 'workspace', id: 'linear-comparison-test' },
        highlightedFilePaths,
        readOnly: false,
      },
    });
    const leftNodes = largePanels.map((panel) => makeNode(panel, leftSharedPanels, leftFiles, leftHighlighted));
    const rightNodes = clonedPanels.map((panel) => makeNode(panel, clonedPanels, rightFiles, rightHighlighted));

    expect(flowNodesMatch(leftNodes, rightNodes)).toBe(true);
    // A shared collection is traversed for semantic equality once, not once
    // per node. This is structural ownership coverage, not a timing threshold.
    expect(sharedCollectionReads).toBeLessThan(largePanels.length + 4);
  });

  it('matches cloned association objects by their semantic connection', () => {
    const leftConnection = { id: 'association-1', sourceId: 'panel-one', targetId: 'panel-two' };
    const rightConnection = { ...leftConnection };
    const leftEdges = [{
      id: leftConnection.id,
      type: 'association',
      source: leftConnection.sourceId,
      target: leftConnection.targetId,
      selected: false,
      data: { connection: leftConnection, sourceTitle: 'One', targetTitle: 'Two' },
    }];
    const rightEdges = [{
      id: rightConnection.id,
      type: 'association',
      source: rightConnection.sourceId,
      target: rightConnection.targetId,
      selected: false,
      data: { connection: rightConnection, sourceTitle: 'One', targetTitle: 'Two' },
    }];

    expect(flowEdgesMatch(leftEdges, rightEdges)).toBe(true);
    expect(flowEdgesMatch(leftEdges, [{
      ...rightEdges[0],
      data: { ...rightEdges[0].data, connection: { ...rightConnection, targetId: 'panel-three' } },
    }])).toBe(false);
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

  it('keeps the controlled workspace selection stable when the header clears it', async () => {
    const nativeResizeObserver = globalThis.ResizeObserver;
    const nativeDOMMatrixReadOnly = globalThis.DOMMatrixReadOnly;
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    vi.stubGlobal('DOMMatrixReadOnly', class { readonly m22 = 1; });

    try {
      function WorkspaceSelectionHarness() {
        const [selectedPanelIds, setSelectedPanelIds] = useState<Set<string>>(new Set());
        return (
          <>
            {selectedPanelIds.size > 0 ? (
              <button onClick={() => setSelectedPanelIds(new Set())}>
                {selectedPanelIds.size} selected
              </button>
            ) : null}
            <CanvasFlow
              panels={panels}
              allPanels={panels}
              groups={[]}
              connections={[{ id: 'workspace-association', sourceId: 'panel-one', targetId: 'panel-two' }]}
              viewport={{ x: 0, y: 0, zoom: 1 }}
              fileSource={{ kind: 'workspace', id: 'workspace-selection-test' }}
              selectedPanelIds={selectedPanelIds}
              readOnly
              onSelectionChange={(panelIds) => setSelectedPanelIds(new Set(panelIds))}
              onPaneClick={() => setSelectedPanelIds(new Set())}
            />
          </>
        );
      }

      render(<WorkspaceSelectionHarness />);
      ManualResizeObserver.notifyAll();

      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'One (markdown tile)' })).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Two (markdown tile)' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(1);
      });

      fireEvent.click(screen.getByRole('group', { name: 'One (markdown tile)' }));
      const selectedButton = await screen.findByRole('button', { name: '1 selected' });
      expect(screen.getByRole('group', { name: 'One (markdown tile), selected' })).toBeInTheDocument();

      fireEvent.click(selectedButton);

      expect(screen.queryByRole('button', { name: '1 selected' })).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'One (markdown tile)' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Two (markdown tile)' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Association between/ })).toHaveLength(1);
    } finally {
      vi.stubGlobal('ResizeObserver', nativeResizeObserver);
      vi.stubGlobal('DOMMatrixReadOnly', nativeDOMMatrixReadOnly);
      manualResizeObservers.clear();
    }
  });
});

describe('CanvasFlow keyboard view shortcuts', () => {
  it('uses the React Flow viewport helpers and opens the shortcut dialog', async () => {
    const onViewportChange = vi.fn();
    const onViewportChangeEnd = vi.fn();
    const onOpenShortcuts = vi.fn();
    renderCanvas(new Set(), { onViewportChange, onViewportChangeEnd, onOpenShortcuts });

    const canvas = screen.getByRole('region', { name: /Workspace canvas, 2 tiles/ });
    canvas.focus();
    fireEvent.keyDown(canvas, { key: '+' });
    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
    await waitFor(() => expect(onViewportChangeEnd).toHaveBeenCalledOnce());
    expect(onViewportChangeEnd).toHaveBeenCalledWith(expect.objectContaining({ zoom: expect.any(Number) }));

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
