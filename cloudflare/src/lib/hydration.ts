import { accountImportWindowState, legacyAccountCompatibilityAllowed, type Env } from '../env';
import {
  deleteByPrefix,
  getMimeType,
  getWorkspaceFilesPrefix,
  listWorkspaceFilesRecursive,
  readWorkspaceFile,
  toRuntimePath,
} from './files';
import { LOG_PRODUCT, STUDIO_EVENTS, studioLogger } from './logging';

export interface HydrationRuntime {
  lstat(path: string): Promise<{ type: string } | null>;
  writeFileBytes(path: string, bytes: Uint8Array, contentType: string): Promise<unknown>;
}

/**
 * Copy every legacy R2 workspace file into the runtime workspace, then delete
 * the legacy prefix. Deletion only happens after every listed file is confirmed
 * readable from R2 and present in the runtime workspace.
 */
export async function hydrateLegacyWorkspaceFiles(
  env: Env,
  sessionId: string,
  workspaceId: string,
  runtime: HydrationRuntime,
  now = Date.now(),
): Promise<{ copied: number; skipped: number }> {
  if (!legacyAccountCompatibilityAllowed(env, now)) {
    const state = accountImportWindowState(env, now);
    const legacyFiles = await listWorkspaceFilesRecursive(env, sessionId, workspaceId);
    if (legacyFiles.some((file) => !file.isDirectory)) {
      studioLogger(env).emit(STUDIO_EVENTS.LEGACY_HYDRATION_SKIPPED, {
        product_id: LOG_PRODUCT,
        terminal: { outcome: 'denied', reason: 'denied' },
        error_type:
          state === 'expired'
            ? 'legacy_hydration_window_expired'
            : 'legacy_hydration_window_not_open',
      });
    }
    return { copied: 0, skipped: 0 };
  }

  const legacyFiles = await listWorkspaceFilesRecursive(env, sessionId, workspaceId);
  const leafFiles = legacyFiles.filter((file) => !file.isDirectory);
  const failures: string[] = [];
  let copied = 0;
  let skipped = 0;

  for (const file of leafFiles) {
    const runtimePath = toRuntimePath(file.path);
    if (await runtime.lstat(runtimePath)) {
      skipped += 1;
      continue;
    }

    const object = await readWorkspaceFile(env, sessionId, workspaceId, file.path);
    if (!object) {
      failures.push(file.path);
      continue;
    }

    await runtime.writeFileBytes(
      runtimePath,
      new Uint8Array(await object.arrayBuffer()),
      object.httpMetadata?.contentType || getMimeType(file.path),
    );
    copied += 1;
  }

  if (failures.length > 0) {
    throw new Error(
      `hydrateLegacyWorkspaceFiles: workspace ${workspaceId} has listed files missing from R2: ${failures.join(', ')}`,
    );
  }

  if (leafFiles.length > 0) {
    await deleteByPrefix(env, getWorkspaceFilesPrefix(sessionId, workspaceId));
  }

  return { copied, skipped };
}
