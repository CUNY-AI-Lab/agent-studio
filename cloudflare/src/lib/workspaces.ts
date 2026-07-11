import type { WorkspaceRecord } from '../domain/workspace';
import type { Env } from '../env';
import { getWorkspacePrefix } from './files';

function workspaceMetadataKey(sessionId: string, workspaceId: string): string {
  return `${getWorkspacePrefix(sessionId, workspaceId)}workspace.json`;
}

export async function listWorkspaces(env: Env, sessionId: string): Promise<WorkspaceRecord[]> {
  const prefix = `agent-studio/sessions/${sessionId}/workspaces/`;
  const prefixes: string[] = [];
  let cursor: string | undefined;

  do {
    const listing = await env.WORKSPACE_FILES.list({ prefix, delimiter: '/', cursor });
    prefixes.push(...listing.delimitedPrefixes);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const items = await Promise.all(
    prefixes.map(async (workspacePrefix) => {
      const workspaceId = workspacePrefix.slice(prefix.length).replace(/\/$/, '');
      if (!workspaceId) return null;
      const value = await env.WORKSPACE_FILES.get(workspaceMetadataKey(sessionId, workspaceId));
      if (!value) return null;
      return value.json<WorkspaceRecord>();
    })
  );

  return items
    .filter((item): item is WorkspaceRecord => Boolean(item))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getWorkspace(env: Env, sessionId: string, workspaceId: string): Promise<WorkspaceRecord | null> {
  const value = await env.WORKSPACE_FILES.get(workspaceMetadataKey(sessionId, workspaceId));
  return value ? value.json<WorkspaceRecord>() : null;
}

export async function getWorkspaceWithEtag(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<{ workspace: WorkspaceRecord; etag: string } | null> {
  const value = await env.WORKSPACE_FILES.get(workspaceMetadataKey(sessionId, workspaceId));
  if (!value) return null;
  return {
    workspace: await value.json<WorkspaceRecord>(),
    etag: value.etag,
  };
}

export async function putWorkspace(env: Env, sessionId: string, workspace: WorkspaceRecord): Promise<void> {
  await env.WORKSPACE_FILES.put(
    workspaceMetadataKey(sessionId, workspace.id),
    JSON.stringify(workspace, null, 2),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
  );
}

export async function putWorkspaceIfMatch(
  env: Env,
  sessionId: string,
  workspace: WorkspaceRecord,
  etag: string
): Promise<boolean> {
  const result = await env.WORKSPACE_FILES.put(
    workspaceMetadataKey(sessionId, workspace.id),
    JSON.stringify(workspace, null, 2),
    {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      onlyIf: { etagMatches: etag },
    }
  );
  return result !== null;
}

export type WorkspaceUpdateResult =
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: false; reason: 'not-found' | 'conflict' };

/**
 * Read-modify-write a workspace record through the etag CAS (A12): every
 * writer that mutates an EXISTING record must go through here (or the
 * equivalent explicit putWorkspaceIfMatch loop) so a write built from a
 * record captured earlier can't silently revert a concurrent update.
 *
 * `mutate` receives the freshly read record and returns the candidate to
 * store, or `null` to signal "nothing to change" (treated as success with
 * the current record). Retries up to `attempts` times on etag mismatch.
 */
export async function updateWorkspaceWithRetry(
  env: Env,
  sessionId: string,
  workspaceId: string,
  mutate: (current: WorkspaceRecord) => WorkspaceRecord | null,
  attempts = 3
): Promise<WorkspaceUpdateResult> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await getWorkspaceWithEtag(env, sessionId, workspaceId);
    if (!current) return { ok: false, reason: 'not-found' };
    const candidate = mutate(current.workspace);
    if (candidate === null) return { ok: true, workspace: current.workspace };
    if (await putWorkspaceIfMatch(env, sessionId, candidate, current.etag)) {
      return { ok: true, workspace: candidate };
    }
  }
  return { ok: false, reason: 'conflict' };
}

export async function deleteWorkspace(env: Env, sessionId: string, workspaceId: string): Promise<void> {
  await env.WORKSPACE_FILES.delete(workspaceMetadataKey(sessionId, workspaceId));
}

export function createDefaultWorkspace(args: {
  id: string;
  name: string;
  description?: string;
}): WorkspaceRecord {
  const now = new Date().toISOString();
  return {
    id: args.id,
    name: args.name,
    description: args.description || '',
    createdAt: now,
    updatedAt: now,
  };
}
