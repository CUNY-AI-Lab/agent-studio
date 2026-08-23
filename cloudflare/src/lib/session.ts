import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { createOpaqueId } from './ids';
import type { Env } from '../env';
import {
  cailAuthRequiredResponse,
  cailIdentityMisconfiguredResponse,
  cailIdentityRequired,
  getCailIdentityFromRequest,
  isCailIdentityConfigError,
  sessionIdForSubject,
  type CailIdentity,
  resolveKeyringGatewayJwt,
} from './cail-identity';
import {
  beginAnonymousSessionRequest,
  endAnonymousSessionRequest,
  runFirstLoginMigration,
} from './migration';
import { canonicalError } from './error-envelope';

const SESSION_COOKIE_NAME = 'agent-studio-session';

export type SessionVariables = {
  sessionId: string;
  /** Verified CAIL identity, or null when the request is anonymous. */
  cailIdentity: CailIdentity | null;
  /** Verified raw identity JWT to forward to the model proxy, or null. */
  cailIdentityJwt: string | null;
  cailGatewayJwt: string | null;
};

type SessionContext = Context<{
  Bindings: Env;
  Variables: SessionVariables;
}>;

// Session id derivation from the CAIL subject (SHA-256 over `cail:`+subject,
// first 16 bytes hex) lives in cail-identity.ts as the single source of truth,
// shared with credential-binding in the workspace DO. Imported above.

function hexToBuffer(value: string): ArrayBuffer {
  const buffer = new ArrayBuffer(value.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return buffer;
}

export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Derive the HMAC key by hashing the raw secret string, so any sufficiently
 * long secret works — not just even-length hex. The length check fails loud
 * with an actionable message; the earlier hex-only requirement turned
 * plausible non-hex secrets into opaque 500s deep inside the middleware.
 */
async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; generate one with \`openssl rand -hex 32\``
    );
  }
  const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signValue(value: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return `${value}.${bytesToHex(new Uint8Array(signature))}`;
}

export async function verifySignedValue(value: string, secret: string): Promise<string | null> {
  const [sessionId, signature] = value.split('.');
  if (!sessionId || !signature) return null;
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  const key = await importSigningKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    hexToBuffer(signature),
    new TextEncoder().encode(sessionId)
  );
  return ok ? sessionId : null;
}

export const sessionMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: SessionVariables;
}> = async (c, next) => {
  const sessionSecret = c.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required');
  }

  // Identity comes only from the verified CAIL identity JWT. Bare X-CAIL-*
  // claims are never trusted, including on direct or staging endpoints.
  const verified = await getCailIdentityFromRequest(c.req.raw, c.env);

  // Our verification config failed to LOAD — an operator error, never the
  // caller's. Typed 503, distinct from the token-invalid/anonymous 401 below;
  // otherwise a CAIL misconfiguration presents as every user's auth failing.
  if (isCailIdentityConfigError(verified)) {
    return cailIdentityMisconfiguredResponse();
  }

  // Fail closed on protected surfaces when enforcement is on and the request
  // is anonymous. Health checks are public and are not under /api/*.
  if (!verified && cailIdentityRequired(c.env)) {
    return cailAuthRequiredResponse();
  }

  let sessionId: string;
  if (verified) {
    // Key all per-user data by the stable pseudonymous CAIL subject.
    sessionId = await sessionIdForSubject(verified.identity.subject);
    c.set('cailIdentity', verified.identity);
    c.set('cailIdentityJwt', verified.token);
    // Keyring gateway leg (identity-keyring-v1): verified against the
    // gateway audience and bound to this request's verified subject before
    // it may ever be forwarded. A present-but-invalid leg fails closed.
    const gatewayLeg = await resolveKeyringGatewayJwt(
      c.req.raw,
      c.env,
      verified.identity.subject
    );
    if (gatewayLeg === 'invalid') {
      return cailAuthRequiredResponse();
    }
    c.set('cailGatewayJwt', gatewayLeg);

    // A verified identity may claim only the anonymous namespace represented
    // by a cryptographically valid legacy cookie. The importer writes one
    // completion marker after all content succeeds; failures keep the cookie
    // so a later request can retry.
    const legacyCookie = getCookie(c, SESSION_COOKIE_NAME);
    if (legacyCookie) {
      const anonSessionId = await verifySignedValue(legacyCookie, sessionSecret);
      if (!anonSessionId || anonSessionId === sessionId) {
        deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
      } else {
        try {
          const outcome = await runFirstLoginMigration(c.env, anonSessionId, sessionId);
          if (
            outcome === 'migrated'
            || outcome === 'already-done'
            || outcome === 'claimed-by-other'
          ) {
            deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
          }
        } catch {
          return c.json(
            canonicalError(
              'account_import_failed',
              'Your previous Agent Studio work could not be imported. Sign in again to retry.',
              { type: 'api_error', retryable: true },
            ),
            503,
          );
        }
      }
    }

  } else {
    // Anonymous / pre-rollout: fall back to the signed opaque cookie session.
    const existing = getCookie(c, SESSION_COOKIE_NAME);
    sessionId = existing ? (await verifySignedValue(existing, sessionSecret)) ?? '' : '';
    if (!sessionId) {
      sessionId = createOpaqueId();
      const signed = await signValue(sessionId, sessionSecret);
      setCookie(c, SESSION_COOKIE_NAME, signed, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: new URL(c.req.url).protocol === 'https:',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });
    }
    c.set('cailIdentity', null);
    c.set('cailIdentityJwt', null);
    c.set('cailGatewayJwt', null);
  }

  c.set('sessionId', sessionId);

  // A deployment that still admits anonymous requests must serialize those
  // writes with the first-login claim. Production identity enforcement rejects
  // anonymous traffic before this point; this also coordinates a direct
  // cutover with an already-admitted request from the prior version.
  const shouldFenceAnonymous = !verified && Boolean(c.env.CAIL_IDENTITY_JWKS?.trim());
  if (!shouldFenceAnonymous) {
    await next();
    return;
  }

  const requestId = crypto.randomUUID();
  const admitted = await beginAnonymousSessionRequest(c.env, sessionId, requestId);
  if (!admitted) {
    return c.json(
      canonicalError(
        'legacy_session_claimed',
        "We're moving your work to your account. Sign in and try again.",
        { type: 'conflict_error', retryable: true },
      ),
      409,
    );
  }
  try {
    await next();
  } finally {
    // A release error must not replace an otherwise unambiguous response. The
    // durable lock discards stale leases before a later claim attempt.
    await endAnonymousSessionRequest(c.env, sessionId, requestId).catch(() => undefined);
  }
};

export function requireSession(c: SessionContext): string {
  return c.get('sessionId');
}

export function cailIdentityJwt(c: SessionContext): string | null {
  return c.get('cailIdentityJwt');
}

/** The verified keyring gateway leg for this request, if delivered. */
export function cailGatewayJwt(c: SessionContext): string | null {
  return c.get('cailGatewayJwt');
}
