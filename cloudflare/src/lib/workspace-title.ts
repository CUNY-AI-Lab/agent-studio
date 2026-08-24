import type { UIMessage } from 'ai';

/** Names used only while a newly-created workspace is waiting for its first turn. */
const PLACEHOLDER_WORKSPACE_NAMES = new Set([
  'new workspace',
  'untitled workspace',
]);

export function isPlaceholderWorkspaceName(name: string): boolean {
  return PLACEHOLDER_WORKSPACE_NAMES.has(name.trim().toLowerCase());
}

function messageIsSubstantive(message: UIMessage): boolean {
  return message.role === 'user' && message.parts.some((part) => (
    part.type !== 'text' || part.text.trim().length > 0
  ));
}

/**
 * The current user message is already persisted before onChatMessage runs.
 * Exactly one substantive user message therefore identifies the first real
 * turn, while blank submits do not consume the title opportunity.
 */
export function isFirstSubstantiveTurn(messages: readonly UIMessage[]): boolean {
  let substantiveTurns = 0;
  for (const message of messages) {
    if (!messageIsSubstantive(message)) continue;
    substantiveTurns += 1;
    if (substantiveTurns > 1) return false;
  }
  return substantiveTurns === 1;
}

export function prepareWorkspaceTitleStep(
  force: boolean,
  stepNumber: number,
): {
  activeTools: ['ui_workspace'];
  toolChoice: { type: 'tool'; toolName: 'ui_workspace' };
} | undefined {
  if (!force || stepNumber !== 0) return undefined;
  return {
    activeTools: ['ui_workspace'],
    toolChoice: { type: 'tool' as const, toolName: 'ui_workspace' as const },
  };
}
