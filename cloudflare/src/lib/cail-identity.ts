/**
 * CAIL gateway identity (CUNYLogin SSO) for the Agent Studio worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu injects X-CAIL-* headers
 * after authentication. This worker is also directly reachable on its
 * workers.dev URL, so bare X-CAIL-* headers prove nothing — anyone can set
 * them. Identity is accepted only from an RS256 identity JWT verified against
 * the configured static public JWKS for this service's audience.
 *
 * The JWT verifiers are shared @cuny-ai-lab/cail-identity primitives — one
 * source of truth across the CAIL fleet for pinned algorithms, audience/time
 * claims, and one exact issuer per environment. This module keeps
 * only the agent-studio-specific glue around it: header/slug constants, the
 * request/credential wrappers, the subject→session derivation, and the
 * enforcement flag + 401 envelope. The stable pseudonymous `subject`
 * ("cail-<hex>") is the only durable key for per-user data — never key
 * anything by email.
 */

import {
  parseIdentityConfig,
  verifyIdentityJwt,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  type CailIdentity,
  type IdentityConfigErrorReason,
} from '@cuny-ai-lab/cail-identity';
import { canonicalError } from './error-envelope';

export { verifyIdentityJwt, CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER };
export type { CailIdentity, IdentityConfigErrorReason };

export const CAIL_IDENTITY_HEADER = 'X-CAIL-Identity-JWT';
export const CAIL_APP_SLUG = 'agent-studio';
export const CAIL_IDENTITY_AUDIENCE = 'cail:agent-studio';

/**
 * The only issuer values an operator may select. Verification still receives
 * exactly one configured value, so production and staging namespaces can
 * never be combined in one trust decision.
 */
export const CAIL_SUPPORTED_ISSUERS = [CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER] as const;

export interface CailIdentityEnv {
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_REQUIRE_IDENTITY?: string;
}

export interface VerifiedCailIdentity {
  token: string;
  identity: CailIdentity;
}

/**
 * The worker could not LOAD its own identity verification config (malformed
 * `CAIL_IDENTITY_JWKS`, missing/unsupported issuer, or identity required but
 * unconfigured). Operator error, not a token error: HTTP surfaces map it to a
 * typed 503 + structured log, never to the token-invalid 401/anonymous path.
 * (`validateAgentStudioConfig` catches this at startup for production; this
 * covers runtime drift and non-production environments.)
 */
export interface CailIdentityConfigError {
  configError: IdentityConfigErrorReason;
}

export function isCailIdentityConfigError(value: unknown): value is CailIdentityConfigError {
  return typeof value === 'object' && value !== null && 'configError' in value;
}

const encoder = new TextEncoder();

export function resolveCailIdentityIssuer(env: CailIdentityEnv): string | null {
  const issuer = env.CAIL_IDENTITY_ISSUER;
  return typeof issuer === 'string'
    && CAIL_SUPPORTED_ISSUERS.some((supported) => supported === issuer)
    ? issuer
    : null;
}

/**
 * Load the verification config via the shared parseIdentityConfig primitive.
 *
 * Returns `null` — identity feature OFF — only when NOTHING is configured and
 * enforcement is off (anonymous dev/preview environments). Any partial or
 * malformed configuration, or enforcement without configuration, is a config
 * error: the operator intended identity to work and it cannot.
 */
function loadIdentityConfig(
  env: CailIdentityEnv,
): { ok: true; jwks: Parameters<typeof verifyIdentityJwt>[1]; issuer: string } | CailIdentityConfigError | null {
  const jwksConfigured = typeof env.CAIL_IDENTITY_JWKS === 'string' && env.CAIL_IDENTITY_JWKS.trim() !== '';
  const issuerConfigured = typeof env.CAIL_IDENTITY_ISSUER === 'string' && env.CAIL_IDENTITY_ISSUER !== '';
  if (!jwksConfigured && !issuerConfigured && !cailIdentityRequired(env)) return null;
  const config = parseIdentityConfig({
    jwks: env.CAIL_IDENTITY_JWKS,
    issuer: env.CAIL_IDENTITY_ISSUER,
    supportedIssuers: CAIL_SUPPORTED_ISSUERS,
  });
  if (!config.ok) return { configError: config.reason };
  return config;
}

/**
 * Verify a client-supplied credential JWT AND bind it to an expected session id.
 *
 * Used by the internal WorkspaceAgent.setCailCredential RPC. Even though the
 * method is not browser-callable, it treats the forwarded token as untrusted:
 * an unverified string must never become the model-proxy credential, and a
 * valid token for a DIFFERENT subject must not be installable onto this DO. We
 * verify the signature/claims, then derive the subject's session id the same
 * way session.ts does and require it to equal this DO's session id.
 *
 * Returns the verified identity on success, or null when the token is
 * invalid/expired OR its subject maps to a different session id. Never throws.
 */
async function verifyCailIdentityToken(
  token: string | null | undefined,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | CailIdentityConfigError | null> {
  if (!token) return null;
  const config = loadIdentityConfig(env);
  if (config === null) return null;
  if (isCailIdentityConfigError(config)) return config;
  return verifyIdentityJwt(token, config.jwks, {
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
    allowedIssuers: [config.issuer],
    now,
  });
}

export async function verifyCredentialForSession(
  token: string | null | undefined,
  expectedSessionId: string,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | CailIdentityConfigError | null> {
  const identity = await verifyCailIdentityToken(token, env, now);
  if (isCailIdentityConfigError(identity)) return identity;
  if (!identity) return null;
  const derived = await sessionIdForSubject(identity.subject);
  if (derived !== expectedSessionId) return null;
  return identity;
}

/**
 * Derive the stable session id from a CAIL subject: SHA-256 over `cail:`+subject,
 * first 16 bytes as hex. This is the single source of truth — session.ts's
 * middleware imports it to key per-user data, and credential-binding above uses
 * it so an installed credential's subject is always tied to the same session id
 * the user's data lives under. Owned here (not in session.ts) so cail-identity
 * stays leaf-level and there is no import cycle.
 */
export async function sessionIdForSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`cail:${subject}`));
  const bytes = new Uint8Array(digest).slice(0, 16);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read and verify the identity JWT from a request. Returns both the raw token
 * (which model calls forward to the proxy as the caller's credential) and the
 * verified identity, or null when the request is anonymous / the token fails.
 */
export async function getCailIdentityFromRequest(
  request: Request,
  env: CailIdentityEnv,
  now?: number,
): Promise<VerifiedCailIdentity | CailIdentityConfigError | null> {
  const token = request.headers.get(CAIL_IDENTITY_HEADER);
  if (!token) return null;
  const identity = await verifyCailIdentityToken(token, env, now);
  if (isCailIdentityConfigError(identity)) return identity;
  if (!identity) return null;
  return { token, identity };
}

/**
 * True when the worker must reject anonymous requests to model/spend paths
 * (401). If the flag is on but the configured JWKS cannot verify the request,
 * those paths close rather than opening through misconfiguration.
 */
export function cailIdentityRequired(env: CailIdentityEnv): boolean {
  return env.CAIL_REQUIRE_IDENTITY === 'true';
}

/**
 * Canonical CAIL 401 envelope consumed by every Studio client surface.
 */
/**
 * Typed 503 for an identity verification config the worker could not load.
 * Deliberately distinct from cailAuthRequiredResponse's 401: a bad token is
 * the caller's problem, an unloadable config is ours.
 */
export function cailIdentityMisconfiguredResponse(): Response {
  return new Response(
    JSON.stringify(canonicalError(
      'identity_verification_misconfigured',
      'CAIL identity verification is not configured on this service, which is a CAIL configuration problem. Please report this to ailab@gc.cuny.edu.',
      { type: 'api_error', retryable: true },
    )),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

export function cailAuthRequiredResponse(loginPath = '/login'): Response {
  return new Response(
    JSON.stringify(canonicalError(
      'authentication_required',
      'Sign in with CUNY Login at https://tools.ailab.gc.cuny.edu to use Agent Studio.',
      { type: 'authentication_error', loginUrl: loginPath, retryable: false },
    )),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="CAIL"',
      },
    },
  );
}
