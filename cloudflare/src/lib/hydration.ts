import type { Env } from '../env';
import {
  deleteByPrefix,
  getMimeType,
  getWorkspaceFilesPrefix,
  listWorkspaceFilesRecursive,
  readWorkspaceFile,
  toRuntimePath,
} from './files';

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
): Promise<{ copied: number; skipped: number }> {
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
