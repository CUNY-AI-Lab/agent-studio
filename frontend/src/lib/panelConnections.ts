import type { PanelConnection, WorkspacePanel } from '../types';

export interface NormalizedPanelRelations {
  panels: WorkspacePanel[];
  connections: PanelConnection[];
}

/**
 * Connections are associations between two tiles. The endpoint order is
 * canonical for user-created associations so repeated clicks cannot create
 * duplicates, while existing provenance connections keep their stored id.
 */
export function connectionEndpointKey(sourceId: string, targetId: string): string {
  // JSON preserves the tuple boundary even when a schema-valid panel id
  // contains the old delimiter character.
  return JSON.stringify([sourceId, targetId].sort());
}

function endpointHash(endpointKey: string): string {
  // Panel ids are normally UUIDs, but the panel schema permits longer ids. Keep
  // generated connection ids within the same 200-character boundary as panel
  // ids instead of silently creating a patch the Worker will reject.
  let hash = 0xcbf29ce484222325n;
  for (const character of endpointKey) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function findPanelConnection(
  connections: PanelConnection[],
  firstId: string,
  secondId: string,
): PanelConnection | undefined {
  const key = connectionEndpointKey(firstId, secondId);
  return connections.find(
    (connection) => connectionEndpointKey(connection.sourceId, connection.targetId) === key,
  );
}

export function makePanelConnection(firstId: string, secondId: string): PanelConnection {
  const [sourceId, targetId] = [firstId, secondId].sort();
  const readableId = `connection-${sourceId}-${targetId}`;
  return {
    id: readableId.length <= 200
      ? readableId
      : `connection-${endpointHash(connectionEndpointKey(sourceId, targetId))}`,
    sourceId,
    targetId,
  };
}

/** Repair a generated id before an optimistic or ID-keyed merge. */
export function repairPanelConnectionId(
  connection: PanelConnection,
  occupiedConnections: PanelConnection[],
): PanelConnection {
  const endpoint = connectionEndpointKey(connection.sourceId, connection.targetId);
  const hasConflictingId = occupiedConnections.some(
    (occupied) => occupied.id === connection.id
      && connectionEndpointKey(occupied.sourceId, occupied.targetId) !== endpoint,
  );
  if (!hasConflictingId) return connection;
  const id = uniqueConnectionId(connection, new Set(occupiedConnections.map(({ id }) => id)));
  return { ...connection, id };
}

function uniqueConnectionId(
  connection: PanelConnection,
  usedIds: Set<string>,
): string {
  if (!usedIds.has(connection.id)) return connection.id;
  const base = `connection-${endpointHash(connectionEndpointKey(connection.sourceId, connection.targetId))}`;
  if (!usedIds.has(base)) return base;
  let suffix = 1;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function validRelationSource(
  panelId: string,
  sourceId: string | undefined,
  panelIds: Set<string>,
): string | undefined {
  if (!sourceId || sourceId === panelId || !panelIds.has(sourceId)) return undefined;
  return sourceId;
}

/** Remove fields represented by an explicit edge deletion before normalizing. */
export function clearPanelRelationFields(
  panels: WorkspacePanel[],
  removedConnections: PanelConnection[],
): WorkspacePanel[] {
  const removedEndpoints = new Set(
    removedConnections.map((connection) => connectionEndpointKey(connection.sourceId, connection.targetId)),
  );
  if (removedEndpoints.size === 0) return panels;

  return panels.map((panel) => {
    const sourcePanelId = panel.sourcePanelId
      && removedEndpoints.has(connectionEndpointKey(panel.id, panel.sourcePanelId))
      ? undefined
      : panel.sourcePanelId;

    if (panel.type !== 'detail') {
      return sourcePanelId === panel.sourcePanelId ? panel : { ...panel, sourcePanelId };
    }

    const linkedTo = panel.linkedTo
      && removedEndpoints.has(connectionEndpointKey(panel.id, panel.linkedTo))
      ? undefined
      : panel.linkedTo;
    if (sourcePanelId === panel.sourcePanelId && linkedTo === panel.linkedTo) return panel;
    return { ...panel, sourcePanelId, linkedTo };
  });
}

/** Keep UI state in step with the Worker after a connection is removed. */
export function normalizePanelRelations(
  panels: WorkspacePanel[],
  connections: PanelConnection[],
): NormalizedPanelRelations {
  const panelIds = new Set(panels.map((panel) => panel.id));
  const seenEndpoints = new Set<string>();
  const usedConnectionIds = new Set<string>();
  const normalizedConnections: PanelConnection[] = [];
  for (const connection of connections) {
    if (!panelIds.has(connection.sourceId) || !panelIds.has(connection.targetId)) continue;
    if (connection.sourceId === connection.targetId) continue;
    const endpoint = connectionEndpointKey(connection.sourceId, connection.targetId);
    if (seenEndpoints.has(endpoint)) continue;
    seenEndpoints.add(endpoint);
    const id = uniqueConnectionId(connection, usedConnectionIds);
    normalizedConnections.push(id === connection.id ? connection : { ...connection, id });
    usedConnectionIds.add(id);
  }

  const ensureConnection = (panelId: string, sourceId: string): void => {
    const endpoint = connectionEndpointKey(panelId, sourceId);
    if (seenEndpoints.has(endpoint)) return;
    seenEndpoints.add(endpoint);
    const connection = makePanelConnection(panelId, sourceId);
    const id = uniqueConnectionId(connection, usedConnectionIds);
    normalizedConnections.push(id === connection.id ? connection : { ...connection, id });
    usedConnectionIds.add(id);
  };

  const normalizedPanels = panels.map((panel) => {
    const sourcePanelId = validRelationSource(panel.id, panel.sourcePanelId, panelIds);
    if (sourcePanelId) ensureConnection(panel.id, sourcePanelId);

    if (panel.type !== 'detail') {
      if (panel.sourcePanelId === sourcePanelId) return panel;
      return { ...panel, sourcePanelId };
    }

    const linkedTo = validRelationSource(panel.id, panel.linkedTo, panelIds);
    if (linkedTo) ensureConnection(panel.id, linkedTo);
    if (panel.sourcePanelId === sourcePanelId && panel.linkedTo === linkedTo) return panel;
    return { ...panel, sourcePanelId, linkedTo };
  });

  return {
    connections: normalizedConnections,
    panels: normalizedPanels,
  };
}
