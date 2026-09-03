import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import type { SessionVariables } from './session';
import { canonicalError } from './error-envelope';

/**
 * Workers-native rate limiting for expensive operations.
 *
 * Mechanism: Cloudflare's Rate Limiting binding (wrangler.jsonc `unsafe.bindings`,
 * type "ratelimit"). Counting is per-colo and zero-latency — acceptable for
 * launch scale. The one HEAVY_RATE_LIMIT namespace protects paid chat,
 * sandbox execution, upload, raw workspace-file writes, import, and publish.
 * Ordinary API reads and other writes have no arbitrary application cap.
 *
 * Keying: by session id (c.get('sessionId')), which is stable across SSO
 * subjects and anonymous cookies — never by IP.
 *
 * Fail-open contract: when a binding is absent (local dev without the binding,
 * tests, or miniflare quirks) limiting is skipped entirely. Availability of a
 * research tool beats strictness, and CI smoke must keep passing.
 *
 * WebSocket chat does not pass through this middleware; WorkspaceAgent applies
 * the same HEAVY binding at chat admission.
 */

// POST paths that hit expensive operations and get the tighter HEAVY namespace.
// Matched against the request path; kept deliberately loose (substring) so the
// workspace-id segment in the middle doesn't need to be parsed out.
const HEAVY_PATH_PATTERNS = ['/runtime/execute', '/upload', '/import', '/publish'];

function isHeavyRequest(method: string, path: string): boolean {
  if (method === 'POST') return HEAVY_PATH_PATTERNS.some((pattern) => path.includes(pattern));
  // Raw workspace-file writes are the same expensive storage operation as the
  // multipart upload, but use PUT /api/workspaces/:id/files/*.
  return method === 'PUT'
    && path.startsWith('/api/workspaces/')
    && path.includes('/files/');
}

async function consumeHeavyLimit(
  limiter: RateLimit | undefined,
  key: string,
): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

/**
 * Enforce the HEAVY limit for an operation invoked OUTSIDE the HTTP middleware
 * (for example, a @callable Agent RPC). Same fail-open contract: no binding
 * means the call is allowed.
 */
export async function checkHeavyRpcLimit(
  env: { HEAVY_RATE_LIMIT?: RateLimit },
  key: string,
): Promise<boolean> {
  return consumeHeavyLimit(env.HEAVY_RATE_LIMIT, key);
}

export const rateLimitMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: SessionVariables;
}> = async (c, next) => {
  if (!isHeavyRequest(c.req.method, c.req.path)) return next();
  const key = c.get('sessionId');
  if (!(await consumeHeavyLimit(c.env.HEAVY_RATE_LIMIT, key))) {
    return c.json(
      canonicalError(
        'rate_limited',
        'Too many expensive operations — try again shortly.',
        { type: 'rate_limit_error', retryable: true },
      ),
      429,
    );
  }

  return next();
};
