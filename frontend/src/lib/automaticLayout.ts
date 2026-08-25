import type { PanelLayout, WorkspaceState } from '../types';

export type AutomaticPanelLayout = Required<PanelLayout>;
export type AutomaticPanelLayouts = Record<string, AutomaticPanelLayout>;

export type AutomaticLayoutFlushResult = 'idle' | 'in-flight' | 'saved' | 'failed';

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
 * Reapply local automatic placements over a server snapshot while their save
 * is outstanding. This keeps a streamed snapshot from making tiles jump back
 * to inferred positions or triggering the placement effect again.
 */
export function reapplyAutomaticLayouts(
  state: WorkspaceState,
  pending: AutomaticPanelLayouts,
): WorkspaceState {
  let changed = false;
  const panels = state.panels.map((panel) => {
    const layout = pending[panel.id];
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
  discard(panelIds: Iterable<string>): void;
  hasPending(): boolean;
  pending(): AutomaticPanelLayouts;
  reapply(state: WorkspaceState): WorkspaceState;
  flush(save: (layouts: AutomaticPanelLayouts) => Promise<void>): Promise<AutomaticLayoutFlushResult>;
  reset(): void;
}

export function createAutomaticLayoutQueue(): AutomaticLayoutQueue {
  let pendingLayouts: AutomaticPanelLayouts = {};
  let saveInFlight = false;

  return {
    enqueue(layouts) {
      const next = enqueueAutomaticLayouts(pendingLayouts, layouts);
      if (next === pendingLayouts) return false;
      pendingLayouts = next;
      return true;
    },

    discard(panelIds) {
      for (const panelId of panelIds) {
        delete pendingLayouts[panelId];
      }
    },

    hasPending() {
      return Object.keys(pendingLayouts).length > 0;
    },

    pending() {
      return cloneLayouts(pendingLayouts);
    },

    reapply(state) {
      return reapplyAutomaticLayouts(state, pendingLayouts);
    },

    async flush(save) {
      if (saveInFlight) return 'in-flight';
      if (!this.hasPending()) return 'idle';

      const savedLayouts = cloneLayouts(pendingLayouts);
      saveInFlight = true;
      try {
        await save(savedLayouts);
        pendingLayouts = acknowledgeAutomaticLayouts(pendingLayouts, savedLayouts);
        return 'saved';
      } catch {
        return 'failed';
      } finally {
        saveInFlight = false;
      }
    },

    reset() {
      pendingLayouts = {};
      saveInFlight = false;
    },
  };
}
