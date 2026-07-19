import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { createOpaqueId } from './ids';
import {
  accountImportWindowState,
  legacyAccountCompatibilityAllowed,
  type Env,
} from '../env';
import {
  cailAuthRequiredResponse,
  cailIdentityMisconfiguredResponse,
  cailIdentityRequired,
  getCailIdentityFromRequest,
  isCailIdentityConfigError,
  sessionIdForSubject,
  type CailIdentity,
} from './cail-identity';
import { runFirstLoginMigration } from './migration';
import {
  LOG_PRODUCT,
  STUDIO_EVENTS,
  principalForSubject,
  studioLogger,
} from './logging';

const SESSION_COOKIE_NAME = 'agent-studio-session';

export type SessionVariables = {
  sessionId: string;
  /** Verified CAIL identity, or null when the request is anonymous. */
  cailIdentity: CailIdentity | null;
  /** Verified raw identity JWT to forward to the model proxy, or null. */
  cailIdentityJwt: string | null;
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
  // claims are never trusted (this worker is reachable on workers.dev).
  const verified = await getCailIdentityFromRequest(c.req.raw, c.env);

  // Our verification config failed to LOAD — an operator error, never the
  // caller's. Typed 503, distinct from the token-invalid/anonymous 401 below;
  // otherwise a CAIL misconfiguration presents as every user's auth failing.
  if (isCailIdentityConfigError(verified)) {
    studioLogger(c.env)?.emit(STUDIO_EVENTS.STARTUP_CONFIG_INVALID, {
      product_id: LOG_PRODUCT,
      terminal: { outcome: 'denied', reason: 'denied' },
      error_type: `cail_identity_${verified.configError}`,
    });
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

    // First login after working anonymously: the browser still carries a
    // valid legacy anonymous cookie. Migrate that namespace's data into the
    // subject namespace (claim-once, idempotent — see lib/migration.ts),
    // then drop the cookie so the check never re-triggers. The cookie is
    // kept when the run is still in progress elsewhere or failed, so a
    // later request can retry.
    const legacyCookie = getCookie(c, SESSION_COOKIE_NAME);
    if (legacyCookie) {
      const anonSessionId = await verifySignedValue(legacyCookie, sessionSecret);
      if (anonSessionId && anonSessionId !== sessionId) {
        const now = Date.now();
        const windowState = accountImportWindowState(c.env, now);
        if (legacyAccountCompatibilityAllowed(c.env, now)) {
          const startedAt = now;
          try {
            const outcome = await runFirstLoginMigration(c.env, anonSessionId, sessionId, now);
            if (outcome !== 'in-progress' && outcome !== 'window-not-open') {
              deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
            }
            const succeeded = outcome === 'migrated' || outcome === 'already-done';
            const importFields = {
              product_id: LOG_PRODUCT,
              principal: principalForSubject(verified.identity.subject),
              duration_ms: Date.now() - startedAt,
            };
            if (succeeded) {
              studioLogger(c.env)?.emit(STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL, {
                ...importFields,
                terminal: { outcome: 'ok', reason: 'completed' },
              });
            } else {
              studioLogger(c.env)?.emit(STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL, {
                ...importFields,
                terminal: { outcome: 'denied', reason: 'denied' },
                error_type: `first_login_${outcome.replaceAll('-', '_')}`,
              });
            }
          } catch {
            // Soft-fail: the user sees their subject namespace (possibly still
            // empty); the claim is marked failed and the next request retries.
            // Structured event, metadata only: the subject identifies the user
            // (session ids derive from it); the error itself is never logged.
            studioLogger(c.env)?.emit(STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL, {
              product_id: LOG_PRODUCT,
              principal: principalForSubject(verified.identity.subject),
              terminal: { outcome: 'error', reason: 'application_failure' },
              duration_ms: Date.now() - startedAt,
              error_type: 'first_login_migration_failed',
            });
          }
        } else if (windowState === 'expired') {
          // The deadline is final: never retain a cookie that could trigger a
          // later import if compatibility code is accidentally re-enabled.
          deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
          studioLogger(c.env)?.emit(STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL, {
            product_id: LOG_PRODUCT,
            principal: principalForSubject(verified.identity.subject),
            terminal: { outcome: 'denied', reason: 'denied' },
            duration_ms: 0,
            error_type: 'legacy_account_import_window_expired',
          });
        } // Before the switch, keep the cookie so the first in-window request can import it.
      } else {
        // Invalid signature or (vanishingly unlikely) same id: nothing to
        // migrate — drop the stale cookie.
        deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
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
  }

  c.set('sessionId', sessionId);
  await next();
};

export function requireSession(c: SessionContext): string {
  return c.get('sessionId');
}

export function cailIdentityJwt(c: SessionContext): string | null {
  return c.get('cailIdentityJwt');
}
