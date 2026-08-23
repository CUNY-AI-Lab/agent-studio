import type { PanelConnection } from '../domain/workspace';

export function connectionEndpointKey(sourceId: string, targetId: string): string {
  return [sourceId, targetId].sort().join('\u001f');
}

function endpointHash(endpointKey: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of endpointKey) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Create a stable association for explicit tool-created relationships. Keep
 * short ids readable while bounding unusual, schema-valid panel ids.
 */
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
