import { CailError } from '@cuny-ai-lab/cail-client';

/**
 * If `error` is the CailError the shared client's chatFetch() throws on a
 * gateway 429 quota_exceeded envelope, return a compact JSON signal string the
 * frontend detects (see frontend/src/lib/quotaError.ts); otherwise null.
 *
 * cail-client (since 2d51745) throws the parsed envelope on the FIRST quota
 * failure instead of returning the 429 Response, so the AI SDK never retries
 * it and never buries it inside a RetryError — the old defensive
 * RetryError/statusCode unwrapping went away with that. The envelope message
 * is user-safe verbatim (cail-gateway docs/INTEGRATION.md §2), so it is
 * forwarded as-is, along with `retry_after_seconds` when present.
 */
export function quotaSignalFromError(error: unknown): string | null {
  if (!(error instanceof CailError) || error.code !== 'quota_exceeded') {
    return null;
  }
  const retryAfter = error.extras['retry_after_seconds'];
  return JSON.stringify({
    type: 'quota_exceeded',
    message: error.message,
    ...(retryAfter != null ? { retryAfter: String(retryAfter) } : {}),
  });
}
