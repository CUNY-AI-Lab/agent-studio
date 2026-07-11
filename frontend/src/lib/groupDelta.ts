import type { PanelGroup } from '../types';

export interface GroupsDelta {
  /** Groups that are new or changed relative to the base snapshot. */
  upserts: PanelGroup[];
  /** Ids of groups present in the base snapshot but absent from the next one. */
  removeIds: string[];
}

function groupsEqual(left: PanelGroup, right: PanelGroup): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.color === right.color &&
    left.panelIds.length === right.panelIds.length &&
    left.panelIds.every((panelId, index) => panelId === right.panelIds[index])
  );
}

/**
 * Diff a whole-array group edit against the snapshot it was computed from,
 * producing the per-id delta the server's applyLayoutPatch expects. Sending
 * only what THIS edit changed (plus explicit removals) means a concurrent
 * edit to a different group in another tab survives instead of being
 * clobbered by a stale whole-array snapshot (V3).
 */
export function computeGroupsDelta(previous: PanelGroup[], next: PanelGroup[]): GroupsDelta {
  const previousById = new Map(previous.map((group) => [group.id, group]));
  const nextIds = new Set(next.map((group) => group.id));

  return {
    upserts: next.filter((group) => {
      const before = previousById.get(group.id);
      return !before || !groupsEqual(before, group);
    }),
    removeIds: previous.filter((group) => !nextIds.has(group.id)).map((group) => group.id),
  };
}
