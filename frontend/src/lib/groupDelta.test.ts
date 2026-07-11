import { describe, expect, it } from 'vitest';
import { computeGroupsDelta } from './groupDelta';
import type { PanelGroup } from '../types';

const groupX: PanelGroup = { id: 'group-x', name: 'x', panelIds: ['a', 'b'] };
const groupY: PanelGroup = { id: 'group-y', name: 'y', panelIds: ['c', 'd'], color: '#4c78a8' };

describe('computeGroupsDelta', () => {
  it('returns an empty delta when nothing changed', () => {
    expect(computeGroupsDelta([groupX, groupY], [groupX, groupY])).toEqual({
      upserts: [],
      removeIds: [],
    });
  });

  it('upserts only the group this edit changed', () => {
    const renamed = { ...groupX, name: 'x-renamed' };
    // groupY is untouched in this tab's snapshot: it must NOT be sent, so a
    // concurrent edit to it in another tab survives (V3).
    expect(computeGroupsDelta([groupX, groupY], [renamed, groupY])).toEqual({
      upserts: [renamed],
      removeIds: [],
    });
  });

  it('detects membership and color changes', () => {
    const shrunk = { ...groupY, panelIds: ['c', 'd', 'e'] };
    expect(computeGroupsDelta([groupX, groupY], [groupX, shrunk]).upserts).toEqual([shrunk]);
    const recolored = { ...groupX, color: '#2d8f6f' };
    expect(computeGroupsDelta([groupX, groupY], [recolored, groupY]).upserts).toEqual([recolored]);
  });

  it('reports removed groups as explicit removals, not omissions', () => {
    expect(computeGroupsDelta([groupX, groupY], [groupX])).toEqual({
      upserts: [],
      removeIds: ['group-y'],
    });
  });

  it('handles a combined ungroup-and-regroup edit', () => {
    const fresh: PanelGroup = { id: 'group-z', name: '2 tiles', panelIds: ['a', 'c'] };
    expect(computeGroupsDelta([groupX, groupY], [groupY, fresh])).toEqual({
      upserts: [fresh],
      removeIds: ['group-x'],
    });
  });
});
