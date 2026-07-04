/**
 * Guard rails for the host-side web_fetch tool.
 *
 * The legacy runner routed all agent HTTP through an egress proxy that
 * blocked localhost, private ranges, and cloud metadata endpoints. On
 * Workers the sandbox has no direct network at all (globalOutbound: null),
 * but the host web_fetch tool fetches on the agent's behalf — so the same
 * destination policy applies here, including on every redirect hop.
 *
 * This module also attaches institutional API credentials server-side for
 * allowlisted hosts (currently Ex Libris Primo), so keys never enter model
 * context or sandbox code. Bearer tokens (WorldCat, LibGuides) are attached
 * per-hop only when the hop's host is the allowlisted API host — a redirect off
 * that host must not carry them.
 */

import {
  getAccessToken,
  invalidateToken,
  isProviderConfigured,
  type TokenBrokerEnv,
  type TokenProvider,
} from './api-token-broker';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.gce.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

function isBlockedIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true; // malformed — refuse
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === '::' || value === '::1') return true;
  // Unique-local fc00::/7, link-local fe80::/10, and IPv4-mapped forms.
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true;
  // IPv4-mapped literals (URL parsing may render them in hex form, e.g.
  // ::ffff:7f00:1 for 127.0.0.1) and all other IPv6 literals are blocked:
  // no legitimate research API is addressed by raw IP.
  return true;
}

/**
 * Throw unless the URL is plain public http(s). Applied to the initial URL
 * and to every redirect location.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`web_fetch: invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web_fetch: only http(s) URLs are allowed, got ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase();
  const blocked =
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (!hostname.includes('.') && !hostname.includes(':')) || // bare intranet names
    isBlockedIpv4(hostname) ||
    isBlockedIpv6(hostname);
  if (blocked) {
    throw new Error(
      `web_fetch: destination not allowed (${hostname}). Only public internet hosts are reachable.`
    );
  }
  return url;
}

export interface WebFetchCredentialEnv extends TokenBrokerEnv {
  /** Primo search API base, e.g. https://api-na.hosted.exlibrisgroup.com/primo/v1/search */
  PRIMO_API_BASE?: string;
  PRIMO_API_KEY?: string;
  PRIMO_VID?: string;
  PRIMO_SCOPE?: string;
}

/** OCLC WorldCat Metadata/Search API host (bearer-auth). */
const WORLDCAT_API_HOST = 'metadata.api.oclc.org';

/**
 * Resolve which bearer-token provider (if any) owns a given hop host. Only the
 * exact allowlisted host qualifies, and only when its credentials are
 * configured — so a redirect to any other host attaches no Authorization.
 */
export function bearerProviderForHost(
  hostname: string,
  env: WebFetchCredentialEnv
): TokenProvider | null {
  const host = hostname.toLowerCase();
  if (host === WORLDCAT_API_HOST && isProviderConfigured('worldcat', env)) {
    return 'worldcat';
  }
  if (isProviderConfigured('libguides', env) && env.LIBGUIDES_BASE_URL) {
    let libguidesHost: string | null = null;
    try {
      libguidesHost = new URL(env.LIBGUIDES_BASE_URL).hostname.toLowerCase();
    } catch {
      libguidesHost = null;
    }
    if (libguidesHost && host === libguidesHost) return 'libguides';
  }
  return null;
}

/**
 * Attach configured institutional API credentials when the destination
 * matches an allowlisted host. Injection happens after the public-URL check
 * and only fills parameters the request does not already carry (except the
 * API key, which is always server-owned). Mutates and returns the URL.
 */
export function applyConfiguredApiParams(url: URL, env: WebFetchCredentialEnv): URL {
  if (env.PRIMO_API_BASE && env.PRIMO_API_KEY) {
    let primoHost: string | null = null;
    try {
      primoHost = new URL(env.PRIMO_API_BASE).hostname.toLowerCase();
    } catch {
      primoHost = null;
    }
    if (primoHost && url.hostname.toLowerCase() === primoHost) {
      url.searchParams.set('apikey', env.PRIMO_API_KEY);
      if (env.PRIMO_VID && !url.searchParams.has('vid')) {
        url.searchParams.set('vid', env.PRIMO_VID);
      }
      if (env.PRIMO_SCOPE && !url.searchParams.has('scope')) {
        url.searchParams.set('scope', env.PRIMO_SCOPE);
      }
    }
  }

  // LibGuides requests require the site_id query param; inject it server-side
  // for the LibGuides API host so the agent never needs to carry it. The bearer
  // token itself is attached per-hop in fetchFollowingRedirects.
  if (env.LIBGUIDES_SITE_ID && bearerProviderForHost(url.hostname, env) === 'libguides') {
    if (!url.searchParams.has('site_id')) {
      url.searchParams.set('site_id', env.LIBGUIDES_SITE_ID);
    }
  }
  return url;
}

const MAX_REDIRECTS = 5;

export interface GuardedFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
}

/**
 * Follow redirects with the destination policy enforced on the initial URL and
 * every hop. Institutional query params (Primo) are injected only on the
 * initial URL; bearer tokens (WorldCat/LibGuides) are attached per-hop and only
 * when the hop's host is the allowlisted API host, so a redirect off that host
 * carries neither the params nor the Authorization header.
 *
 * The bearer cache is consulted per call; the caller invalidates it before a
 * 401 retry so the next call re-acquires a fresh token.
 */
async function fetchFollowingRedirects(
  startUrl: URL,
  env: WebFetchCredentialEnv,
  fetchImpl: typeof fetch
): Promise<{ response: Response; provider: TokenProvider | null }> {
  let url = startUrl;
  let response: Response | null = null;
  // The provider whose bearer token the FINAL response carried, so the caller
  // knows which cache to invalidate on a 401.
  let finalProvider: TokenProvider | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {
      'User-Agent': 'agent-studio/0.1 (CUNY AI Lab research assistant)',
    };
    const provider = bearerProviderForHost(url.hostname, env);
    if (provider) {
      const token = await getAccessToken(provider, env, fetchImpl);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers.Accept = 'application/json';
      }
    }
    finalProvider = provider;

    response = await fetchImpl(url.toString(), { redirect: 'manual', headers });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw new Error('web_fetch: too many redirects');
      }
      url = assertPublicHttpUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response) {
    throw new Error('web_fetch: no response');
  }
  return { response, provider: finalProvider };
}

/**
 * Fetch with the destination policy enforced on every hop and institutional
 * credentials attached server-side. On a 401 from a bearer-authed API host the
 * cached token is invalidated and the whole fetch is retried once.
 */
export async function guardedWebFetch(
  rawUrl: string,
  format: 'text' | 'json',
  env: WebFetchCredentialEnv,
  fetchImpl: typeof fetch = fetch
): Promise<GuardedFetchResult> {
  const startUrl = applyConfiguredApiParams(assertPublicHttpUrl(rawUrl), env);

  let { response, provider } = await fetchFollowingRedirects(startUrl, env, fetchImpl);
  if (response.status === 401 && provider) {
    invalidateToken(provider);
    ({ response } = await fetchFollowingRedirects(startUrl, env, fetchImpl));
  }

  const contentType = response.headers.get('content-type') || '';
  const body = format === 'json' ? JSON.stringify(await response.json()) : await response.text();
  return {
    ok: response.ok,
    status: response.status,
    contentType,
    body,
  };
}
