import { canonicalError } from './error-envelope';

export interface CanonicalCailError {
  code: string;
  message: string;
  status?: number;
  extras: Record<string, unknown>;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** Extract only explicit nested `error.cail` evidence from SDK wrappers. */
export function extractCanonicalCailError(error: unknown): CanonicalCailError | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  for (let visited = 0; queue.length > 0 && visited < 256; visited += 1) {
    const record = parseRecord(queue.shift());
    if (!record || seen.has(record)) continue;
    seen.add(record);
    const nested = parseRecord(record.error);
    const cail = parseRecord(nested?.cail);
    if (nested && cail && typeof nested.code === 'string' && typeof nested.message === 'string') {
      return {
        code: nested.code,
        message: nested.message,
        status: typeof record.statusCode === 'number' ? record.statusCode : undefined,
        extras: cail,
      };
    }
    for (const child of [record.responseBody, record.cause, record.data, record.lastError, record.error]) {
      if (child !== undefined) queue.push(child);
    }
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return null;
}

export function quotaSignalFromError(error: unknown, extracted?: CanonicalCailError | null): string | null {
  const cail = extracted === undefined ? extractCanonicalCailError(error) : extracted;
  if (!cail || cail.code !== 'quota_exceeded') return null;
  const envelope = canonicalError('quota_exceeded', cail.message, {
    type: 'rate_limit_error',
    retryable: false,
  });
  const retryAfter = cail.extras.retry_after_seconds;
  if (retryAfter === undefined) return JSON.stringify(envelope);
  return JSON.stringify({
    error: {
      ...envelope.error,
      cail: { ...envelope.error.cail, retry_after_seconds: Number(retryAfter) },
    },
  });
}
