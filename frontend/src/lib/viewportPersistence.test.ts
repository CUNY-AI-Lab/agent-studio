import { describe, expect, it } from 'vitest';
import {
  createViewportPersistenceQueue,
  type ViewportPersistenceResult,
} from './viewportPersistence';
import type { WorkspaceState, WorkspaceViewport } from '../types';

const firstViewport: WorkspaceViewport = { x: -120, y: -80, zoom: 1.2 };
const finalViewport: WorkspaceViewport = { x: -240, y: -160, zoom: 0.9 };

function workspaceState(id: string, viewport: WorkspaceViewport): WorkspaceState {
  return {
    sessionId: null,
    workspace: {
      id,
      name: 'Test workspace',
      description: '',
      createdAt: '',
      updatedAt: '',
    },
    panels: [],
    viewport,
    groups: [],
    connections: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('viewport persistence queue', () => {
  it('does not write the viewport that was already loaded from the server', async () => {
    const queue = createViewportPersistenceQueue('workspace-one', firstViewport);
    expect(queue.enqueue(firstViewport)).toBe(false);
    expect(await queue.flush(async () => undefined)).toBe('idle');
  });

  it('coalesces terminal viewport updates and serializes writes', async () => {
    const queue = createViewportPersistenceQueue('workspace-one');
    const saves: WorkspaceViewport[] = [];
    const firstSave = deferred<void>();

    queue.enqueue(firstViewport);
    const firstFlush = queue.flush(async (viewport) => {
      saves.push(viewport);
      await firstSave.promise;
    });

    queue.enqueue({ x: -160, y: -110, zoom: 1.1 });
    queue.enqueue(finalViewport);
    expect(saves).toEqual([firstViewport]);
    expect(await queue.flush(async () => undefined)).toBe('in-flight');

    firstSave.resolve();
    expect(await firstFlush).toBe('saved');
    expect(queue.pending()).toEqual(finalViewport);

    expect(await queue.flush(async (viewport) => {
      saves.push(viewport);
    })).toBe('saved');
    expect(saves).toEqual([firstViewport, finalViewport]);
  });

  it('keeps a failed terminal value until an explicit retry', async () => {
    const queue = createViewportPersistenceQueue('workspace-one');
    queue.enqueue(finalViewport);

    const failed = await queue.flush(async () => {
      throw new Error('injected save failure');
    });
    expect(failed).toBe<ViewportPersistenceResult>('failed');
    expect(queue.hasFailure()).toBe(true);
    expect(queue.pending()).toEqual(finalViewport);
    expect(await queue.flush(async () => undefined)).toBe('blocked');

    queue.retry();
    expect(await queue.flush(async () => undefined)).toBe('saved');
    expect(queue.hasFailure()).toBe(false);
    expect(queue.pending()).toBeNull();
  });

  it('does not reapply or retain a viewport across workspaces', async () => {
    const queue = createViewportPersistenceQueue('workspace-one');
    queue.enqueue(finalViewport);

    expect(queue.reapply(workspaceState('workspace-one', firstViewport)).viewport).toEqual(finalViewport);
    expect(queue.reapply(workspaceState('workspace-two', firstViewport)).viewport).toEqual(firstViewport);
  });
});
