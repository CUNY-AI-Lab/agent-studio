import { z } from 'zod';

type ClientStateIdentity = {
  sessionId?: string | null;
  workspace?: { id?: string | null } | null;
} | null | undefined;

export function parseAgentName(name: string): { sessionId: string; workspaceId: string } | null {
  const match = /^([0-9a-f]{32})-([0-9a-f]{32})$/.exec(name);
  if (!match) return null;
  return { sessionId: match[1], workspaceId: match[2] };
}

const clientStateIdentitySchema = z.object({
  sessionId: z.string().nullable().optional(),
  workspace: z.object({ id: z.string().nullable().optional() }).optional(),
}).passthrough();

export function assertClientStateIdentity(name: string, nextState: ClientStateIdentity): void {
  const ids = parseAgentName(name);
  const parsed = clientStateIdentitySchema.safeParse(nextState);
  if (!parsed.success) return;

  const sid = parsed.data.sessionId;
  const wid = parsed.data.workspace?.id;
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
