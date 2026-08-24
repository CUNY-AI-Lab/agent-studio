import type { WorkspaceRecord } from '../types';

function sameWorkspaceRecord(left: WorkspaceRecord, right: WorkspaceRecord): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.description === right.description
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.galleryId === right.galleryId
    && left.model === right.model;
}

/** Update the home list without replacing the selected workspace snapshot. */
export function replaceWorkspaceInHomeList(
  workspaces: WorkspaceRecord[],
  nextWorkspace: WorkspaceRecord,
): WorkspaceRecord[] {
  const index = workspaces.findIndex((workspace) => workspace.id === nextWorkspace.id);
  if (index < 0 || sameWorkspaceRecord(workspaces[index], nextWorkspace)) return workspaces;
  const next = [...workspaces];
  next[index] = nextWorkspace;
  return next;
}
