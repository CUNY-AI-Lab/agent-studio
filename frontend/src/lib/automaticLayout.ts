import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelLayout, WorkspaceState } from '../types';

export type AutomaticPanelLayout = Required<PanelLayout>;
export type AutomaticPanelLayouts = Record<string, AutomaticPanelLayout>;

export type AutomaticLayoutFlushResult =
  | 'idle'
  | 'in-flight'
  | 'saved'
  | 'failed'
  | 'blocked'
  | 'superseded';

export interface AutomaticLayoutTerminalState {
  status: string;
  isStreaming: boolean;
  isServerStreaming: boolean;
  isRecovering: boolean;
  isToolContinuation: boolean;
}

export function isAutomaticLayoutFlushReady(state: AutomaticLayoutTerminalState): boolean {
  return (
    (state.status === 'ready' || state.status === 'error') &&
    !state.isStreaming &&
    !state.isServerStreaming &&
    !state.isRecovering &&
    !state.isToolContinuation
  );
}

function layoutsEqual(left: PanelLayout | undefined, right: PanelLayout): boolean {
  return (
    left?.x === right.x &&
    left?.y === right.y &&
    left?.width === right.width &&
    left?.height === right.height
  );
}

function cloneLayouts(layouts: AutomaticPanelLayouts): AutomaticPanelLayouts {
  return Object.fromEntries(
    Object.entries(layouts).map(([panelId, layout]) => [panelId, { ...layout }]),
  );
}

/**
 * Keep the first automatic placement for a tile until it is acknowledged.
 * Repeated server snapshots must not create a new placement or a new save.
 */
export function enqueueAutomaticLayouts(
  pending: AutomaticPanelLayouts,
  layouts: AutomaticPanelLayouts,
): AutomaticPanelLayouts {
  const next = { ...pending };
  let changed = false;

  for (const [panelId, layout] of Object.entries(layouts)) {
    if (next[panelId]) continue;
    next[panelId] = { ...layout };
    changed = true;
  }

  return changed ? next : pending;
}

/**
 * A successful patch acknowledges only the values it contained. If another
 * placement was queued while the request was in flight, that newer value
 * remains pending for the next explicit terminal flush.
 */
export function acknowledgeAutomaticLayouts(
  pending: AutomaticPanelLayouts,
  saved: AutomaticPanelLayouts,
) {
  const next = { ...pending };
  for (const [panelId, layout] of Object.entries(saved)) {
    if (next[panelId] && layoutsEqual(next[panelId], layout)) {
      delete next[panelId];
    }
  }
  return next;
}

export interface AutomaticLayoutQueue {
  enqueue(layouts: AutomaticPanelLayouts): boolean;
  recordManualLayouts(layouts: AutomaticPanelLayouts): void;
  recordRemoved(panelIds: Iterable<string>): void;
  cancelRemoved(panelIds: Iterable<string>): void;
  discard(panelIds: Iterable<string>): void;
  hasPending(): boolean;
  hasFailure(): boolean;
  pending(): AutomaticPanelLayouts;
  reapply(state: WorkspaceState): WorkspaceState;
  acknowledgeServerState(state: WorkspaceState): WorkspaceState;
  flush(save: (layouts: AutomaticPanelLayouts) => Promise<void>): Promise<AutomaticLayoutFlushResult>;
  retry(): void;
}

export function createAutomaticLayoutQueue(): AutomaticLayoutQueue {
  let pendingLayouts: AutomaticPanelLayouts = {};
  let inFlight = false;
  let failureLatched = false;
  const manualLayouts: AutomaticPanelLayouts = {};
  const removedPanelIds = new Set<string>();
  const clearFailureWhenEmpty = () => {
    if (Object.keys(pendingLayouts).length === 0) failureLatched = false;
  };
  const reapplyState = (state: WorkspaceState): WorkspaceState => {
    let changed = false;
    const panels = state.panels
      .filter((panel) => {
        if (!removedPanelIds.has(panel.id)) return true;
        changed = true;
        return false;
      })
      .map((panel) => {
        const manualLayout = manualLayouts[panel.id];
        const automaticLayout = pendingLayouts[panel.id];
        const layout = manualLayout ?? automaticLayout;
        if (!layout || layoutsEqual(panel.layout, layout)) return panel;
        changed = true;
        return {
          ...panel,
          layout: {
            ...panel.layout,
            ...layout,
          },
        };
      });

    return changed ? { ...state, panels } : state;
  };
  const acknowledgeServerState = (state: WorkspaceState): WorkspaceState => {
    const panelsById = new Map(state.panels.map((panel) => [panel.id, panel]));
    for (const [panelId, layout] of Object.entries(manualLayouts)) {
      const serverPanel = panelsById.get(panelId);
      if (serverPanel && layoutsEqual(serverPanel.layout, layout)) {
        delete manualLayouts[panelId];
      }
    }
    for (const panelId of removedPanelIds) {
      if (!panelsById.has(panelId)) removedPanelIds.delete(panelId);
    }
    return reapplyState(state);
  };

  return {
    enqueue(layouts) {
      const next = enqueueAutomaticLayouts(pendingLayouts, layouts);
      if (next === pendingLayouts) return false;
      pendingLayouts = next;
      return true;
    },

    recordManualLayouts(layouts) {
      for (const [panelId, layout] of Object.entries(layouts)) {
        delete pendingLayouts[panelId];
        removedPanelIds.delete(panelId);
        manualLayouts[panelId] = { ...layout };
      }
      clearFailureWhenEmpty();
    },

    recordRemoved(panelIds) {
      for (const panelId of panelIds) {
        delete pendingLayouts[panelId];
        delete manualLayouts[panelId];
        removedPanelIds.add(panelId);
      }
      clearFailureWhenEmpty();
    },

    cancelRemoved(panelIds) {
      for (const panelId of panelIds) {
        removedPanelIds.delete(panelId);
      }
    },

    discard(panelIds) {
      for (const panelId of panelIds) {
        delete pendingLayouts[panelId];
      }
      clearFailureWhenEmpty();
    },

    hasPending() {
      return Object.keys(pendingLayouts).length > 0;
    },

    hasFailure() {
      return failureLatched;
    },

    pending() {
      return cloneLayouts(pendingLayouts);
    },

    reapply: reapplyState,
    acknowledgeServerState,

    async flush(save) {
      if (failureLatched) return 'blocked';
      if (inFlight) return 'in-flight';
      if (Object.keys(pendingLayouts).length === 0) return 'idle';

      const savedLayouts = cloneLayouts(pendingLayouts);
      inFlight = true;
      try {
        await save(savedLayouts);
        pendingLayouts = acknowledgeAutomaticLayouts(pendingLayouts, savedLayouts);
        return 'saved';
      } catch {
        const savedLayoutsStillPending = Object.entries(savedLayouts).some(
          ([panelId, layout]) => pendingLayouts[panelId] && layoutsEqual(pendingLayouts[panelId], layout),
        );
        if (!savedLayoutsStillPending) return 'superseded';
        failureLatched = true;
        return 'failed';
      } finally {
        inFlight = false;
      }
    },

    retry() {
      failureLatched = false;
    },
  };
}

export interface AutomaticLayoutPersistenceOptions {
  workspaceId: string;
  chat: AutomaticLayoutTerminalState;
  saveLayouts: (layouts: AutomaticPanelLayouts) => Promise<void>;
  onSaveError?: (message: string) => void;
  onSaveSuccess?: () => void;
}

export interface AutomaticLayoutPersistence {
  reapply(state: WorkspaceState): WorkspaceState;
  acknowledgeServerState(state: WorkspaceState): WorkspaceState;
  enqueue(layouts: AutomaticPanelLayouts): boolean;
  recordManualLayouts(layouts: AutomaticPanelLayouts): void;
  recordRemoved(panelIds: Iterable<string>): void;
  cancelRemoved(panelIds: Iterable<string>): void;
  discard(panelIds: Iterable<string>): void;
  hasFailure(): boolean;
  retry(): void;
}

/**
 * React boundary for automatic layout persistence. The coordinator is scoped
 * to one workspace instance; a switch replaces it so an unresolved old RPC
 * cannot affect the new workspace.
 */
export function useAutomaticLayoutPersistence({
  workspaceId,
  chat,
  saveLayouts,
  onSaveError,
  onSaveSuccess,
}: AutomaticLayoutPersistenceOptions): AutomaticLayoutPersistence {
  const controllerRef = useRef<{ workspaceId: string; queue: AutomaticLayoutQueue }>({
    workspaceId,
    queue: createAutomaticLayoutQueue(),
  });
  if (controllerRef.current.workspaceId !== workspaceId) {
    controllerRef.current = {
      workspaceId,
      queue: createAutomaticLayoutQueue(),
    };
  }

  const saveLayoutsRef = useRef(saveLayouts);
  saveLayoutsRef.current = saveLayouts;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;
  const onSaveSuccessRef = useRef(onSaveSuccess);
  onSaveSuccessRef.current = onSaveSuccess;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [revision, setRevision] = useState(0);

  const reapply = useCallback((state: WorkspaceState) => (
    controllerRef.current.queue.reapply(state)
  ), []);
  const acknowledgeServerState = useCallback((state: WorkspaceState) => (
    controllerRef.current.queue.acknowledgeServerState(state)
  ), []);
  const enqueue = useCallback((layouts: AutomaticPanelLayouts) => {
    const changed = controllerRef.current.queue.enqueue(layouts);
    if (changed) setRevision((current) => current + 1);
    return changed;
  }, []);
  const recordManualLayouts = useCallback((layouts: AutomaticPanelLayouts) => {
    controllerRef.current.queue.recordManualLayouts(layouts);
  }, []);
  const recordRemoved = useCallback((panelIds: Iterable<string>) => {
    controllerRef.current.queue.recordRemoved(panelIds);
  }, []);
  const cancelRemoved = useCallback((panelIds: Iterable<string>) => {
    controllerRef.current.queue.cancelRemoved(panelIds);
  }, []);
  const discard = useCallback((panelIds: Iterable<string>) => {
    controllerRef.current.queue.discard(panelIds);
  }, []);
  const retry = useCallback(() => {
    controllerRef.current.queue.retry();
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!isAutomaticLayoutFlushReady(chat) || !controller.queue.hasPending()) return;

    void controller.queue.flush((layouts) => saveLayoutsRef.current(layouts)).then((result) => {
      if (!mountedRef.current || controller !== controllerRef.current) return;
      if (result === 'failed') {
        onSaveErrorRef.current?.('New tile positions could not be saved. Retry layout save.');
        return;
      }
      if (result === 'saved') {
        onSaveSuccessRef.current?.();
        if (controller.queue.hasPending()) setRevision((current) => current + 1);
        return;
      }
      if (result === 'superseded' && controller.queue.hasPending()) {
        setRevision((current) => current + 1);
      }
    });
  }, [
    chat.isRecovering,
    chat.isServerStreaming,
    chat.isStreaming,
    chat.isToolContinuation,
    chat.status,
    revision,
    workspaceId,
  ]);

  return {
    reapply,
    acknowledgeServerState,
    enqueue,
    recordManualLayouts,
    recordRemoved,
    cancelRemoved,
    discard,
    hasFailure: () => controllerRef.current.queue.hasFailure(),
    retry,
  };
}
