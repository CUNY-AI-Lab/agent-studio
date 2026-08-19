/**
 * One-time import of the anonymous cookie namespace into the verified CAIL
 * subject namespace.
 *
 * The import is a copy, not a read-through alias. A completion marker is
 * written only after every workspace, Durable Object state, message, runtime
 * file, download, and gallery ownership record has been copied. The legacy
 * namespace is intentionally left inaccessible after success rather than
 * destructively deleting user data; the authenticated cookie is cleared and
 * all normal reads use only the subject namespace.
 */

import type { UIMessage } from 'ai';
import { z } from 'zod';
import type { WorkspaceRecord, WorkspaceState } from '../domain/workspace';
import type { Env } from '../env';
import {
  getMimeType,
  getWorkspacePrefix,
  listWorkspaceFilesRecursive,
  readWorkspaceFile,
} from './files';
import { getWorkspaceDownloads, putWorkspaceDownloads, type DownloadRequest } from './downloads';
import { reassignGalleryAuthor } from './gallery';
import { getWorkspace, listWorkspaces, putWorkspace } from './workspaces';

const IMPORT_MARKER_PREFIX = 'agent-studio/account-import/v1/';

const legacyDownloadSchema = z.object({
  filename: z.string(),
  data: z.json(),
  format: z.enum(['csv', 'json', 'txt']),
}).strict();

export type MigratableAgent = {
  syncWorkspace(workspace: WorkspaceRecord, sessionId: string): Promise<void>;
  freezeForMigration(): Promise<void>;
  unfreezeAfterMigration(): Promise<void>;
  getSnapshot(): Promise<WorkspaceState>;
  getMessages(): Promise<UIMessage[]>;
  getWorkspaceFiles(): Promise<Array<{ path: string; isDirectory: boolean }>>;
  readWorkspaceFileContent(filePath: string): Promise<{
    filePath: string;
    contentType: string;
    data: ArrayBuffer;
  } | null>;
  writeWorkspaceFileContent(
    filePath: string,
    data: string | ArrayBuffer | Uint8Array,
    contentType?: string,
  ): Promise<{ ok: true; filePath: string }>;
  clearWorkspaceFiles(): Promise<void>;
  replaceWorkspaceState(
    state: WorkspaceState,
    workspace: WorkspaceRecord,
    sessionId: string,
  ): Promise<void>;
  persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds?: string[],
    options?: { _deleteStaleRows?: boolean },
  ): Promise<void>;
};

type AgentFactory = (sessionId: string, workspaceId: string) => Promise<MigratableAgent>;

export type MigrationOutcome = 'migrated' | 'already-done' | 'claimed-by-other';

function migrationRegistry(env: Env, anonSessionId: string) {
  return env.MIGRATION_REGISTRY.get(env.MIGRATION_REGISTRY.idFromName(anonSessionId));
}

export function beginAnonymousSessionRequest(
  env: Env,
  anonSessionId: string,
  requestId: string,
): Promise<boolean> {
  return migrationRegistry(env, anonSessionId).beginAnonymousRequest(requestId);
}

export function endAnonymousSessionRequest(
  env: Env,
  anonSessionId: string,
  requestId: string,
): Promise<void> {
  return migrationRegistry(env, anonSessionId).endAnonymousRequest(requestId);
}

function markerKey(subjectSessionId: string): string {
  return `${IMPORT_MARKER_PREFIX}${subjectSessionId}.json`;
}

async function completed(env: Env, subjectSessionId: string): Promise<boolean> {
  return Boolean(await env.WORKSPACE_FILES.head(markerKey(subjectSessionId)));
}

async function readLegacyDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
): Promise<DownloadRequest[]> {
  const object = await env.WORKSPACE_FILES.get(`${getWorkspacePrefix(sessionId, workspaceId)}downloads.json`);
  if (!object) return [];
  const value = z.array(legacyDownloadSchema).safeParse(await object.json());
  if (!value.success) throw new Error('account import found an invalid download queue');
  return value.data;
}

async function copyWorkspace(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
  workspace: WorkspaceRecord,
  getAgent: AgentFactory,
): Promise<MigratableAgent> {
  const source = await getAgent(anonSessionId, workspace.id);
  // A target record is the durable workspace commit marker. Existing target
  // records are never overwritten. On retry we freeze an older source again
  // without trying to sync the already-retired Durable Object first.
  if (await getWorkspace(env, subjectSessionId, workspace.id)) {
    await source.freezeForMigration();
    return source;
  }

  await source.syncWorkspace(workspace, anonSessionId);
  await source.freezeForMigration();

  try {
    const target = await getAgent(subjectSessionId, workspace.id);
    await target.syncWorkspace(workspace, subjectSessionId);
    // A previous failed attempt can have written a subset of runtime files.
    // No target workspace record exists yet, so this namespace is still an
    // import staging area and must exactly mirror the current frozen source.
    await target.clearWorkspaceFiles();
    const [state, messages, runtimeFiles, legacyFiles] = await Promise.all([
      source.getSnapshot(),
      source.getMessages(),
      source.getWorkspaceFiles(),
      listWorkspaceFilesRecursive(env, anonSessionId, workspace.id),
    ]);
    const filePaths = new Set<string>([
      ...runtimeFiles.filter((file) => !file.isDirectory).map((file) => file.path),
      ...legacyFiles.filter((file) => !file.isDirectory).map((file) => file.path),
    ]);
    for (const filePath of filePaths) {
      const content = await source.readWorkspaceFileContent(filePath)
        ?? await (async () => {
          const object = await readWorkspaceFile(env, anonSessionId, workspace.id, filePath);
          if (!object) return null;
          return {
            contentType: object.httpMetadata?.contentType || getMimeType(filePath),
            data: await object.arrayBuffer(),
          };
        })();
      if (!content) throw new Error('account import could not read a workspace file');
      await target.writeWorkspaceFileContent(filePath, content.data, content.contentType);
    }

    await target.replaceWorkspaceState(state, workspace, subjectSessionId);
    // The target is an invisible import staging namespace until the R2 record
    // commits. AIChatAgent only deletes stale rows when every incoming id is
    // already known, so clear first and then write the exact frozen source.
    await target.persistMessages([], undefined, { _deleteStaleRows: true });
    await target.persistMessages(messages);

    const downloads = [
      ...(await getWorkspaceDownloads(env, anonSessionId, workspace.id, { onCorrupt: 'throw' })),
      ...(await readLegacyDownloads(env, anonSessionId, workspace.id)),
    ];
    await putWorkspaceDownloads(env, subjectSessionId, workspace.id, downloads);

    // Presence of the R2 workspace record makes the copied workspace visible
    // to normal list/get routes only after all content has succeeded.
    await putWorkspace(env, subjectSessionId, workspace);
    return source;
  } catch (error) {
    // The source remains available for a retry. The target workspace record is
    // still absent, so partial target objects are not visible to normal list
    // or get routes. A retry clears the staging runtime files before copying
    // the then-current frozen source again.
    await source.unfreezeAfterMigration().catch(() => undefined);
    throw error;
  }
}

export async function migrateAnonymousSession(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
  getAgent: AgentFactory,
): Promise<void> {
  if (await completed(env, subjectSessionId)) return;

  const workspaces = await listWorkspaces(env, anonSessionId);
  for (const workspace of workspaces) {
    await copyWorkspace(
      env,
      anonSessionId,
      subjectSessionId,
      workspace,
      getAgent,
    );
  }

  // Gallery records are global, but private ownership tags are derived from
  // the session namespace. Rewrite only tags matching the verified cookie.
  await reassignGalleryAuthor(env, anonSessionId, subjectSessionId);

  // This is the sole per-user completion marker. Do not write it on failure.
  await env.WORKSPACE_FILES.put(markerKey(subjectSessionId), '1', {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  // Each source stays frozen once its target workspace record commits, even if
  // a later workspace or the account marker fails. A retry skips that completed
  // target, and an old anonymous request cannot make the frozen source diverge.
}

export async function runFirstLoginMigration(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
): Promise<MigrationOutcome> {
  const registry = migrationRegistry(env, anonSessionId);
  const claim = await registry.claim(subjectSessionId);
  if (claim === 'claimed-by-other') return 'claimed-by-other';
  if (claim === 'already-done') return 'already-done';
  if (claim === 'anonymous-active' || claim === 'in-progress') {
    throw new Error('account import is waiting for an active legacy request');
  }

  try {
    if (await completed(env, subjectSessionId)) {
      await registry.markDone(subjectSessionId);
      return 'already-done';
    }
    const { getAgentByName } = await import('agents');
    const { createWorkspaceAgentName } = await import('./ids');
    const getAgent: AgentFactory = async (sessionId, workspaceId) => getAgentByName(
      env.WorkspaceAgent,
      createWorkspaceAgentName(sessionId, workspaceId),
    );
    await migrateAnonymousSession(env, anonSessionId, subjectSessionId, getAgent);
    await registry.markDone(subjectSessionId);
    return 'migrated';
  } catch (error) {
    await registry.markFailed(subjectSessionId).catch(() => undefined);
    throw error;
  }
}
