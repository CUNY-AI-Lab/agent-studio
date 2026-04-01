export function createOpaqueId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function createWorkspaceAgentName(sessionId: string, workspaceId: string): string {
  return `${sessionId}-${workspaceId}`;
}
