/**
 * First-login migration of anonymous-session data into the CAIL
 * subject-keyed namespace.
 *
 * Before SSO enforcement, users work under a signed opaque cookie session.
 * Once they authenticate, their session id becomes a digest of the CAIL
 * subject (see session.ts) and anything they made anonymously would be
 * stranded. When an authenticated request also carries a valid legacy
 * anonymous cookie, we copy that anonymous namespace's data into the subject
 * namespace, exactly once.
 *
 * Mechanism: COPY, not an alias map. The subject namespace may already hold
 * its own data (fresh post-SSO usage, or another device), so reads under an
 * alias would have to merge two namespaces forever; and Durable Object names
 * embed the session id, so an alias would add a resolution read to every
 * request. Copying reuses the machinery the workspace import/export flow
 * already exercises, and leaves one canonical namespace. DO content moves via
 * the WorkspaceAgent RPC surface because DO names cannot be renamed.
 *
 * Claim-once: a MigrationRegistry Durable Object named by the ANONYMOUS
 * session id serializes all claims for that namespace. The first verified
 * subject to claim wins and is recorded; the same anonymous namespace can
 * never migrate into a second subject. Re-runs after success are no-ops;
 * concurrent requests see 'in-progress' and skip; a crashed run retries
 * (same subject only) after a staleness window or an explicit failure mark.
 *
 * Merge safety: a workspace id already present in the subject namespace is
 * never overwritten (skipped entirely, DO state included). Workspace ids are
 * 32-hex random ids, so a cross-namespace collision can only be a workspace
 * this migration already copied.
 */

import type { UIMessage } from 'ai';
import type { WorkspaceRecord, WorkspaceState } from '../domain/workspace';
import type { Env } from '../env';
import { deleteByPrefix, getMimeType } from './files';
import { reassignGalleryAuthor } from './gallery';
import { getWorkspaceDownloads, putWorkspaceDownloads } from './downloads';
import { getWorkspace, listWorkspaces, putWorkspace } from './workspaces';

// ---------------------------------------------------------------------------
// Claim state machine (pure; executed inside the MigrationRegistry DO)
// ---------------------------------------------------------------------------

/** Retry a crashed in-progress run after this long (same subject only). */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

export interface MigrationClaim {
  /** The subject-derived session id that claimed this anonymous namespace. */
  subjectSessionId: string;
  status: 'in-progress' | 'done' | 'failed';
  startedAt: number;
  completedAt?: number;
}

export type ClaimAction = 'run' | 'already-done' | 'in-progress' | 'claimed-by-other';

export interface ClaimDecision {
  action: ClaimAction;
  /** New claim record to persist, when the decision changes state. */
  record?: MigrationClaim;
}

/**
 * Decide what a claim attempt by `subjectSessionId` should do given the
 * existing claim record. First verified claim wins and is sticky: once an
 * anonymous namespace is claimed by one subject, no other subject can ever
 * run it — even after a failure — so a namespace can never be split across
 * two subjects.
 */
export function decideClaim(
  existing: MigrationClaim | undefined,
  subjectSessionId: string,
  now: number,
): ClaimDecision {
  if (!existing) {
    return {
      action: 'run',
      record: { subjectSessionId, status: 'in-progress', startedAt: now },
    };
  }
  if (existing.subjectSessionId !== subjectSessionId) {
    return { action: 'claimed-by-other' };
  }
  if (existing.status === 'done') {
    return { action: 'already-done' };
  }
  if (existing.status === 'failed' || now - existing.startedAt >= CLAIM_STALE_MS) {
    return {
      action: 'run',
      record: { subjectSessionId, status: 'in-progress', startedAt: now },
    };
  }
  return { action: 'in-progress' };
}

// ---------------------------------------------------------------------------
// Data copy
// ---------------------------------------------------------------------------

/**
 * The slice of the WorkspaceAgent RPC surface the migration uses — the same
 * methods the workspace import/export flow already relies on.
 */
export interface MigratableAgent {
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
    contentType?: string
  ): Promise<{ ok: true; filePath: string }>;
  replaceWorkspaceState(
    state: WorkspaceState,
    workspace: WorkspaceRecord,
    sessionId: string
  ): Promise<void>;
  persistMessages(messages: UIMessage[]): Promise<void>;
  clearWorkspaceFiles(): Promise<void>;
}

export type AgentFactory = (
  sessionId: string,
  workspaceId: string
) => Promise<MigratableAgent>;

export interface MigrationResult {
  migratedWorkspaceIds: string[];
  skippedWorkspaceIds: string[];
  galleryItemsReassigned: number;
}

function sessionPrefix(sessionId: string): string {
  return `agent-studio/sessions/${sessionId}/`;
}

/**
 * Copy every workspace (records, DO state, chat history, runtime files,
 * queued downloads) plus gallery authorship from the anonymous namespace into
 * the subject namespace, then delete the anonymous namespace. Idempotent:
 * workspaces already present in the target are skipped untouched, so partial
 * runs can safely re-run. The subject workspace record is written LAST so its
 * presence marks that workspace's copy as complete.
 */
export async function migrateAnonymousSession(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
  getAgent: AgentFactory,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    migratedWorkspaceIds: [],
    skippedWorkspaceIds: [],
    galleryItemsReassigned: 0,
  };

  const anonWorkspaces = await listWorkspaces(env, anonSessionId);

  for (const workspace of anonWorkspaces) {
    // Never overwrite subject-owned data: a workspace id already in the
    // target namespace stays exactly as the subject has it.
    const existing = await getWorkspace(env, subjectSessionId, workspace.id);
    if (existing) {
      result.skippedWorkspaceIds.push(workspace.id);
      continue;
    }

    const oldAgent = await getAgent(anonSessionId, workspace.id);
    const newAgent = await getAgent(subjectSessionId, workspace.id);

    // Normalize the source: syncWorkspace hydrates any legacy R2 files into
    // the old DO's runtime, so the runtime file listing below is complete.
    await oldAgent.syncWorkspace(workspace, anonSessionId);
    await newAgent.syncWorkspace(workspace, subjectSessionId);

    const [state, messages, files] = await Promise.all([
      oldAgent.getSnapshot(),
      oldAgent.getMessages(),
      oldAgent.getWorkspaceFiles(),
    ]);

    for (const file of files) {
      if (file.isDirectory) continue;
      const content = await oldAgent.readWorkspaceFileContent(file.path);
      if (!content) {
        throw new Error(
          `migration: listed file ${file.path} could not be read from workspace ${workspace.id}`
        );
      }
      await newAgent.writeWorkspaceFileContent(
        file.path,
        content.data,
        content.contentType || getMimeType(file.path)
      );
    }

    await newAgent.replaceWorkspaceState(state, workspace, subjectSessionId);
    await newAgent.persistMessages(messages);

    // Queued downloads are transient; carry them over only when the target
    // has none, so nothing subject-owned is clobbered.
    const anonDownloads = await getWorkspaceDownloads(env, anonSessionId, workspace.id);
    if (anonDownloads.length > 0) {
      const targetDownloads = await getWorkspaceDownloads(env, subjectSessionId, workspace.id);
      if (targetDownloads.length === 0) {
        await putWorkspaceDownloads(env, subjectSessionId, workspace.id, anonDownloads);
      }
    }

    // Written last: presence of the record marks this workspace migrated.
    await putWorkspace(env, subjectSessionId, workspace);
    result.migratedWorkspaceIds.push(workspace.id);
  }

  // Gallery items are global; ownership (authorId) moves to the subject so
  // unpublish rights survive the migration.
  result.galleryItemsReassigned = await reassignGalleryAuthor(
    env,
    anonSessionId,
    subjectSessionId
  );

  // Cleanup only after everything copied: clear each migrated workspace's old
  // DO runtime (frees its R2 runtime prefix), then drop the anonymous session
  // prefix so the namespace reads empty.
  for (const workspaceId of result.migratedWorkspaceIds) {
    const oldAgent = await getAgent(anonSessionId, workspaceId);
    await oldAgent.clearWorkspaceFiles();
  }
  await deleteByPrefix(env, sessionPrefix(anonSessionId));

  return result;
}

// ---------------------------------------------------------------------------
// Orchestration (claim + copy + completion marker)
// ---------------------------------------------------------------------------

/** The slice of the MigrationRegistry DO stub the orchestration uses. */
export interface MigrationRegistryClient {
  claim(subjectSessionId: string): Promise<ClaimAction>;
  markDone(subjectSessionId: string): Promise<void>;
  markFailed(subjectSessionId: string): Promise<void>;
}

export type MigrationOutcome = 'migrated' | ClaimAction;

/**
 * Claim the anonymous namespace for this subject and run the copy if the
 * claim wins. Returns what happened; throws only never — a failed copy marks
 * the claim failed (so a later request retries) and reports 'run' failure as
 * a thrown error to the caller-provided catch. The caller decides whether the
 * legacy cookie can be dropped (yes for 'migrated'/'already-done'/
 * 'claimed-by-other'; keep it for 'in-progress' and on failure so a later
 * request can retry).
 */
export async function maybeMigrateAnonymousSession(args: {
  env: Env;
  anonSessionId: string;
  subjectSessionId: string;
  registry: MigrationRegistryClient;
  getAgent: AgentFactory;
}): Promise<MigrationOutcome> {
  const { env, anonSessionId, subjectSessionId, registry, getAgent } = args;

  const action = await registry.claim(subjectSessionId);
  if (action !== 'run') {
    return action;
  }

  try {
    await migrateAnonymousSession(env, anonSessionId, subjectSessionId, getAgent);
    await registry.markDone(subjectSessionId);
    return 'migrated';
  } catch (error) {
    await registry.markFailed(subjectSessionId).catch(() => undefined);
    throw error;
  }
}

/**
 * Production wiring: registry stub from the MIGRATION_REGISTRY binding and a
 * WorkspaceAgent factory. The 'agents' import is dynamic so this module stays
 * loadable outside the workerd runtime (unit tests inject their own factory).
 */
export async function runFirstLoginMigration(
  env: Env,
  anonSessionId: string,
  subjectSessionId: string,
): Promise<MigrationOutcome> {
  const registry = env.MIGRATION_REGISTRY.get(
    env.MIGRATION_REGISTRY.idFromName(anonSessionId)
  ) as unknown as MigrationRegistryClient;

  const getAgent: AgentFactory = async (sessionId, workspaceId) => {
    const { getAgentByName } = await import('agents');
    const { createWorkspaceAgentName } = await import('./ids');
    const agent = await getAgentByName(
      env.WorkspaceAgent,
      createWorkspaceAgentName(sessionId, workspaceId)
    );
    return agent as unknown as MigratableAgent;
  };

  return maybeMigrateAnonymousSession({
    env,
    anonSessionId,
    subjectSessionId,
    registry,
    getAgent,
  });
}
