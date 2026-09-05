/**
 * CAIL gateway identity (CUNYLogin SSO) for the Agent Studio worker.
 *
 * The standalone Doorway injects X-CAIL-* headers after authentication. A
 * direct or staging endpoint can still receive caller-controlled headers, so
 * bare X-CAIL-* headers prove nothing — anyone can set them. Identity is
 * accepted only from an RS256 identity JWT verified against the configured
 * static public JWKS for this service's audience.
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
  CAIL_CANONICAL_ISSUER,
  CAIL_GATEWAY_AUDIENCE,
  createCailAuthError,
  readIdentityKeyring,
  serializeCailAuthError,
  verifyKeyringGatewayJwt,
  loadIdentityVerifierConfig,
  verifyIdentityJwt,
  type CailIdentity,
  type IdentityVerifierConfig,
} from '@cuny-ai-lab/cail-identity';
import { z } from 'zod';

/**
 * cail-identity 5.0.0 replaced the synchronous `parseIdentityConfig` + per-call
 * jwks/options with an async loader that validates issuer, audience, and every
 * JWKS key once, returning a frozen snapshot. Snapshots are cached per
 * (jwks, issuer) so a request never re-imports keys.
 */
type IdentityConfigErrorReason = string;
const verifierCache = new Map<string, IdentityVerifierConfig>();

export {
  verifyIdentityJwt,
  CAIL_CANONICAL_ISSUER,
  CAIL_GATEWAY_AUDIENCE,
};
export type { CailIdentity, IdentityConfigErrorReason };

export const CAIL_IDENTITY_HEADER = 'X-CAIL-Identity-JWT';
export const CAIL_APP_SLUG = 'agent-studio';
export const CAIL_IDENTITY_AUDIENCE = 'cail:agent-studio';

export interface CailIdentityEnv {
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_REQUIRE_IDENTITY?: string;
}

const identityConfigStringSchema = z.string();
export const identityRequireFlagSchema = z.enum(['true', 'false']).optional();

function readIdentityConfigString(value: string | undefined): string | undefined {
  return identityConfigStringSchema.safeParse(value).data;
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

const identityConfigErrorSchema = z.object({ configError: z.string() }).strict();
type IdentityConfigValue =
  | CailIdentityConfigError
  | { ok: true; config: IdentityVerifierConfig }
  | CailIdentity
  | VerifiedCailIdentity
  | null;
type IdentityLoaderOptions = { now?: number };

export function isCailIdentityConfigError(value: IdentityConfigValue): value is CailIdentityConfigError {
  return identityConfigErrorSchema.safeParse(value).success;
}

const encoder = new TextEncoder();

/**
 * Load the verification config via the shared parseIdentityConfig primitive.
 *
 * Returns `null` — identity feature OFF — only when NOTHING is configured and
 * enforcement is off (anonymous dev/preview environments). Any partial or
 * malformed configuration, or enforcement without configuration, is a config
 * error: the operator intended identity to work and it cannot.
 */
async function loadIdentityConfig(
  env: CailIdentityEnv,
  now?: number,
): Promise<{ ok: true; config: IdentityVerifierConfig } | CailIdentityConfigError | null> {
  const jwks = readIdentityConfigString(env.CAIL_IDENTITY_JWKS);
  const issuer = readIdentityConfigString(env.CAIL_IDENTITY_ISSUER);
  const requireIdentityResult = identityRequireFlagSchema.safeParse(env.CAIL_REQUIRE_IDENTITY);
  if (env.CAIL_IDENTITY_JWKS !== undefined && jwks === undefined) return { configError: 'jwks_malformed' };
  if (env.CAIL_IDENTITY_ISSUER !== undefined && issuer === undefined) return { configError: 'issuer_unsupported' };
  if (!requireIdentityResult.success) return { configError: 'required_flag_invalid' };
  const requireIdentity = requireIdentityResult.data;
  const jwksConfigured = Boolean(jwks?.trim());
  const issuerConfigured = Boolean(issuer);
  if (!jwksConfigured && !issuerConfigured && requireIdentity !== 'true') return null;
  // A pinned clock (tests, replay analysis) must never be served from — or
  // written to — the shared snapshot cache.
  const cacheKey = `${issuer ?? ''}\u0000${jwks ?? ''}`;
  if (now === undefined) {
    const cached = verifierCache.get(cacheKey);
    if (cached) return { ok: true, config: cached };
  }
  const loaderOptions: IdentityLoaderOptions = {};
  if (now !== undefined) loaderOptions.now = now;
  const loaded = await loadIdentityVerifierConfig({
    jwks,
    issuer,
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
    ...loaderOptions,
  });
  if (!loaded.ok) return { configError: loaded.reason };
  if (now === undefined) verifierCache.set(cacheKey, loaded.config);
  return { ok: true, config: loaded.config };
}

/**
 * Verify the application-audience identity token from an HTTP request.
 */
async function verifyCailIdentityToken(
  token: string | null | undefined,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | CailIdentityConfigError | null> {
  // Configuration is classified BEFORE the absent-token check: a JWKS the
  // verifier cannot load must surface as a config error (503) even for an
  // anonymous request, or enforcement turns a misconfiguration into a
  // sign-in loop and non-enforcement silently serves anonymous traffic.
  // 5.0.0 moved the clock from the verify call into the loaded snapshot, so a
  // pinned `now` has to be threaded through the loader.
  const config = await loadIdentityConfig(env, now);
  if (isCailIdentityConfigError(config)) return config;
  if (!token) return null;
  if (config === null) return null;
  return verifyIdentityJwt(token, config.config);
}

/**
 * Derive the stable session id from a CAIL subject: SHA-256 over `cail:`+subject,
 * first 16 bytes as hex. This is the single source of truth — session.ts's
 * middleware imports it to key per-user data, and gateway credential binding uses
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
 * and the verified identity, or null when the request is anonymous / the token fails.
 */
export async function getCailIdentityFromRequest(
  request: Request,
  env: CailIdentityEnv,
  now?: number,
): Promise<VerifiedCailIdentity | CailIdentityConfigError | null> {
  const token = request.headers.get(CAIL_IDENTITY_HEADER);
  // Always classify verifier configuration, even for an anonymous request.
  // A malformed/partial JWKS is an operator error (503), not an anonymous
  // request (or a token-invalid 401); the verifier performs the absent-token
  // check only after loading the configuration.
  const identity = await verifyCailIdentityToken(token, env, now);
  if (isCailIdentityConfigError(identity)) return identity;
  if (!token || !identity) return null;
  return { token, identity };
}

/**
 * True when the worker must reject anonymous requests to model/spend paths
 * (401). If the flag is on but the configured JWKS cannot verify the request,
 * those paths close rather than opening through misconfiguration.
 */
export function cailIdentityRequired(env: CailIdentityEnv): boolean {
  return readIdentityConfigString(env.CAIL_REQUIRE_IDENTITY) === 'true';
}

/**
 * Typed 503 for an identity verification config the worker could not load.
 * Deliberately distinct from cailAuthRequiredResponse's 401: a bad token is
 * the caller's problem, an unloadable config is ours.
 */
export function cailIdentityMisconfiguredResponse(): Response {
  return new Response(
    serializeCailAuthError(createCailAuthError(
      'identity_verification_misconfigured',
      "Agent Studio isn't set up correctly right now. Email ailab@gc.cuny.edu.",
    )),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

export function cailAuthRequiredResponse(
  loginPath = '/agent-studio',
  status = 401,
  message = 'Sign in to continue.',
): Response {
  return new Response(
    serializeCailAuthError(createCailAuthError('authentication_required', message, loginPath)),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="CAIL"',
        'Cache-Control': 'no-store',
      },
    },
  );
}


/**
 * Load the verifier config for keyring gateway legs (aud "cail:gateway").
 * Same issuer/JWKS discipline as the app-audience config.
 */
async function loadGatewayLegConfig(
  env: CailIdentityEnv,
  now?: number,
): Promise<{ ok: true; config: IdentityVerifierConfig } | CailIdentityConfigError> {
  const jwks = readIdentityConfigString(env.CAIL_IDENTITY_JWKS);
  const issuer = readIdentityConfigString(env.CAIL_IDENTITY_ISSUER);
  if (env.CAIL_IDENTITY_JWKS !== undefined && jwks === undefined) return { configError: 'jwks_malformed' };
  if (env.CAIL_IDENTITY_ISSUER !== undefined && issuer === undefined) return { configError: 'issuer_unsupported' };
  if (!identityRequireFlagSchema.safeParse(env.CAIL_REQUIRE_IDENTITY).success) {
    return { configError: 'required_flag_invalid' };
  }
  const cacheKey = `gateway-leg\u0000${issuer ?? ''}\u0000${jwks ?? ''}`;
  if (now === undefined) {
    const cached = verifierCache.get(cacheKey);
    if (cached) return { ok: true, config: cached };
  }
  const loaderOptions: IdentityLoaderOptions = {};
  if (now !== undefined) loaderOptions.now = now;
  const loaded = await loadIdentityVerifierConfig({
    jwks,
    issuer,
    expectedAudience: CAIL_GATEWAY_AUDIENCE,
    ...loaderOptions,
  });
  if (!loaded.ok) return { configError: loaded.reason };
  if (now === undefined) verifierCache.set(cacheKey, loaded.config);
  return { ok: true, config: loaded.config };
}

/**
 * Verify the gateway-audience credential installed into a WorkspaceAgent and
 * bind it to that Durable Object's session. The internal server-to-DO RPC
 * accepts only the gateway-scoped `cail:gateway` leg; HTTP identity validation
 * uses `cail:agent-studio`.
 */
export async function verifyGatewayCredentialForSession(
  token: string | null | undefined,
  expectedSessionId: string,
  env: CailIdentityEnv,
  now?: number,
): Promise<CailIdentity | CailIdentityConfigError | null> {
  const config = await loadGatewayLegConfig(env, now);
  if (isCailIdentityConfigError(config)) return config;
  if (!token) return null;
  const identity = await verifyIdentityJwt(token, config.config);
  if (!identity) return null;
  const derived = await sessionIdForSubject(identity.subject);
  if (derived !== expectedSessionId) return null;
  return identity;
}

/**
 * Resolve the keyring's gateway leg for an already verified request identity
 * (identity-keyring-v1): transport-parse the keyring, then fully verify the
 * gateway leg and require subject agreement with the verified app leg.
 *
 * Returns the verified gateway JWT string to forward, `null` when the leg is
 * absent, or `"invalid"` when a leg is present but malformed, unverifiable,
 * or names a different person — callers fail closed on that.
 */
export async function resolveKeyringGatewayJwt(
  request: Request,
  env: CailIdentityEnv,
  verifiedSubject: string,
): Promise<string | null | 'invalid'> {
  const keyring = readIdentityKeyring(request.headers);
  if (keyring === null) return 'invalid';
  if (keyring.gatewayJwt === undefined) return null;
  const config = await loadGatewayLegConfig(env);
  if (!('ok' in config)) return 'invalid';
  const identity = await verifyKeyringGatewayJwt(keyring, config.config, verifiedSubject);
  return identity === null ? 'invalid' : keyring.gatewayJwt;
}
