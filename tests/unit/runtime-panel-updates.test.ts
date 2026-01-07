import assert from 'assert';
import { describe, it } from 'node:test';
import { extractPanelUpdates } from '../../src/lib/runtime';

describe('runtime.extractPanelUpdates', () => {
  it('extracts and strips panel updates from tool result', () => {
    const updates = [{ action: 'add', panel: { id: 'p1', type: 'table', tableId: 't1' } }];
    const payload = `Logs:\nHello\n\n__PANEL_UPDATES_START__${JSON.stringify(updates)}__PANEL_UPDATES_END__`;
    const { cleanResult, panelUpdates } = extractPanelUpdates(payload);
    assert.match(cleanResult, /Logs:\nHello/);
    assert.equal(Array.isArray(panelUpdates), true);
    assert.equal(panelUpdates.length, 1);
    assert.equal(panelUpdates[0].action, 'add');
  });

  it('returns original text when JSON is invalid', () => {
    const payload = `X __PANEL_UPDATES_START__not-json__PANEL_UPDATES_END__`;
    const { cleanResult, panelUpdates } = extractPanelUpdates(payload);
    assert.equal(cleanResult.includes('not-json'), true);
    assert.equal(panelUpdates.length, 0);
  });
});

