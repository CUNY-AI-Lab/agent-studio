/**
 * CAIL gateway identity (CUNYLogin SSO) for the Agent Studio worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu injects X-CAIL-* headers
 * after authentication. This worker is also directly reachable on its
 * workers.dev URL, so bare X-CAIL-* headers prove nothing — anyone can set
 * them. Identity is accepted only from a signed identity JWT. V2 uses RS256
 * with a configured static public JWKS; V1 retains the HS256 shared-secret
 * contract.
 *
 * The JWT verifiers are shared @cuny-ai-lab/cail-identity primitives — one
 * source of truth across the CAIL fleet for pinned algorithms, audience/time
 * claims, and an EXACT issuer allowlist. This module keeps
 * only the agent-studio-specific glue around it: header/slug constants, the
 * request/credential wrappers, the subject→session derivation, and the
 * enforcement flag + 401 envelope. The stable pseudonymous `subject`
 * ("cail-<hex>") is the only durable key for per-user data — never key
 * anything by email.
 *
 * X-CAIL-Identity-JWT-V2 has strict precedence when present. A malformed V2
 * token or missing/malformed CAIL_IDENTITY_JWKS never falls back to V1. When
 * V2 is absent, X-CAIL-Identity-JWT keeps its existing HS256 behavior.
 */

import {
  verifyIdentityJwt,
  verifyIdentityJwtV2,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  type CailIdentity,
} from '@cuny-ai-lab/cail-identity';

export { verifyIdentityJwt };
export type { CailIdentity };

export const CAIL_IDENTITY_HEADER = 'X-CAIL-Identity-JWT';
export const CAIL_IDENTITY_HEADER_V2 = 'X-CAIL-Identity-JWT-V2';
export const CAIL_APP_SLUG = 'agent-studio';
export const CAIL_IDENTITY_AUDIENCE = 'cail:agent-studio';

/**
 * The issuers this worker trusts, passed to the shared verifier as an EXACT
 * allowlist (I8). Both prod and staging gateways are accepted; any other `iss`
 * — including a look-alike like `https://evil.example/cail-sso` that the old
 * suffix check would have waved through — is rejected. Fail closed: this list
 * is the ONLY way an issuer becomes trusted.
 */
export const CAIL_ALLOWED_ISSUERS = [CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER];

export interface CailIdentityEnv {
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_REQUIRE_IDENTITY?: string;
}

export type CailIdentityVersion = 'v1' | 'v2';

export interface VerifiedCailIdentity {
  token: string;
  version: CailIdentityVersion;
  identity: CailIdentity;
}

const encoder = new TextEncoder();

/**
 * Verify a client-supplied credential JWT AND bind it to an expected session id.
 *
 * Used by WorkspaceAgent.setCailCredential, which is a @callable RPC method any
 * connected client can invoke over the WS channel — so an unverified string
 * must never be accepted as the model-proxy credential, and even a genuinely
 * valid token belonging to a DIFFERENT subject must not be installable onto
 * this DO. We verify the matching V1 or V2 signature/claims, then
 * derive the subject's session id the same way session.ts does and require it
 * to equal this DO's session id.
 *
 * Returns the verified identity on success, or null when the token is
 * invalid/expired OR its subject maps to a different session id. Never throws.
 */
async function verifyCailIdentityToken(
  token: string | null | undefined,
  version: CailIdentityVersion,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | null> {
  if (!token) return null;
  if (version === 'v2') {
    if (!env.CAIL_IDENTITY_JWKS) return null;
    let jwks: Parameters<typeof verifyIdentityJwtV2>[1];
    try {
      jwks = JSON.parse(env.CAIL_IDENTITY_JWKS) as Parameters<typeof verifyIdentityJwtV2>[1];
    } catch {
      return null;
    }
    return verifyIdentityJwtV2(token, jwks, {
      expectedAudience: CAIL_IDENTITY_AUDIENCE,
      allowedIssuers: CAIL_ALLOWED_ISSUERS,
      now,
    });
  }

  if (version !== 'v1') return null;
  if (!env.CAIL_IDENTITY_JWT_SECRET) return null;
  return verifyIdentityJwt(token, env.CAIL_IDENTITY_JWT_SECRET, {
    allowedIssuers: CAIL_ALLOWED_ISSUERS,
    now,
  });
}

export async function verifyCredentialForSession(
  token: string | null | undefined,
  expectedSessionId: string,
  version: CailIdentityVersion,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | null> {
  const identity = await verifyCailIdentityToken(token, version, env, now);
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
): Promise<VerifiedCailIdentity | null> {
  let token: string | null;
  let version: CailIdentityVersion;
  if (request.headers.has(CAIL_IDENTITY_HEADER_V2)) {
    token = request.headers.get(CAIL_IDENTITY_HEADER_V2);
    version = 'v2';
  } else {
    token = request.headers.get(CAIL_IDENTITY_HEADER);
    version = 'v1';
  }
  if (!token) return null;
  const identity = await verifyCailIdentityToken(token, version, env, now);
  if (!identity) return null;
  return { token, version, identity };
}

/** True when at least one identity verification mechanism is configured. */
export function cailIdentityConfigured(env: CailIdentityEnv): boolean {
  return Boolean(env.CAIL_IDENTITY_JWKS || env.CAIL_IDENTITY_JWT_SECRET);
}

/**
 * True when the worker must reject anonymous requests to model/spend paths
 * (401). If the flag is on but neither mechanism can verify the request, those
 * paths close — never open — by misconfiguration.
 */
export function cailIdentityRequired(env: CailIdentityEnv): boolean {
  return env.CAIL_REQUIRE_IDENTITY === 'true';
}

/**
 * 401 body matching the CAIL error envelope so the same-origin frontend's
 * auth handling redirects to /login?rt=<path> like the other tools.
 */
export function cailAuthRequiredResponse(loginPath = '/login'): Response {
  return new Response(
    JSON.stringify({
      error: 'authentication_required',
      login_url: loginPath,
      message:
        'Sign in with CUNY Login at https://tools.ailab.gc.cuny.edu to use Agent Studio.',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="CAIL"',
      },
    },
  );
}
