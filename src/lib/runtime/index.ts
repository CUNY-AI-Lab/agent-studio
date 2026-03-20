import { SandboxedStorage, WorkspaceConfig } from '../storage';
import { createRemoteWorkspaceRuntime } from './remote';
import { WorkspaceRuntime } from './types';

export * from './remote';
export * from './types';

export function createWorkspaceRunner(
  config: WorkspaceConfig,
  storage: SandboxedStorage
): WorkspaceRuntime {
  return createRemoteWorkspaceRuntime(config, storage);
}
