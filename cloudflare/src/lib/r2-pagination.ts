/** Resolve an R2 continuation cursor without silently accepting truncation. */
export function nextR2Cursor(
  listing: { truncated: boolean; cursor?: string },
  operation: string,
): string | undefined {
  if (!listing.truncated) return undefined;
  if (!listing.cursor) {
    throw new Error(`${operation}: R2 listing was truncated without a continuation cursor`);
  }
  return listing.cursor;
}
