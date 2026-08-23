import { describe, expect, it } from 'vitest';
import { findPanelConnection, makePanelConnection } from './panelConnections';

describe('panel connections', () => {
  it('creates a stable association regardless of selection order', () => {
    expect(makePanelConnection('cards', 'table')).toEqual({
      id: 'connection-cards-table',
      sourceId: 'cards',
      targetId: 'table',
    });
    expect(makePanelConnection('table', 'cards')).toEqual({
      id: 'connection-cards-table',
      sourceId: 'cards',
      targetId: 'table',
    });
  });

  it('finds an existing association in either endpoint direction', () => {
    const connection = { id: 'legacy-edge', sourceId: 'table', targetId: 'cards' };
    expect(findPanelConnection([connection], 'cards', 'table')).toEqual(connection);
    expect(findPanelConnection([connection], 'cards', 'markdown')).toBeUndefined();
  });

  it('keeps generated ids valid for the maximum panel id length', () => {
    const first = 'a'.repeat(200);
    const second = 'b'.repeat(200);
    const connection = makePanelConnection(first, second);

    expect(connection.id.length).toBeLessThanOrEqual(200);
    expect(connection.sourceId).toBe(first);
    expect(connection.targetId).toBe(second);
    expect(makePanelConnection(second, first).id).toBe(connection.id);
  });
});
