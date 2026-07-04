/**
 * Server-side OAuth 2.0 client-credentials token broker for institutional
 * research APIs (OCLC WorldCat, Springshare LibGuides).
 *
 * The model/agent never sees credentials: web-fetch-guard asks this broker for
 * a bearer token and attaches it to allowlisted-host requests, mirroring the
 * Primo query-param injection. Tokens are cached in-memory per provider with an
 * expiry derived from the OAuth `expires_in` minus a safety margin. On a 401
 * from the downstream API the caller invalidates the cache and re-acquires once.
 *
 * Never log token or secret values.
 */

export interface TokenBrokerEnv {
  // OCLC WorldCat Metadata/Search API (client-credentials, HTTP Basic auth).
  OCLC_CLIENT_ID?: string;
  OCLC_CLIENT_SECRET?: string;
  OCLC_INSTITUTION_ID?: string;
  // Springshare LibGuides API (client-credentials, form-encoded).
  LIBGUIDES_BASE_URL?: string;
  LIBGUIDES_CLIENT_ID?: string;
  LIBGUIDES_CLIENT_SECRET?: string;
  LIBGUIDES_SITE_ID?: string;
}

export type TokenProvider = 'worldcat' | 'libguides';

/** Refresh this many ms before the reported expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;
/** Fallback lifetime when the token endpoint omits a usable `expires_in`. */
const DEFAULT_TOKEN_TTL_MS = 20 * 60_000;

interface CachedToken {
  token: string;
  /** Epoch ms after which the token is treated as expired. */
  expiresAt: number;
}

const tokenCache = new Map<TokenProvider, CachedToken>();

/** WorldCat token endpoint (fixed) and the scope WorldCat Search/Metadata expects. */
const OCLC_TOKEN_URL = 'https://oauth.oclc.org/token';
const OCLC_SCOPE = 'WorldCatMetadataAPI';

function ttlFromExpiresIn(expiresIn: unknown): number {
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TOKEN_TTL_MS;
  return Math.max(seconds * 1000 - EXPIRY_SAFETY_MARGIN_MS, 0);
}

async function acquireWorldCatToken(
  env: TokenBrokerEnv,
  fetchImpl: typeof fetch
): Promise<CachedToken> {
  const credentials = btoa(`${env.OCLC_CLIENT_ID}:${env.OCLC_CLIENT_SECRET}`);
  const res = await fetchImpl(OCLC_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: `grant_type=client_credentials&scope=${OCLC_SCOPE}`,
  });
  if (!res.ok) {
    throw new Error(`worldcat token request failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('worldcat token response missing access_token');
  }
  return { token: data.access_token, expiresAt: Date.now() + ttlFromExpiresIn(data.expires_in) };
}

async function acquireLibGuidesToken(
  env: TokenBrokerEnv,
  fetchImpl: typeof fetch
): Promise<CachedToken> {
  const base = (env.LIBGUIDES_BASE_URL || '').replace(/\/+$/, '');
  const tokenUrl = `${base}/oauth/token`;
  const body = new URLSearchParams({
    client_id: env.LIBGUIDES_CLIENT_ID || '',
    client_secret: env.LIBGUIDES_CLIENT_SECRET || '',
    grant_type: 'client_credentials',
  });
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`libguides token request failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('libguides token response missing access_token');
  }
  return { token: data.access_token, expiresAt: Date.now() + ttlFromExpiresIn(data.expires_in) };
}

/** True when the provider has all credentials needed to acquire a token. */
export function isProviderConfigured(provider: TokenProvider, env: TokenBrokerEnv): boolean {
  if (provider === 'worldcat') {
    return Boolean(env.OCLC_CLIENT_ID && env.OCLC_CLIENT_SECRET);
  }
  return Boolean(env.LIBGUIDES_BASE_URL && env.LIBGUIDES_CLIENT_ID && env.LIBGUIDES_CLIENT_SECRET);
}

/** Drop any cached token for a provider (call after a downstream 401). */
export function invalidateToken(provider: TokenProvider): void {
  tokenCache.delete(provider);
}

/**
 * Return a valid bearer token for the provider, using the cache when fresh and
 * acquiring a new one otherwise. Returns null when the provider is unconfigured.
 */
export async function getAccessToken(
  provider: TokenProvider,
  env: TokenBrokerEnv,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!isProviderConfigured(provider, env)) return null;

  const cached = tokenCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const acquired =
    provider === 'worldcat'
      ? await acquireWorldCatToken(env, fetchImpl)
      : await acquireLibGuidesToken(env, fetchImpl);
  tokenCache.set(provider, acquired);
  return acquired.token;
}

/** Test-only: clear the whole cache between cases. */
export function __resetTokenCacheForTests(): void {
  tokenCache.clear();
}
