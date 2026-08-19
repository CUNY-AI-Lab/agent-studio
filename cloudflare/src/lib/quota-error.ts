import { z } from 'zod';
import { canonicalError } from './error-envelope';

const recordSchema = z.object({}).passthrough();
const candidateSchema = z.union([
  z.string(),
  recordSchema,
  z.instanceof(Error),
  z.null(),
  z.undefined(),
]);
const stringSchema = z.string();
const statusSchema = z.number().int().min(100).max(599);
const candidateArraySchema = z.array(candidateSchema);
const canonicalCailFieldsSchema = z.object({
  retry_after_seconds: z.number().finite().optional(),
  login_url: z.string().optional(),
  request_id: z.string().optional(),
  retryable: z.boolean().optional(),
}).passthrough();
const canonicalEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  cail: canonicalCailFieldsSchema,
}).passthrough();

type ParsedRecord = z.infer<typeof recordSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type InputValue = Candidate | Error;

export interface CanonicalCailError {
  code: string;
  message: string;
  status?: number;
  extras: ParsedRecord;
}

function parseRecord(value: InputValue): ParsedRecord | null {
  if (value instanceof Error) {
    const parsedError = recordSchema.safeParse(value);
    return parsedError.success ? parsedError.data : null;
  }
  const stringValue = stringSchema.safeParse(value).data;
  if (stringValue !== undefined) {
    if (stringValue.length > 64 * 1024) return null;
    try {
      const parsed = candidateSchema.safeParse(JSON.parse(stringValue));
      if (!parsed.success) return null;
      const record = recordSchema.safeParse(parsed.data);
      return record.success ? record.data : null;
    } catch {
      return null;
    }
  }
  const record = recordSchema.safeParse(value);
  return record.success ? record.data : null;
}

function readHttpStatus(record: ParsedRecord): number | undefined {
  try {
    return statusSchema.safeParse(record.statusCode).data;
  } catch {
    return undefined;
  }
}

/** Extract only explicit nested `error.cail` evidence from SDK wrappers. */
export function extractCanonicalCailError(error: InputValue): CanonicalCailError | null {
  const queue: Array<{ value: InputValue; status?: number }> = [{ value: error }];
  const seen = new Set<object>();
  for (let visited = 0; queue.length > 0 && visited < 256; visited += 1) {
    const current = queue.shift();
    if (!current) continue;
    const record = parseRecord(current.value);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    const status = readHttpStatus(record) ?? current.status;
    const nestedCandidate = candidateSchema.safeParse(record.error);
    const nested = nestedCandidate.success ? parseRecord(nestedCandidate.data) : null;
    const envelope = nested ? canonicalEnvelopeSchema.safeParse(nested) : null;
    if (envelope?.success) {
      return {
        code: envelope.data.code,
        message: envelope.data.message,
        status,
        extras: envelope.data.cail,
      };
    }
    if (current.value instanceof Error) {
      try {
        const cause = candidateSchema.safeParse(current.value.cause);
        if (cause.success && cause.data !== undefined) queue.push({ value: cause.data, status });
      } catch {
        // Error.cause can be an accessor supplied by an untrusted provider.
      }
    }
    for (const child of [record.responseBody, record.cause, record.data, record.lastError, record.error]) {
      const parsedChild = candidateSchema.safeParse(child);
      if (parsedChild.success) queue.push({ value: parsedChild.data, status });
    }
    const errors = candidateArraySchema.safeParse(record.errors);
    if (errors.success) {
      for (const value of errors.data) queue.push({ value, status });
    }
  }
  return null;
}

export function quotaSignalFromError(
  error: InputValue,
  extracted?: CanonicalCailError | null,
): string | null {
  const cail = extracted === undefined ? extractCanonicalCailError(error) : extracted;
  if (!cail || cail.code !== 'quota_exceeded') return null;
  const envelope = canonicalError('quota_exceeded', cail.message, {
    type: 'rate_limit_error',
    retryable: false,
  });
  const retryAfter = z.number().finite().safeParse(cail.extras.retry_after_seconds).data;
  if (retryAfter === undefined) return JSON.stringify(envelope);
  return JSON.stringify({
    error: {
      ...envelope.error,
      cail: { ...envelope.error.cail, retry_after_seconds: retryAfter },
    },
  });
}
