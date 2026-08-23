import { describe, expect, it } from 'vitest';
import {
  clearPanelRelationFields,
  findPanelConnection,
  makePanelConnection,
  normalizePanelRelations,
} from './panelConnections';

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

  it('repairs persisted detail fields when their edge is missing', () => {
    const panels = [
      { id: 'source', type: 'markdown' as const, content: '' },
      { id: 'detail', type: 'detail' as const, linkedTo: 'source', sourcePanelId: 'source' },
    ];
    const normalized = normalizePanelRelations(panels, []);
    expect(normalized.panels[1]).toMatchObject({ id: 'detail', sourcePanelId: 'source', linkedTo: 'source' });
    expect(normalized.connections).toEqual([
      { id: 'connection-detail-source', sourceId: 'detail', targetId: 'source' },
    ]);
    expect(normalizePanelRelations(normalized.panels, normalized.connections)).toEqual(normalized);
  });

  it('preserves each valid detail field independently and creates both edges', () => {
    const panels = [
      { id: 'source-a', type: 'markdown' as const, content: '' },
      { id: 'source-b', type: 'markdown' as const, content: '' },
      { id: 'detail', type: 'detail' as const, linkedTo: 'source-a', sourcePanelId: 'source-b' },
    ];
    const normalized = normalizePanelRelations(panels, []);

    expect(normalized.panels[2]).toMatchObject({
      id: 'detail',
      linkedTo: 'source-a',
      sourcePanelId: 'source-b',
    });
    expect(normalized.connections.map(({ sourceId, targetId }) => [sourceId, targetId])).toEqual([
      ['detail', 'source-b'],
      ['detail', 'source-a'],
    ]);
  });

  it('keeps manual edges without inventing provenance and collapses invalid duplicates', () => {
    const panels = [
      { id: 'source', type: 'markdown' as const, content: '' },
      { id: 'target', type: 'markdown' as const, content: '' },
    ];
    const normalized = normalizePanelRelations(panels, [
      { id: 'manual', sourceId: 'target', targetId: 'source' },
      { id: 'duplicate', sourceId: 'source', targetId: 'target' },
      { id: 'dangling', sourceId: 'source', targetId: 'missing' },
      { id: 'self', sourceId: 'source', targetId: 'source' },
    ]);

    expect(normalized.connections).toEqual([
      { id: 'manual', sourceId: 'target', targetId: 'source' },
    ]);
    expect(normalized.panels.every((panel) => panel.sourcePanelId === undefined)).toBe(true);
  });

  it('clears matching fields before disconnect normalization and stays clear', () => {
    const panels = [
      { id: 'source', type: 'markdown' as const, content: '' },
      { id: 'other', type: 'markdown' as const, content: '' },
      { id: 'detail', type: 'detail' as const, linkedTo: 'source', sourcePanelId: 'other' },
    ];
    const connections = [
      { id: 'detail-source', sourceId: 'detail', targetId: 'source' },
      { id: 'detail-other', sourceId: 'detail', targetId: 'other' },
    ];
    const disconnectedPanels = clearPanelRelationFields(panels, [connections[0]]);
    const normalized = normalizePanelRelations(
      disconnectedPanels,
      connections.filter((connection) => connection.id !== connections[0].id),
    );

    expect(normalized.panels[2]).toMatchObject({ id: 'detail', sourcePanelId: 'other', linkedTo: undefined });
    expect(normalized.connections).toEqual([connections[1]]);
    const secondPass = normalizePanelRelations(normalized.panels, normalized.connections);
    expect(secondPass).toEqual(normalized);
  });

  it('drops self-associations while retaining valid edges', () => {
    const normalized = normalizePanelRelations(
      [
        { id: 'source', type: 'markdown' as const, content: '' },
        { id: 'target', type: 'markdown' as const, content: '' },
      ],
      [
        { id: 'self', sourceId: 'source', targetId: 'source' },
        { id: 'valid', sourceId: 'source', targetId: 'target' },
      ],
    );

    expect(normalized.connections).toEqual([
      { id: 'valid', sourceId: 'source', targetId: 'target' },
    ]);
  });
});
