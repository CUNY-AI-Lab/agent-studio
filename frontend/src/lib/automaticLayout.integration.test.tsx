import { useEffect, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useAutomaticLayoutPersistence,
  type AutomaticLayoutTerminalState,
  type AutomaticPanelLayouts,
} from './automaticLayout';
import type { WorkspaceState } from '../types';

const layoutFirst = { x: -320, y: 48, width: 360, height: 220 };
const layoutSecond = { x: 60, y: 48, width: 360, height: 220 };
const manualFirst = { x: -640, y: 96, width: 420, height: 280 };
const manualSecond = { x: 120, y: 96, width: 420, height: 280 };

const streaming: AutomaticLayoutTerminalState = {
  status: 'streaming',
  isStreaming: true,
  isServerStreaming: true,
  isRecovering: false,
  isToolContinuation: false,
};

const ready: AutomaticLayoutTerminalState = {
  status: 'ready',
  isStreaming: false,
  isServerStreaming: false,
  isRecovering: false,
  isToolContinuation: false,
};

function workspaceState(
  firstLayout: WorkspaceState['panels'][number]['layout'],
  secondLayout: WorkspaceState['panels'][number]['layout'],
): WorkspaceState {
  return {
    sessionId: null,
    workspace: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [],
    panels: [
      { id: 'first', type: 'markdown', content: 'first', layout: firstLayout },
      { id: 'second', type: 'markdown', content: 'second', layout: secondLayout },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStateObserver() {
  let current: WorkspaceState | null = null;
  return {
    observe: (state: WorkspaceState) => {
      current = state;
    },
    read: () => {
      if (!current) throw new Error('The harness has not rendered a workspace state.');
      return current;
    },
  };
}

function PersistenceHarness({
  workspaceId,
  chat,
  initialState,
  snapshot,
  automaticLayouts,
  saveLayouts,
  onStateChange,
}: {
  workspaceId: string;
  chat: AutomaticLayoutTerminalState;
  initialState: WorkspaceState;
  snapshot?: WorkspaceState;
  automaticLayouts?: AutomaticPanelLayouts;
  saveLayouts: (layouts: AutomaticPanelLayouts) => Promise<void>;
  onStateChange?: (state: WorkspaceState) => void;
}) {
  const [state, setState] = useState(initialState);
  const [saveError, setSaveError] = useState('');
  const persistence = useAutomaticLayoutPersistence({
    workspaceId,
    chat,
    saveLayouts,
    onSaveError: setSaveError,
    onSaveSuccess: () => setSaveError(''),
  });
  const { enqueue, reapply } = persistence;

  useEffect(() => {
    if (!snapshot) return;
    setState(reapply(snapshot));
  }, [reapply, snapshot]);

  useEffect(() => {
    if (!automaticLayouts) return;
    if (enqueue(automaticLayouts)) setState((current) => reapply(current));
  }, [automaticLayouts, enqueue, reapply]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  const setManualLayouts = (layouts: AutomaticPanelLayouts) => {
    persistence.recordManualLayouts(layouts);
    setState((current) => reapply(current));
  };

  return (
    <div>
      <output data-testid="save-error">{saveError}</output>
      <button type="button" onClick={() => setManualLayouts({ first: manualFirst })}>Manual first</button>
      <button type="button" onClick={() => setManualLayouts({ first: manualFirst, second: manualSecond })}>Manual group</button>
      <button
        type="button"
        onClick={() => {
          persistence.recordRemoved(['first']);
          setState((current) => reapply(current));
        }}
      >
        Remove first
      </button>
      <button
        type="button"
        onClick={() => {
          setSaveError('');
          persistence.retry();
        }}
      >
        Retry layout save
      </button>
    </div>
  );
}

describe('automatic layout persistence integration', () => {
  it('drains layouts queued during a terminal RPC without parallel saves', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    const saves = vi.fn<(layouts: AutomaticPanelLayouts) => Promise<void>>();
    saves
      .mockImplementationOnce(async () => firstSave.promise)
      .mockImplementationOnce(async () => secondSave.promise);
    const observer = createStateObserver();

    const view = render(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );

    expect(saves).not.toHaveBeenCalled();
    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(undefined, undefined)}
        snapshot={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(observer.read().panels[0].layout).toEqual(layoutFirst);

    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={ready}
        initialState={workspaceState(undefined, undefined)}
        snapshot={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(1);

    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={ready}
        initialState={workspaceState(undefined, undefined)}
        snapshot={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst, second: layoutSecond }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(1);
    expect(observer.read().panels.map((panel) => panel.layout)).toEqual([layoutFirst, layoutSecond]);

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
      await Promise.resolve();
    });
    expect(saves).toHaveBeenCalledTimes(2);
    expect(saves.mock.calls[1][0]).toEqual({ second: layoutSecond });

    await act(async () => {
      secondSave.resolve();
      await secondSave.promise;
    });
  });

  it('latches a failure across unrelated terminal updates until explicit retry', async () => {
    const saves = vi
      .fn<(layouts: AutomaticPanelLayouts) => Promise<void>>()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(undefined);
    const observer = createStateObserver();

    const view = render(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={ready}
        initialState={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('save-error')).toHaveTextContent('Retry layout save');

    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={{ ...ready, status: 'error' }}
        initialState={workspaceState(undefined, undefined)}
        snapshot={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByRole('button', { name: 'Retry layout save' }).click();
      await Promise.resolve();
    });
    expect(saves).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('save-error')).toHaveTextContent('');
  });

  it('keeps manual tile and group ownership over stale full snapshots and removal', async () => {
    const saves = vi.fn<(layouts: AutomaticPanelLayouts) => Promise<void>>().mockResolvedValue(undefined);
    const observer = createStateObserver();
    const view = render(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(layoutFirst, layoutSecond)}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );

    screen.getByRole('button', { name: 'Manual first' }).click();
    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(layoutFirst, layoutSecond)}
        snapshot={workspaceState(undefined, layoutSecond)}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(observer.read().panels[0].layout).toEqual(manualFirst);

    screen.getByRole('button', { name: 'Manual group' }).click();
    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(layoutFirst, layoutSecond)}
        snapshot={workspaceState({ x: 0, y: 0, width: 200, height: 180 }, undefined)}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(observer.read().panels.map((panel) => panel.layout)).toEqual([manualFirst, manualSecond]);

    screen.getByRole('button', { name: 'Remove first' }).click();
    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={streaming}
        initialState={workspaceState(layoutFirst, layoutSecond)}
        snapshot={workspaceState(undefined, undefined)}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(observer.read().panels.map((panel) => panel.id)).toEqual(['second']);
    expect(saves).not.toHaveBeenCalled();
  });

  it('scopes unresolved completions to the workspace that created them', async () => {
    const oldSave = deferred<void>();
    const newSave = deferred<void>();
    const saves = vi
      .fn<(layouts: AutomaticPanelLayouts) => Promise<void>>()
      .mockImplementationOnce(async () => oldSave.promise)
      .mockImplementationOnce(async () => newSave.promise);
    const observer = createStateObserver();
    const view = render(
      <PersistenceHarness
        workspaceId="workspace-a"
        chat={ready}
        initialState={workspaceState(undefined, undefined)}
        automaticLayouts={{ first: layoutFirst }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(1);

    view.rerender(
      <PersistenceHarness
        workspaceId="workspace-b"
        chat={ready}
        initialState={workspaceState(undefined, undefined)}
        snapshot={workspaceState(undefined, undefined)}
        automaticLayouts={{ second: layoutSecond }}
        saveLayouts={saves}
        onStateChange={observer.observe}
      />,
    );
    await act(async () => undefined);
    expect(saves).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldSave.resolve();
      await oldSave.promise;
      await Promise.resolve();
    });
    expect(screen.getByTestId('save-error')).toHaveTextContent('');
    expect(observer.read().panels[1].layout).toEqual(layoutSecond);

    await act(async () => {
      newSave.resolve();
      await newSave.promise;
    });
  });
});
