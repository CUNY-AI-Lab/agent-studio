export interface CanonicalErrorOptions {
  type?: string;
  param?: string | null;
  requestId?: string;
  retryable?: boolean;
}

interface CanonicalCailFields {
  request_id?: string;
  retryable?: boolean;
}

/** CAIL-compatible error envelope used at every JSON HTTP boundary. */
export function canonicalError(
  code: string,
  message: string,
  options: CanonicalErrorOptions = {},
) {
  const cail: CanonicalCailFields = {};
  if (options.requestId) cail.request_id = options.requestId;
  if (options.retryable !== undefined) cail.retryable = options.retryable;
  return {
    error: {
      message,
      type: options.type ?? 'invalid_request_error',
      param: options.param ?? null,
      code,
      cail,
    },
  };
}
