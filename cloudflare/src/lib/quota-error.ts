/**
 * If `error` looks like a CAIL/model-proxy quota exhaustion (HTTP 429 or a
 * quota_exceeded envelope), return a compact JSON signal string the frontend can
 * detect; otherwise null. Inspects common shapes from the AI SDK / openai-compatible
 * provider (statusCode / status / responseBody / data.error) defensively.
 */
export function quotaSignalFromError(error: unknown): string | null {
  const candidate = error as any;
  const status = candidate?.statusCode ?? candidate?.status ?? candidate?.data?.status;
  const code = candidate?.data?.error ?? candidate?.code ?? candidate?.responseBody?.error;
  const retryAfter =
    candidate?.responseHeaders?.['retry-after'] ?? candidate?.retryAfter ?? undefined;
  const isQuota =
    status === 429 ||
    code === 'quota_exceeded' ||
    (typeof candidate?.message === 'string' && /quota_exceeded/i.test(candidate.message));
  if (!isQuota) return null;
  return JSON.stringify({
    type: 'quota_exceeded',
    message: 'You have reached your usage quota. Try again later.',
    ...(retryAfter ? { retryAfter: String(retryAfter) } : {}),
  });
}
