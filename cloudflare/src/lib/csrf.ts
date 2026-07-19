// CSRF defense for the institutional CAIL tool-delivery contract.
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
// Tokens are short-lived signed capabilities bound to both the current session
// and its principal class. They are stateless, but neither deterministic nor
// valid across the anonymous-to-subject cutover.

import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { normalizeBasePath } from './base-path';
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
 * in X-CAIL-CSRF. The value is a stateless, short-lived signed capability.
 */
export const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';

/**
 * Query-param name carrying the per-session token on WebSocket upgrades. The
 * browser WebSocket API cannot set X-CAIL-CSRF, so the edge and DO verify this
 * value at accept. Sensitive HTTP reads use the header and blob URLs instead.
 */
export const CSRF_WS_QUERY_PARAM = 'csrfToken';
export const CSRF_TOKEN_TTL_SECONDS = 10 * 60;
const CSRF_CLOCK_SKEW_SECONDS = 30;
export type CsrfPrincipalKind = 'anonymous' | 'subject';

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
 * Sign one CSRF capability value with a key derived from SESSION_SECRET.
 */
async function signCsrfValue(value: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CsrfTokenClaims {
  principalKind: CsrfPrincipalKind;
  expiresAt: number;
}

/** Mint a non-deterministic, expiring capability bound to one session. */
export async function mintCsrfToken(
  sessionId: string,
  secret: string,
  principalKind: CsrfPrincipalKind,
  options: { now?: number; nonce?: string } = {},
): Promise<string> {
  const expiresAt = Math.floor((options.now ?? Date.now()) / 1000) + CSRF_TOKEN_TTL_SECONDS;
  const nonce = options.nonce ?? crypto.randomUUID().replaceAll('-', '');
  const unsigned = `v1.${principalKind}.${expiresAt}.${nonce}`;
  const signature = await signCsrfValue(`csrf:${sessionId}:${unsigned}`, secret);
  return `${unsigned}.${signature}`;
}

/** Verify signature, lifetime, and principal class without exposing session ids. */
export async function verifyCsrfToken(
  token: string | null,
  sessionId: string,
  secret: string,
  expectedPrincipalKind: CsrfPrincipalKind,
  now = Date.now(),
): Promise<CsrfTokenClaims | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, principalKind, expiresText, nonce, signature] = parts;
  if (
    version !== 'v1'
    || (principalKind !== 'anonymous' && principalKind !== 'subject')
    || principalKind !== expectedPrincipalKind
    || !/^\d{10}$/.test(expiresText)
    || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)
  ) return null;
  const expiresAt = Number(expiresText);
  const nowSeconds = Math.floor(now / 1000);
  if (
    expiresAt < nowSeconds - CSRF_CLOCK_SKEW_SECONDS
    || expiresAt > nowSeconds + CSRF_TOKEN_TTL_SECONDS + CSRF_CLOCK_SKEW_SECONDS
  ) return null;
  const unsigned = `${version}.${principalKind}.${expiresText}.${nonce}`;
  const expected = await signCsrfValue(`csrf:${sessionId}:${unsigned}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;
  return { principalKind, expiresAt };
}

/**
 * Resolve the Path the CSRF cookie is scoped to (fleet contract §3¾ rule 3
 * delivery amendment). The same normalized base path mounts the app, API,
 * WebSocket client, static assets, and this cookie. Local development defaults
 * to '/'; production preflight requires a non-root path.
 */
export function csrfCookiePath(env: { CAIL_BASE_PATH?: string }): string {
  return normalizeBasePath(env.CAIL_BASE_PATH);
}

/**
 * Deliver the CSRF token to a first-party page via Set-Cookie (the pinned
 * same-origin-proof channel — see CSRF_COOKIE_NAME). Called on the /api/session
 * bootstrap GET. Attributes: Path = CAIL_BASE_PATH, Secure on https,
 * SameSite=Lax, NOT HttpOnly (our page JS reads it). Path isolates sibling
 * documents only after the app is served under the same prefix. The value is
 * a short-lived signed capability; verification checks it without server-side
 * token storage.
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
    maxAge: CSRF_TOKEN_TTL_SECONDS,
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
 * This is Agent Studio's browser API boundary, not the model endpoint; it has
 * no direct bearer-client path.
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
  const principalKind = c.get('cailIdentity') ? 'subject' : 'anonymous';
  if (!(await verifyCsrfToken(provided, sessionId, c.env.SESSION_SECRET, principalKind))) {
    return c.json({ error: 'csrf_token_invalid' }, 403);
  }
  return null;
}

/**
 * Require the per-session CSRF token on a sensitive READ (rule 3 extended to GET). The
 * token proves first-party origin: a same-origin sibling cannot read the path-scoped
 * cookie, so it cannot supply the custom header. Capabilities are never accepted in
 * URLs, where browser history, referrers, and platform request logs could retain them.
 * Only enforces GET/HEAD; other methods are covered by enforceCsrf. Returns 403 or null.
 */
export async function enforceCsrfRead(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
): Promise<Response | null> {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const provided = c.req.header(CSRF_HEADER);
  if (!provided) return c.json({ error: 'csrf_token_missing' }, 403);
  const sessionId = c.get('sessionId');
  const principalKind = c.get('cailIdentity') ? 'subject' : 'anonymous';
  if (!(await verifyCsrfToken(provided, sessionId, c.env.SESSION_SECRET, principalKind))) {
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
export async function wsAgentCsrfValid(
  request: Request,
  secret: string,
  requireIdentity = false,
): Promise<boolean> {
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
  const principalKind = requireIdentity ? 'subject' : token.split('.')[1] === 'subject' ? 'subject' : 'anonymous';
  return Boolean(await verifyCsrfToken(token, sessionId, secret, principalKind));
}
