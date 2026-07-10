import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import type { SessionVariables } from './session';

/**
 * Workers-native rate limiting for the HTTP `/api/*` surface.
 *
 * Mechanism: Cloudflare's Rate Limiting binding (wrangler.jsonc `unsafe.bindings`,
 * type "ratelimit"). Counting is per-colo and zero-latency — acceptable for
 * launch scale. Two namespaces:
 *   - API_RATE_LIMIT  {limit: 300, period: 60} — general /api/* requests.
 *   - HEAVY_RATE_LIMIT {limit: 20, period: 60} — expensive operations
 *     (runtime/execute, upload, import, publish).
 *
 * Keying: by session id (c.get('sessionId')), which is stable across SSO
 * subjects and anonymous cookies — never by IP.
 *
 * Fail-open contract: when a binding is absent (local dev without the binding,
 * tests, or miniflare quirks) limiting is skipped entirely. Availability of a
 * research tool beats strictness, and CI smoke must keep passing.
 *
 * NOT covered here: the WebSocket chat path (/agents/*) does not pass through
 * /api middleware. Per-message limiting belongs inside the DO and needs product
 * thinking about long agent turns — tracked as the known remainder in PLAN.md.
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
  const heavy = isHeavyRequest(c.req.method, c.req.path);
  const limiter = heavy ? c.env.HEAVY_RATE_LIMIT : c.env.API_RATE_LIMIT;

  // Fail open: no binding -> no limiting. Keeps local dev, tests, and CI smoke
  // working without the unsafe binding configured.
  if (!limiter) {
    return next();
  }

  const key = c.get('sessionId');
  const { success } = await limiter.limit({ key });
  if (!success) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests — try again shortly.' },
      429,
      { 'Retry-After': '30' }
    );
  }

  return next();
};
