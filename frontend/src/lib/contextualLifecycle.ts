import type { ContextualChatTarget } from './messages';
import type { ContextualTurn } from './contextualTurn';

export interface ContextualTurnRecord extends ContextualTurn {
  turnId: string;
  scopeKey: string;
}

export type ContextualLifecycleState =
  | {
    phase: 'idle';
    target: ContextualChatTarget | null;
    turn: null;
  }
  | {
    phase: 'active';
    target: ContextualChatTarget | null;
    turn: ContextualTurnRecord;
  };

export type ContextualLifecycleAction =
  | { type: 'open'; target: ContextualChatTarget }
  | { type: 'submit'; turn: ContextualTurnRecord }
  | { type: 'hide'; panelIds: readonly string[] }
  | { type: 'close' }
  | { type: 'finish'; turnId: string };

export const INITIAL_CONTEXTUAL_LIFECYCLE: ContextualLifecycleState = {
  phase: 'idle',
  target: null,
  turn: null,
};

/**
 * Keep the visible target and the one active turn under one transition owner.
 * A hidden target is intentional: minimizing a tile hides its popover while
 * the turn continues against its immutable scope until a terminal transition.
 */
export function transitionContextualLifecycle(
  state: ContextualLifecycleState,
  action: ContextualLifecycleAction,
): ContextualLifecycleState {
  switch (action.type) {
    case 'open':
      if (state.phase === 'active' && state.turn.scopeKey !== action.target.key) return state;
      return { ...state, target: action.target };
    case 'submit':
      if (state.phase !== 'idle' || !state.target) return state;
      if (action.turn.scopeKey !== state.target.key) return state;
      return {
        phase: 'active',
        target: state.target,
        turn: action.turn,
      };
    case 'hide':
      if (!state.target || !state.target.panelIds.some((panelId) => action.panelIds.includes(panelId))) {
        return state;
      }
      return { ...state, target: null };
    case 'close':
      return INITIAL_CONTEXTUAL_LIFECYCLE;
    case 'finish':
      if (state.phase !== 'active' || state.turn.turnId !== action.turnId) return state;
      // A terminal turn is no longer active, but its target remains open so
      // the user can read the persisted response (including a concise error
      // or cancellation notice). Only an explicit close clears the target.
      return {
        phase: 'idle',
        target: state.target,
        turn: null,
      };
  }
}
