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

export type MigratableAgent = {
  syncWorkspace(workspace: WorkspaceRecord, sessionId: string): Promise<void>;
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
  replaceWorkspaceState(
    state: WorkspaceState,
    workspace: WorkspaceRecord,
    sessionId: string,
  ): Promise<void>;
  persistMessages(messages: UIMessage[]): Promise<void>;
};

type AgentFactory = (sessionId: string, workspaceId: string) => Promise<MigratableAgent>;

export type MigrationOutcome = 'migrated' | 'already-done';

// Kept for the checked-in Durable Object class until that obsolete binding is
// removed from the deployment manifest. No application path calls this claim
// state machine; the first-login importer uses its per-subject completion key.
export type ClaimAction = 'run' | 'already-done' | 'in-progress' | 'claimed-by-other' | 'anonymous-active';
export interface MigrationClaim {
  subjectSessionId: string;
  status: 'in-progress' | 'done' | 'failed';
  startedAt: number;
  completedAt?: number;
}
export function decideClaim(
  existing: MigrationClaim | undefined,
  subjectSessionId: string,
  now: number,
): { action: ClaimAction; record?: MigrationClaim } {
  if (!existing) return { action: 'run', record: { subjectSessionId, status: 'in-progress', startedAt: now } };
  if (existing.subjectSessionId !== subjectSessionId) return { action: 'claimed-by-other' };
  if (existing.status === 'done') return { action: 'already-done' };
  return { action: 'run', record: { ...existing, status: 'in-progress', startedAt: now } };
}

// Requests sharing one warm isolate serialize the copy. The completion marker
// remains authoritative across isolates; this small lock only prevents two
// first-login requests from appending the same messages/downloads locally.
const importLocks = new Map<string, Promise<void>>();

function markerKey(subjectSessionId: string): string {
  return `${IMPORT_MARKER_PREFIX}${subjectSessionId}.json`;
}

async function completed(env: Env, subjectSessionId: string): Promise<boolean> {
  return Boolean(await env.WORKSPACE_FILES.get(markerKey(subjectSessionId)));
}

async function readLegacyDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
): Promise<DownloadRequest[]> {
  const object = await env.WORKSPACE_FILES.get(`${getWorkspacePrefix(sessionId, workspaceId)}downloads.json`);
  if (!object) return [];
  const value = await object.json<unknown>();
  if (!Array.isArray(value)) throw new Error('account import found an invalid download queue');
  return value as DownloadRequest[];
}

async function copyWorkspace(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
  workspace: WorkspaceRecord,
  getAgent: AgentFactory,
): Promise<void> {
  // A target record is the durable workspace commit marker. Existing target
  // records are never overwritten, so retries and pre-existing subject data
  // remain deterministic.
  if (await getWorkspace(env, subjectSessionId, workspace.id)) return;

  const source = await getAgent(anonSessionId, workspace.id);
  const target = await getAgent(subjectSessionId, workspace.id);
  await source.syncWorkspace(workspace, anonSessionId);
  await target.syncWorkspace(workspace, subjectSessionId);

  try {
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
    await target.persistMessages(messages);

    const downloads = [
      ...(await getWorkspaceDownloads(env, anonSessionId, workspace.id)),
      ...(await readLegacyDownloads(env, anonSessionId, workspace.id)),
    ];
    await putWorkspaceDownloads(env, subjectSessionId, workspace.id, downloads);

    // Presence of the R2 workspace record makes the copied workspace visible
    // to normal list/get routes only after all content has succeeded.
    await putWorkspace(env, subjectSessionId, workspace);
  } catch (error) {
    // The source remains available for a retry. The target workspace record is
    // still absent, so partial target objects are not visible to normal list
    // or get routes; deterministic file/download keys make a retry idempotent.
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
    await copyWorkspace(env, anonSessionId, subjectSessionId, workspace, getAgent);
  }

  // Gallery records are global, but private ownership tags are derived from
  // the session namespace. Rewrite only tags matching the verified cookie.
  await reassignGalleryAuthor(env, anonSessionId, subjectSessionId);

  // This is the sole per-user completion marker. Do not write it on failure.
  await env.WORKSPACE_FILES.put(markerKey(subjectSessionId), '1', {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
}

export async function runFirstLoginMigration(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
): Promise<MigrationOutcome> {
  const existing = importLocks.get(subjectSessionId);
  if (existing) {
    await existing;
    return 'already-done';
  }
  const run = (async () => {
    if (await completed(env, subjectSessionId)) return;
    const { getAgentByName } = await import('agents');
    const { createWorkspaceAgentName } = await import('./ids');
    const getWorkspaceByName = getAgentByName as unknown as (
      namespace: Env['WorkspaceAgent'],
      name: string,
    ) => Promise<MigratableAgent>;
    const getAgent: AgentFactory = async (sessionId, workspaceId) => getWorkspaceByName(
      env.WorkspaceAgent,
      createWorkspaceAgentName(sessionId, workspaceId),
    );
    await migrateAnonymousSession(env, anonSessionId, subjectSessionId, getAgent);
  })();
  importLocks.set(subjectSessionId, run);
  try {
    await run;
    return 'migrated';
  } finally {
    importLocks.delete(subjectSessionId);
  }
}
