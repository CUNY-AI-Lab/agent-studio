/** Names that do not establish user ownership of the workspace title. */
const PLACEHOLDER_WORKSPACE_NAMES = new Set([
  'new workspace',
  'untitled workspace',
]);

export function isPlaceholderWorkspaceName(name: string): boolean {
  return PLACEHOLDER_WORKSPACE_NAMES.has(name.trim().toLowerCase());
}
