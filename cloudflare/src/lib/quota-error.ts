/**
 * If `error` looks like a CAIL/model-proxy quota exhaustion (HTTP 429 or a
 * quota_exceeded envelope), return a compact JSON signal string the frontend can
 * detect; otherwise null. Inspects common shapes from the AI SDK / openai-compatible
 * provider (statusCode / status / responseBody / data.error) defensively.
 */
export function quotaSignalFromError(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const maxVisitedNodes = 20;
  const queue: object[] = [error];
  const visited = new Set<object>([error]);
  const enqueue = (candidate: unknown) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      visited.has(candidate) ||
      visited.size >= maxVisitedNodes
    ) {
      return;
    }
    visited.add(candidate);
    queue.push(candidate);
  };

  while (queue.length > 0) {
    const candidate = queue.shift() as object;
    const current = candidate as any;
    const status = current.statusCode ?? current.status ?? current.data?.status;
    const code = current.data?.error ?? current.code ?? current.responseBody?.error;
    const retryAfter =
      current.responseHeaders?.['retry-after'] ?? current.retryAfter ?? undefined;
    const isQuota =
      status === 429 ||
      code === 'quota_exceeded' ||
      (typeof current.message === 'string' && /quota_exceeded/i.test(current.message));
    if (isQuota) {
      return JSON.stringify({
        type: 'quota_exceeded',
        message: 'You have reached your usage quota. Try again later.',
        ...(retryAfter ? { retryAfter: String(retryAfter) } : {}),
      });
    }

    enqueue(current.lastError);
    enqueue(current.cause);
    if (Array.isArray(current.errors)) {
      for (const nestedError of current.errors) {
        if (visited.size >= maxVisitedNodes) break;
        enqueue(nestedError);
      }
    }
  }

  return null;
}
