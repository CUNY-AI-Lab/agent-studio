import type { WorkspaceRecord } from '../types';

export interface WorkspaceDraft {
  name: string;
  description: string;
  model: string | undefined;
}

/**
 * Apply a server workspace update only to fields the user has not edited since
 * the previous server snapshot. Each field has its own compare-and-reconcile
 * boundary, so a dirty title does not hide a clean model or description update.
 */
export function reconcileWorkspaceDraft(
  draft: WorkspaceDraft,
  previousServer: WorkspaceRecord,
  nextServer: WorkspaceRecord,
): WorkspaceDraft {
  return {
    name: draft.name === previousServer.name ? nextServer.name : draft.name,
    description: draft.description === previousServer.description
      ? nextServer.description
      : draft.description,
    model: draft.model === previousServer.model ? nextServer.model : draft.model,
  };
}
