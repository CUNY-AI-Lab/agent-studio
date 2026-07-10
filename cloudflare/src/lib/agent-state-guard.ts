export function parseAgentName(name: string): { sessionId: string; workspaceId: string } | null {
  const match = /^([0-9a-f]{32})-([0-9a-f]{32})$/.exec(name);
  if (!match) return null;
  return { sessionId: match[1], workspaceId: match[2] };
}

export function assertClientStateIdentity(name: string, nextState: unknown): void {
  const ids = parseAgentName(name);
  if (typeof nextState !== 'object' || nextState === null) return;

  const sid = (nextState as any).sessionId;
  const wid = (nextState as any).workspace?.id;
  if (ids) {
    if (sid != null && sid !== ids.sessionId) {
      throw new Error('client state cannot change sessionId');
    }
    if (wid != null && wid !== ids.workspaceId) {
      throw new Error('client state cannot change workspace.id');
    }
    return;
  }

  if (sid != null) {
    throw new Error('client state cannot set sessionId (unresolvable agent name)');
  }
  if (wid != null) {
    throw new Error('client state cannot set workspace.id (unresolvable agent name)');
  }
}
