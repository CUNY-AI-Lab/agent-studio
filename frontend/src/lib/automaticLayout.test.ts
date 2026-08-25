import { describe, expect, it, vi } from 'vitest';
import {
  createAutomaticLayoutQueue,
  isAutomaticLayoutFlushReady,
  type AutomaticPanelLayout,
} from './automaticLayout';
import type { WorkspaceState } from '../types';

const layoutA: AutomaticPanelLayout = { x: -320, y: 48, width: 360, height: 220 };
const layoutB: AutomaticPanelLayout = { x: 60, y: 48, width: 360, height: 220 };

function stateWithLayouts(
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

describe('automatic layout queue', () => {
  it('reapplies queued placement over repeated layout-less server snapshots', () => {
    const queue = createAutomaticLayoutQueue();
    queue.enqueue({ first: layoutA, second: layoutB });

    const streamedSnapshots = [
      stateWithLayouts(undefined, undefined),
      stateWithLayouts({ x: 0, y: 0 }, undefined),
      stateWithLayouts(undefined, { x: 16, y: 16 }),
    ];

    for (const snapshot of streamedSnapshots) {
      const local = queue.reapply(snapshot);
      expect(local.panels[0].layout).toEqual(layoutA);
      expect(local.panels[1].layout).toEqual(layoutB);
    }
  });

  it('coalesces duplicate panel ids and sends one concurrent terminal save', async () => {
    const queue = createAutomaticLayoutQueue();
    expect(queue.enqueue({ first: layoutA })).toBe(true);
    expect(queue.enqueue({ first: { ...layoutA, x: -640 }, second: layoutB })).toBe(true);
    expect(queue.pending()).toEqual({ first: layoutA, second: layoutB });

    let resolveSave!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));

    const firstFlush = queue.flush(save);
    const secondFlush = queue.flush(save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await secondFlush).toBe('in-flight');

    resolveSave();
    expect(await firstFlush).toBe('saved');
    expect(queue.hasPending()).toBe(false);
  });

  it('keeps failed placements for an explicit retry and only clears after success', async () => {
    const queue = createAutomaticLayoutQueue();
    queue.enqueue({ first: layoutA });
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(undefined);

    expect(await queue.flush(save)).toBe('failed');
    expect(queue.pending()).toEqual({ first: layoutA });
    expect(await queue.flush(save)).toBe('blocked');
    queue.retry();
    expect(await queue.flush(save)).toBe('saved');
    expect(queue.hasPending()).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not latch a failure after a manual edit supersedes the in-flight placement', async () => {
    const queue = createAutomaticLayoutQueue();
    let rejectOld!: (reason: Error) => void;
    const oldSave = new Promise<void>((_, reject) => {
      rejectOld = reject;
    });
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => oldSave)
      .mockResolvedValueOnce(undefined);

    queue.enqueue({ first: layoutA });
    const firstFlush = queue.flush(save);
    queue.recordManualLayouts({ first: { ...layoutA, x: -640 } });
    queue.enqueue({ second: layoutB });
    rejectOld(new Error('superseded by manual edit'));

    expect(await firstFlush).toBe('superseded');
    expect(queue.hasFailure()).toBe(false);
    expect(queue.pending()).toEqual({ second: layoutB });
    expect(await queue.flush(save)).toBe('saved');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not flush until every chat stream and continuation flag is settled', () => {
    const base = {
      status: 'ready',
      isStreaming: false,
      isServerStreaming: false,
      isRecovering: false,
      isToolContinuation: false,
    };
    expect(isAutomaticLayoutFlushReady(base)).toBe(true);
    expect(isAutomaticLayoutFlushReady({ ...base, status: 'streaming' })).toBe(false);
    expect(isAutomaticLayoutFlushReady({ ...base, isServerStreaming: true })).toBe(false);
    expect(isAutomaticLayoutFlushReady({ ...base, isRecovering: true })).toBe(false);
    expect(isAutomaticLayoutFlushReady({ ...base, isToolContinuation: true })).toBe(false);
    expect(isAutomaticLayoutFlushReady({ ...base, status: 'error' })).toBe(true);
  });
});
