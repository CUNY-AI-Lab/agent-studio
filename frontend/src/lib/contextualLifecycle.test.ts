import { describe, expect, it } from 'vitest';
import {
  INITIAL_CONTEXTUAL_LIFECYCLE,
  transitionContextualLifecycle,
  type ContextualTurnRecord,
} from './contextualLifecycle';
import type { ContextualChatTarget } from './messages';

const tile: ContextualChatTarget = {
  key: 'panel:one',
  panelIds: ['one'],
  title: 'One',
  typeLabel: 'Markdown',
};
const otherTile: ContextualChatTarget = {
  key: 'panel:two',
  panelIds: ['two'],
  title: 'Two',
  typeLabel: 'Markdown',
};
const turn: ContextualTurnRecord = {
  turnId: 'turn-1',
  scopeKey: tile.key,
  previousAssistantId: null,
  previousMessageIds: new Set(),
  userMessageId: null,
};

function activeState() {
  return transitionContextualLifecycle(
    transitionContextualLifecycle(INITIAL_CONTEXTUAL_LIFECYCLE, { type: 'open', target: tile }),
    { type: 'submit', turn },
  );
}

describe('contextual lifecycle', () => {
  it('keeps an active turn alive when its tile is minimized, then finishes it', () => {
    const hidden = transitionContextualLifecycle(activeState(), { type: 'hide', panelIds: ['one'] });
    expect(hidden.phase).toBe('active');
    expect(hidden.target).toBeNull();
    expect(hidden.turn.turnId).toBe('turn-1');

    const finished = transitionContextualLifecycle(hidden, { type: 'finish', turnId: 'turn-1' });
    expect(finished).toEqual(INITIAL_CONTEXTUAL_LIFECYCLE);
  });

  it('finishes a visible turn without closing its target so the thread stays readable', () => {
    const finished = transitionContextualLifecycle(activeState(), { type: 'finish', turnId: 'turn-1' });
    expect(finished).toEqual({
      phase: 'idle',
      target: tile,
      turn: null,
    });
  });

  it('clears the target only on explicit close after a terminal turn', () => {
    const finished = transitionContextualLifecycle(activeState(), { type: 'finish', turnId: 'turn-1' });
    expect(transitionContextualLifecycle(finished, { type: 'close' })).toEqual(INITIAL_CONTEXTUAL_LIFECYCLE);
  });

  it('keeps an active turn when an unrelated tile is minimized', () => {
    const next = transitionContextualLifecycle(activeState(), { type: 'hide', panelIds: ['two'] });
    expect(next).toEqual(activeState());
  });

  it('does not replace an active scoped target with another tile', () => {
    const next = transitionContextualLifecycle(activeState(), { type: 'open', target: otherTile });
    expect(next).toEqual(activeState());
  });

  it('reopens the same target while its hidden turn is still active', () => {
    const hidden = transitionContextualLifecycle(activeState(), { type: 'hide', panelIds: ['one'] });
    const reopened = transitionContextualLifecycle(hidden, { type: 'open', target: tile });
    expect(reopened.phase).toBe('active');
    expect(reopened.target).toEqual(tile);
    expect(reopened.turn.turnId).toBe('turn-1');
  });

  it('rejects stale terminal events without changing a newer turn', () => {
    const next = transitionContextualLifecycle(activeState(), { type: 'finish', turnId: 'old-turn' });
    expect(next).toEqual(activeState());
  });
});
