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
 * sandbox execution, upload, import, and publish. Ordinary API reads and
 * writes have no arbitrary application cap.
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
  if (method !== 'POST') return false;
  return HEAVY_PATH_PATTERNS.some((pattern) => path.includes(pattern));
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
  const limiter = env.HEAVY_RATE_LIMIT;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export const rateLimitMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: SessionVariables;
}> = async (c, next) => {
  if (!isHeavyRequest(c.req.method, c.req.path)) return next();
  const limiter = c.env.HEAVY_RATE_LIMIT;

  // Fail open: no binding -> no limiting. Keeps local dev, tests, and CI smoke
  // working without the unsafe binding configured.
  if (!limiter) {
    return next();
  }

  const key = c.get('sessionId');
  const { success } = await limiter.limit({ key });
  if (!success) {
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
