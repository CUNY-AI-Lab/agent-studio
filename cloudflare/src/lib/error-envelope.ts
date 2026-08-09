export interface CanonicalErrorOptions {
  type?: string;
  param?: string | null;
  requestId?: string;
  loginUrl?: string;
  retryable?: boolean;
}

/** CAIL-compatible error envelope used at every JSON HTTP boundary. */
export function canonicalError(
  code: string,
  message: string,
  options: CanonicalErrorOptions = {},
) {
  return {
    error: {
      message,
      type: options.type ?? 'invalid_request_error',
      param: options.param ?? null,
      code,
      cail: {
        ...(options.requestId ? { request_id: options.requestId } : {}),
        ...(options.loginUrl ? { login_url: options.loginUrl } : {}),
        ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
      },
    },
  };
}
