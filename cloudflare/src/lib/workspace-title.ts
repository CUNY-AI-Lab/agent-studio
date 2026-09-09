/** Default names that are eligible for automatic initial naming. */
const PLACEHOLDER_WORKSPACE_NAMES = new Set([
  'new workspace',
  'untitled workspace',
]);

export function isPlaceholderWorkspaceName(name: string): boolean {
  return PLACEHOLDER_WORKSPACE_NAMES.has(name.trim().toLowerCase());
}
