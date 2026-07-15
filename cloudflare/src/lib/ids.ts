export function createOpaqueId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function createWorkspaceAgentName(sessionId: string, workspaceId: string): string {
  return `${sessionId}-${workspaceId}`;
}

// ---------------------------------------------------------------------------
// Id shape validation (AS-3-6)
//
// Workspace and session ids come from createOpaqueId(): a v4 UUID with the
// hyphens stripped, i.e. exactly 32 lowercase hex chars. New gallery ids are a
// 24-character lowercase hex digest derived from a publish idempotency key.
// The legacy 10-character UUID-prefix shape remains readable so existing
// published items do not break.
//
// These ids are interpolated straight into R2 keys. R2 does not normalize "..",
// so there is no path-traversal escape, but a malformed :id still produces a
// malformed key (and a wasted R2 round-trip). Validate at the route boundary
// and return 400 for anything off-shape.
// ---------------------------------------------------------------------------

const OPAQUE_ID_PATTERN = /^[0-9a-f]{32}$/;
const GALLERY_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]|[0-9a-f]{24})$/;

/** True if `id` matches the createOpaqueId() shape (32 lowercase hex chars). */
export function isValidWorkspaceId(id: string): boolean {
  return OPAQUE_ID_PATTERN.test(id);
}

/** True if `id` matches either the current or legacy gallery id shape. */
export function isValidGalleryId(id: string): boolean {
  return GALLERY_ID_PATTERN.test(id);
}
