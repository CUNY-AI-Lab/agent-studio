/**
 * CAIL gateway identity (CUNYLogin SSO) for the Agent Studio worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu injects X-CAIL-* headers
 * after authentication. This worker is also directly reachable on its
 * workers.dev URL, so bare X-CAIL-* headers prove nothing — anyone can set
 * them. Identity is accepted ONLY from a X-CAIL-Identity-JWT that verifies
 * against the shared secret.
 *
 * The JWT verifier is the shared @cuny-ai-lab/cail-identity primitive — one
 * source of truth across the CAIL fleet (HS256 pinned, aud "cail-internal",
 * exp/nbf with 60s leeway, and an EXACT issuer allowlist). This module keeps
 * only the agent-studio-specific glue around it: header/slug constants, the
 * request/credential wrappers, the subject→session derivation, and the
 * enforcement flag + 401 envelope. The stable pseudonymous `subject`
 * ("cail-<hex>") is the only durable key for per-user data — never key
 * anything by email.
 *
 * If CAIL_IDENTITY_JWT_SECRET is unset, identity is disabled and every
 * request is anonymous (pre-rollout behavior). CAIL_REQUIRE_IDENTITY="true"
 * makes model calls fail closed: requests without a verified identity JWT
 * get 401. Flip it (with the secret set) at the same time
 * CAIL_SSO_MODE=enforce lands on the gateway.
 */

import {
  verifyIdentityJwt,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  type CailIdentity,
} from '@cuny-ai-lab/cail-identity';

export { verifyIdentityJwt };
export type { CailIdentity };

export const CAIL_IDENTITY_HEADER = 'X-CAIL-Identity-JWT';
export const CAIL_APP_SLUG = 'agent-studio';

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
  CAIL_REQUIRE_IDENTITY?: string;
}

const encoder = new TextEncoder();

/**
 * Verify a client-supplied credential JWT AND bind it to an expected session id.
 *
 * Used by WorkspaceAgent.setCailCredential, which is a @callable RPC method any
 * connected client can invoke over the WS channel — so an unverified string
 * must never be accepted as the model-proxy credential, and even a genuinely
 * valid token belonging to a DIFFERENT subject must not be installable onto
 * this DO. We verify the HMAC/claims through the single verifier above, then
 * derive the subject's session id the same way session.ts does and require it
 * to equal this DO's session id.
 *
 * Returns the verified identity on success, or null when the token is
 * invalid/expired OR its subject maps to a different session id. Never throws.
 */
export async function verifyCredentialForSession(
  token: string | null | undefined,
  expectedSessionId: string,
  secret: string | undefined,
  now?: number,
): Promise<CailIdentity | null> {
  // The shared verifier requires a present token+secret and an explicit issuer
  // allowlist; guard the "identity disabled / no token" cases here so callers
  // keep passing `string | undefined` unchanged.
  if (!secret || !token) return null;
  const identity = await verifyIdentityJwt(token, secret, {
    allowedIssuers: CAIL_ALLOWED_ISSUERS,
    now,
  });
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
): Promise<{ token: string; identity: CailIdentity } | null> {
  const token = request.headers.get(CAIL_IDENTITY_HEADER);
  if (!token) return null;
  const secret = env.CAIL_IDENTITY_JWT_SECRET;
  // No secret configured → identity disabled (anonymous). Guard before the
  // shared verifier, which requires a present secret.
  if (!secret) return null;
  const identity = await verifyIdentityJwt(token, secret, {
    allowedIssuers: CAIL_ALLOWED_ISSUERS,
    now,
  });
  if (!identity) return null;
  return { token, identity };
}

/**
 * True when the worker must reject anonymous requests to model/spend paths
 * (401). If the flag is on but the secret is missing, every identity check
 * fails and those paths close — never open — by misconfiguration.
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
