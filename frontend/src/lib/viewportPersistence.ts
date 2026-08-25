import type { WorkspaceState, WorkspaceViewport } from '../types';

export type ViewportPersistenceResult =
  | 'idle'
  | 'in-flight'
  | 'saved'
  | 'failed'
  | 'blocked'
  | 'stale'
  | 'superseded';

export interface ViewportPersistenceQueue {
  enqueue(viewport: WorkspaceViewport): boolean;
  pending(): WorkspaceViewport | null;
  latest(): WorkspaceViewport | null;
  hasPending(): boolean;
  hasFailure(): boolean;
  reapply(state: WorkspaceState): WorkspaceState;
  flush(save: (viewport: WorkspaceViewport) => Promise<void>): Promise<ViewportPersistenceResult>;
  retry(): void;
  reset(): void;
}

function viewportsEqual(left: WorkspaceViewport | null, right: WorkspaceViewport | null): boolean {
  return Boolean(
    left && right
    && left.x === right.x
    && left.y === right.y
    && left.zoom === right.zoom,
  );
}

function cloneViewport(viewport: WorkspaceViewport): WorkspaceViewport {
  return { ...viewport };
}

/**
 * Coalesce viewport writes after React Flow reports an interaction boundary.
 * The queue never starts a second RPC while one is unresolved and keeps a
 * newer terminal viewport for the next drain. A failed current viewport stays
 * blocked until the user explicitly retries.
 */
export function createViewportPersistenceQueue(
  workspaceId: string,
  initialViewport?: WorkspaceViewport,
): ViewportPersistenceQueue {
  let pendingViewport: WorkspaceViewport | null = null;
  let inFlight: { viewport: WorkspaceViewport; generation: number } | null = null;
  let lastSavedViewport = initialViewport ? cloneViewport(initialViewport) : null;
  let generation = 0;
  let failureLatched = false;

  return {
    enqueue(viewport) {
      if (viewportsEqual(pendingViewport ?? inFlight?.viewport ?? null, viewport)) return false;
      if (!pendingViewport && !inFlight && viewportsEqual(lastSavedViewport, viewport)) return false;
      pendingViewport = cloneViewport(viewport);
      return true;
    },

    pending() {
      return pendingViewport ? cloneViewport(pendingViewport) : null;
    },

    latest() {
      const viewport = pendingViewport ?? inFlight?.viewport ?? null;
      return viewport ? cloneViewport(viewport) : null;
    },

    hasPending() {
      return pendingViewport !== null;
    },

    hasFailure() {
      return failureLatched;
    },

    reapply(state) {
      if (state.workspace?.id !== workspaceId) return state;
      const viewport = pendingViewport ?? inFlight?.viewport;
      if (!viewport || viewportsEqual(state.viewport, viewport)) return state;
      return { ...state, viewport: cloneViewport(viewport) };
    },

    async flush(save) {
      if (failureLatched) return 'blocked';
      if (inFlight) return 'in-flight';
      if (!pendingViewport) return 'idle';

      const viewport = cloneViewport(pendingViewport);
      pendingViewport = null;
      const flushGeneration = generation;
      inFlight = { viewport, generation: flushGeneration };

      try {
        await save(viewport);
        if (flushGeneration !== generation) return 'stale';
        if (viewportsEqual(pendingViewport, viewport)) pendingViewport = null;
        lastSavedViewport = viewport;
        return 'saved';
      } catch {
        if (flushGeneration !== generation) return 'stale';
        if (pendingViewport) return 'superseded';
        pendingViewport = viewport;
        failureLatched = true;
        return 'failed';
      } finally {
        if (inFlight?.generation === flushGeneration) inFlight = null;
      }
    },

    retry() {
      failureLatched = false;
    },

    reset() {
      generation += 1;
      pendingViewport = null;
      inFlight = null;
      lastSavedViewport = null;
      failureLatched = false;
    },
  };
}
