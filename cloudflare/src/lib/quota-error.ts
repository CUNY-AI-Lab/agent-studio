import { CailError, extractCailError } from '@cuny-ai-lab/cail-client';
import { canonicalError } from './error-envelope';

/**
 * The AI SDK exposes provider failures as APICallError objects whose
 * `responseBody` is already consumed. Keep quota surfacing bounded to the
 * canonical CAIL envelope (`error.cail`) or a typed CailError; an ordinary
 * provider body that happens to use `code: "quota_exceeded"` is not enough.
 */
function hasCanonicalCailEvidence(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;

  while (queue.length > 0 && visited < 256) {
    let layer = queue.shift();
    if (typeof layer === 'string') {
      if (layer.length > 64 * 1024) continue;
      try {
        layer = JSON.parse(layer);
      } catch {
        continue;
      }
    }
    if (layer === null || (typeof layer !== 'object' && typeof layer !== 'function')) {
      continue;
    }
    if (layer instanceof CailError) return true;
    if (seen.has(layer)) continue;
    seen.add(layer);
    visited += 1;

    const record = layer as Record<string, unknown>;
    const nestedError = record.error;
    if (
      nestedError !== null
      && typeof nestedError === 'object'
      && Object.prototype.hasOwnProperty.call(nestedError, 'cail')
    ) {
      return true;
    }

    for (const nested of [
      record.responseBody,
      record.cause,
      nestedError,
      record.data,
      record.lastError,
    ]) {
      if (nested !== undefined) queue.push(nested);
    }
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return false;
}

/**
 * If `error` is (or wraps) a typed CAIL quota failure, return a compact JSON
 * signal string the frontend detects (see frontend/src/lib/quotaError.ts);
 * otherwise null.
 *
 * The bounded shared extractor digs the envelope out of AI SDK wrappers and
 * response-body strings. Canonical `error.cail` evidence keeps a plain
 * OpenAI-compatible provider error from being mistaken for a CAIL quota.
 */
export function quotaSignalFromError(
  error: unknown,
  extracted?: CailError | null,
): string | null {
  const cail = extracted === undefined ? extractCanonicalCailError(error) : extracted;
  if (
    cail === null
    || cail.code !== 'quota_exceeded'
  ) {
    return null;
  }
  const retryAfter = cail.extras['retry_after_seconds'];
  const envelope = canonicalError('quota_exceeded', cail.message, {
    type: 'rate_limit_error',
    retryable: false,
  });
  return JSON.stringify({
    ...envelope,
    ...(retryAfter != null
      ? { error: { ...envelope.error, cail: {
        ...envelope.error.cail,
        retry_after_seconds: Number(retryAfter),
      } } }
      : {}),
  });
}

/**
 * Extract only a canonical CAIL envelope. The shared extractor intentionally
 * accepts any OpenAI-compatible `{error:{message,type,code}}` body; the
 * `error.cail`/typed-error check keeps ordinary provider failures out of CAIL
 * observability and quota handling.
 */
export function extractCanonicalCailError(error: unknown): CailError | null {
  const cail = extractCailError(error);
  return cail !== null && hasCanonicalCailEvidence(error) ? cail : null;
}
