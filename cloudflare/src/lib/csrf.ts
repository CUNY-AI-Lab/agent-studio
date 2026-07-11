// CSRF defense for the fleet contract (cail-gateway docs/INTEGRATION.md §3¾).
//
// The SSO gate authenticates browsers with an ambient session cookie, so a
// state-changing request forged by another site can arrive already carrying a
// valid gate-injected identity. Identity proves *who*; it says nothing about
// *where the request came from*. This module adds the two tool-side defenses
// the gate does not provide:
//
//   * Rule 2 — origin-check: reject non-same-origin requests. Same-origin and
//     absent origin headers both fall through to the token check; origin headers
//     can reject, never authorize. `same-site` (cross-origin within the
//     registrable domain) is rejected — the 2026-07-05 clarification makes this
//     required, not extra.
//   * Rule 3 — per-session token: an HMAC-derived, per-session token the tool
//     issues to its own first-party pages and requires echoed in X-CAIL-CSRF on
//     every mutation and sensitive workspace read. A sibling tool can't read
//     it; a cross-site page can't set the custom header without a CORS preflight
//     we never approve. This — not the origin check — is what isolates sibling
//     tools on the same host.
//
// The token is HMAC-derived from SESSION_SECRET over `csrf:<sessionId>`
// (deterministic, stateless, sibling tools can't mint it without the secret),
// mirroring the key-derivation approach in lib/session.ts.

import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '../env';
import type { SessionVariables } from './session';

/** Custom header the frontend echoes the per-session token in (fleet convention). */
export const CSRF_HEADER = 'X-CAIL-CSRF';

/**
 * Name of the path-scoped, script-readable cookie the token is delivered in
 * (fleet contract §3¾ rule 3 delivery amendment, 2026-07-05). Delivery via
 * Set-Cookie — a forbidden response header, unreadable by script even
 * same-origin — is the one same-origin-proof channel: a sibling tool or
 * `/sites/` user content can `fetch()` our endpoints with the ambient session
 * and read a JSON/HTML body, but cannot read our Set-Cookie. `document.cookie`
 * exposes the value only to documents under the cookie's Path prefix, which is
 * what isolates siblings. NOT HttpOnly: our own page JS must read it to echo it
 * in X-CAIL-CSRF. Token value stays the stateless HMAC (delivery is the pinned
 * part; the value scheme is ours).
 */
export const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';

/**
 * Query-param name carrying the per-session token on WebSocket upgrades and
 * sensitive element-src GETs (which cannot set X-CAIL-CSRF). The DO verifies
 * it once at accept (see WorkspaceAgent.onConnect) for WebSockets.
 */
export const CSRF_WS_QUERY_PARAM = 'csrfToken';

/** Methods that never change state: no origin/token check, per rule 1. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The canonical origin a same-origin request must match. Per the contract, a
 * gated tool not yet on tools.ailab uses its OWN serving origin (derived from
 * the request URL) until the central allow-list exists. CAIL_CANONICAL_ORIGIN
 * overrides this for the tools.ailab deployment, where the browser-visible
 * origin differs from the worker's own request URL.
 */
export function canonicalOrigin(c: Context<{ Bindings: Env; Variables: SessionVariables }>): string {
  const override = (c.env as { CAIL_CANONICAL_ORIGIN?: string }).CAIL_CANONICAL_ORIGIN;
  if (override) return override.replace(/\/+$/, '');
  return new URL(c.req.url).origin;
}

/**
 * Derive the per-session CSRF token: HMAC-SHA-256(SESSION_SECRET) over
 * `csrf:<sessionId>`, hex-encoded. Deterministic so it needs no storage and
 * survives hibernation; stateless so both the issuing GET and the verifying
 * mutation compute the same value. `sessionId` is the subject-derived id when
 * authenticated, or the anonymous session id — both are already the tool's
 * per-user key (see lib/session.ts), satisfying rule 3's keying requirement.
 */
export async function deriveCsrfToken(sessionId: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`csrf:${sessionId}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the Path the CSRF cookie is scoped to (fleet contract §3¾ rule 3
 * delivery amendment). CAIL_BASE_PATH is the tool's serving prefix; production
 * on tools.ailab sets '/agent-studio' so siblings can't read the cookie via
 * document.cookie. Defaults to '/' (acceptable locally / on workers.dev, which
 * have no same-origin siblings). A trailing slash is trimmed (except the bare
 * root), and a missing leading slash is added, so any reasonable env value maps
 * to a valid cookie Path.
 */
export function csrfCookiePath(env: { CAIL_BASE_PATH?: string }): string {
  const raw = (env.CAIL_BASE_PATH ?? '').trim();
  if (!raw || raw === '/') return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = withLeading.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Deliver the CSRF token to a first-party page via Set-Cookie (the pinned
 * same-origin-proof channel — see CSRF_COOKIE_NAME). Called on the /api/session
 * bootstrap GET. Attributes: Path = the tool's base path (scopes visibility to
 * our documents), Secure on https, SameSite=Lax, NOT HttpOnly (our page JS
 * reads it). The value is the stateless HMAC token; the server never stores it
 * (verification re-derives), keeping this a true double-submit.
 */
export function setCsrfCookie(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
  token: string,
): void {
  setCookie(c, CSRF_COOKIE_NAME, token, {
    path: csrfCookiePath(c.env),
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    httpOnly: false,
  });
}

/** Constant-time string compare so token checks don't leak length/content via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export type OriginVerdict = 'same-origin' | 'reject' | 'absent';

/**
 * Classify a request's origin against the canonical origin, per rule 2:
 *   * Sec-Fetch-Site: same-origin  -> same-origin (token still required).
 *   * Sec-Fetch-Site present but not same-origin (same-site/cross-site/none)
 *     -> reject. `same-site` is a mismatch by the 2026-07-05 clarification.
 *   * Origin header exactly equal to canonical -> same-origin (token still required).
 *   * Origin header present but different       -> reject.
 *   * BOTH Sec-Fetch-Site and Origin absent     -> absent (defer to token).
 * We prefer Sec-Fetch-Site (browser-set, unforgeable by page script) over
 * Origin per rule 6.
 */
export function classifyOrigin(
  secFetchSite: string | null,
  origin: string | null,
  canonical: string,
): OriginVerdict {
  if (secFetchSite) {
    return secFetchSite === 'same-origin' ? 'same-origin' : 'reject';
  }
  if (origin) {
    return origin === canonical ? 'same-origin' : 'reject';
  }
  return 'absent';
}

/**
 * Verify the origin + token contract for one HTTP request. Returns null when
 * the request is allowed, or a 403 Response when it must be rejected. Safe
 * methods pass untouched (rule 1 forbids state changes on them anyway).
 * Origin headers can only reject; every unsafe cookie-authenticated request
 * must carry the per-session token.
 *
 * Bearer sk-cail-* API clients (no ambient cookie in play) would be accepted on
 * the key alone; Agent Studio has no Bearer path today, so this is a documented
 * no-op — if one is added, short-circuit here before the origin check.
 */
export async function enforceCsrf(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
): Promise<Response | null> {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return null;

  const canonical = canonicalOrigin(c);
  const verdict = classifyOrigin(
    c.req.header('Sec-Fetch-Site') ?? null,
    c.req.header('Origin') ?? null,
    canonical,
  );

  if (verdict === 'reject') {
    return c.json({ error: 'csrf_origin_mismatch' }, 403);
  }

  // Same-origin and absent headers both prove nothing about sibling tools.
  const provided = c.req.header(CSRF_HEADER);
  if (!provided) {
    return c.json({ error: 'csrf_token_missing' }, 403);
  }
  const sessionId = c.get('sessionId');
  const expected = await deriveCsrfToken(sessionId, c.env.SESSION_SECRET);
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: 'csrf_token_invalid' }, 403);
  }
  return null;
}

/**
 * Require the per-session CSRF token on a sensitive READ (rule 3 extended to GET). The
 * token proves first-party origin: a same-origin sibling cannot read the path-scoped
 * cookie, so it cannot supply the token. Accepts header or ?csrfToken= (for element-src).
 * Only enforces GET/HEAD; other methods are covered by enforceCsrf. Returns 403 or null.
 */
export async function enforceCsrfRead(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
): Promise<Response | null> {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  let queryToken: string | null = null;
  try {
    queryToken = new URL(c.req.url).searchParams.get(CSRF_WS_QUERY_PARAM);
  } catch {
    queryToken = null;
  }
  const provided = c.req.header(CSRF_HEADER) ?? queryToken;
  if (!provided) return c.json({ error: 'csrf_token_missing' }, 403);
  const sessionId = c.get('sessionId');
  const expected = await deriveCsrfToken(sessionId, c.env.SESSION_SECRET);
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: 'csrf_token_invalid' }, 403);
  }
  return null;
}

/**
 * Hono middleware wrapping enforceCsrf. Mount AFTER sessionMiddleware so
 * c.get('sessionId') is populated (the token keys off it).
 */
export const csrfMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: SessionVariables;
}> = async (c, next) => {
  const rejection = await enforceCsrf(c);
  if (rejection) return rejection;
  return next();
};

export const csrfReadMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: SessionVariables;
}> = async (c, next) => {
  const rejection = await enforceCsrfRead(c);
  if (rejection) return rejection;
  return next();
};

// ---------------------------------------------------------------------------
// WebSocket upgrade origin check (rule 4)
// ---------------------------------------------------------------------------

/**
 * Origin-check a WebSocket upgrade request against the canonical origin, before
 * routeAgentRequest accepts it. The browser does NOT enforce same-origin on WS
 * handshakes, and the connection-lifetime JWT means there is no second chance —
 * so this must run at accept time.
 *
 * The per-connection CSRF token gate is enforced separately, inside the DO at
 * accept (see WorkspaceAgent.onConnect, which reads the token from the upgrade
 * URL). A handshake with a present-but-mismatched origin is rejected here; a
 * handshake with no Origin/Sec-Fetch-Site header (non-browser client, e.g. the
 * smoke harness) is allowed through to that token gate, matching the HTTP
 * "absent -> defer to token" posture.
 *
 * `canonicalOverride` mirrors CAIL_CANONICAL_ORIGIN; pass it from the env at the
 * call site (the raw fetch handler has no Hono context).
 */
export function wsOriginAllowed(request: Request, canonicalOverride?: string): boolean {
  const canonical = canonicalOverride
    ? canonicalOverride.replace(/\/+$/, '')
    : new URL(request.url).origin;
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  const verdict = classifyOrigin(secFetchSite, origin, canonical);
  // same-origin -> allow; absent -> allow (defer to the connect token gate);
  // reject -> block the upgrade.
  return verdict !== 'reject';
}

/** Session id embedded in an /agents/<ns>/<sessionId>-<wid> WS path, or null. */
export function wsAgentSessionIdFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'agents') return null;
  const name = parts[2];
  if (!name) return null;
  const match = /^([0-9a-f]{32})-/.exec(name);
  return match ? match[1] : null;
}

/**
 * Validate the per-connection CSRF token on an /agents/* WS upgrade at the edge.
 * Mirrors WorkspaceAgent.onConnect's check but runs before routeAgentRequest, so an
 * unauthorized socket never reaches the DO (no state frame is queued). Returns false
 * for a non-agent path, a missing/oddly-shaped name, a missing token, or a mismatch.
 */
export async function wsAgentCsrfValid(request: Request, secret: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const sessionId = wsAgentSessionIdFromPath(url.pathname);
  if (!sessionId) return false;
  const token = url.searchParams.get(CSRF_WS_QUERY_PARAM);
  if (!token) return false;
  const expected = await deriveCsrfToken(sessionId, secret);
  return timingSafeEqual(token, expected);
}
