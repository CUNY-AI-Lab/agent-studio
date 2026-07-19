import { APICallError } from 'ai';
import { canonicalError } from './error-envelope';

export interface StandardModelError {
  status: number | null;
  type: string | null;
  code: string | null;
  message: string;
  retryAfterSeconds: number | null;
}

/** Read the standard OpenAI error preserved by the AI SDK. */
export function standardModelError(error: unknown): StandardModelError | null {
  if (!APICallError.isInstance(error)) return null;
  const data = error.data as {
    error?: {
      message?: unknown;
      type?: unknown;
      code?: unknown;
    };
  } | undefined;
  const retryAfter = Number(error.responseHeaders?.['retry-after']);
  return {
    status: error.statusCode ?? null,
    type: typeof data?.error?.type === 'string' ? data.error.type : null,
    code:
      typeof data?.error?.code === 'string' || typeof data?.error?.code === 'number'
        ? String(data.error.code)
        : null,
    message:
      typeof data?.error?.message === 'string'
        ? data.error.message
        : error.message,
    retryAfterSeconds:
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
  };
}

/**
 * Translate LiteLLM's standard budget-exceeded response into Agent Studio's
 * existing streamed UI signal. This is presentation logic, not a gateway wire
 * contract.
 */
export function quotaSignalFromError(error: unknown): string | null {
  const modelError = standardModelError(error);
  if (
    modelError?.status !== 429 ||
    (modelError.type !== 'budget_exceeded' &&
      modelError.code !== 'budget_exceeded')
  ) {
    return null;
  }

  const envelope = canonicalError('quota_exceeded', modelError.message, {
    type: 'rate_limit_error',
    retryable: false,
  });
  return JSON.stringify({
    ...envelope,
    ...(modelError.retryAfterSeconds !== null
      ? {
          error: {
            ...envelope.error,
            cail: {
              ...envelope.error.cail,
              retry_after_seconds: modelError.retryAfterSeconds,
            },
          },
        }
      : {}),
  });
}
