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

function defaultType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function defaultCode(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'upstream_error';
  if (status === 503) return 'service_unavailable';
  if (status >= 500) return 'internal_error';
  return 'request_failed';
}

/** Convert legacy local JSON failures to the canonical fleet shape. */
export async function canonicalizeErrorResponse(
  response: Response,
  requestId?: string,
): Promise<Response> {
  if (response.status < 400) return response;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return response;

  const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return response;
  const nested = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown>
    : null;
  const flatError = typeof payload.error === 'string' ? payload.error : undefined;
  const candidateCode = (typeof nested?.code === 'string' ? nested.code : undefined)
    ?? (typeof payload.errorCode === 'string' ? payload.errorCode : undefined)
    ?? flatError;
  const code = candidateCode && /^[a-z][a-z0-9_]*$/.test(candidateCode)
    ? candidateCode
    : defaultCode(response.status);
  const message = (typeof nested?.message === 'string' ? nested.message : undefined)
    ?? (typeof payload.message === 'string' ? payload.message : undefined)
    ?? flatError
    ?? `Request failed with ${response.status}`;
  const nestedCail = nested?.cail && typeof nested.cail === 'object'
    ? nested.cail as Record<string, unknown>
    : {};
  const loginUrl = typeof nestedCail.login_url === 'string'
    ? nestedCail.login_url
    : typeof payload.login_url === 'string' ? payload.login_url : undefined;
  const retryHeader = response.headers.get('X-Should-Retry');
  const retryable = typeof nestedCail.retryable === 'boolean'
    ? nestedCail.retryable
    : retryHeader === null ? undefined : retryHeader === 'true';
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json; charset=UTF-8');
  return Response.json(canonicalError(code, message, {
    type: typeof nested?.type === 'string' ? nested.type : defaultType(response.status),
    param: typeof nested?.param === 'string' ? nested.param : null,
    requestId: typeof nestedCail.request_id === 'string' ? nestedCail.request_id : requestId,
    loginUrl,
    retryable,
  }), { status: response.status, headers });
}
