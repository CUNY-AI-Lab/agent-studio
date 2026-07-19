import { extractCailError } from '@cuny-ai-lab/cail-client';
import { canonicalError } from './error-envelope';

/**
 * If `error` is (or wraps) the CailError the shared client's chatFetch()
 * throws on a gateway 429 quota_exceeded envelope, return a compact JSON
 * signal string the frontend detects (see frontend/src/lib/quotaError.ts);
 * otherwise null.
 *
 * cail-client throws the parsed envelope on the first quota failure instead
 * of returning the 429 Response, so the AI SDK normally never retries it and
 * never buries it inside a RetryError. Extraction is delegated to the shared
 * `extractCailError`, which digs a typed CAIL envelope out of SDK wrappers
 * when one IS buried — but never sniffs bare 429 shapes or message text, so
 * a plain rate-limit error is still not a CAIL quota signal. The envelope
 * message is user-safe verbatim under the institutional CAIL error contract,
 * so it is forwarded as-is, along with `retry_after_seconds` when present.
 */
export function quotaSignalFromError(error: unknown): string | null {
  const cail = extractCailError(error);
  if (cail === null || cail.code !== 'quota_exceeded') {
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
