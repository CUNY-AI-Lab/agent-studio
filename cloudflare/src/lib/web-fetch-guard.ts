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
 *
 * SSRF / DNS-rebind note (AS-1-1): the literal-IP/suffix blocklist below is
 * by-NAME only. A PUBLIC hostname whose DNS record resolves to 127.0.0.1 /
 * 169.254.169.254 / a private range passes the name check on every hop. A true
 * resolve-then-check is NOT possible in a Cloudflare Workers isolate — there is
 * no in-isolate DNS API (no node:dns); `fetch` resolves the name internally,
 * so we cannot see or pin the resolved IP before the connection is made.
 *
 * The deployment's real anti-rebind control is the OPTIONAL destination
 * allowlist (CAIL_WEBFETCH_ALLOWLIST): when set, the initial URL and every
 * redirect hop must match an allowlisted host or the fetch is blocked, so a
 * public name that rebinds to a private IP is refused regardless of what it
 * resolves to (its NAME isn't on the list). When the env is UNSET, behavior is
 * unchanged (name-blocklist only) so the open research web still works.
 *
 * Residual baseline when the allowlist is unset: the name blocklist (correct
 * for literal private/metadata/loopback targets) plus Cloudflare egress
 * properties — a Workers isolate cannot reach its own loopback and has no
 * Workers IMDS/metadata endpoint — so the classic 169.254.169.254 credential
 * exfil path is not reachable even if a name rebinds to it.
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

/** Env carrying the optional destination allowlist (anti-rebind containment). */
export interface WebFetchAllowlistEnv {
  /**
   * Comma-separated host patterns. When set, web_fetch (and every redirect hop)
   * must match one of these hosts or be blocked. Each pattern is a hostname
   * ("api.openalex.org") for an exact case-insensitive match, or a
   * leading-dot suffix (".oclc.org") that matches that host and any subdomain
   * of it. Unset => open-web behavior (name blocklist only).
   */
  CAIL_WEBFETCH_ALLOWLIST?: string;
}

/**
 * Parse and normalize the allowlist once. Returns null when unset/empty (=>
 * open-web mode). Each entry is lowercased and trimmed; a leading-dot entry is
 * kept as a suffix rule, everything else is an exact-host rule.
 */
export function parseWebFetchAllowlist(
  raw: string | undefined
): { exact: Set<string>; suffixes: string[] } | null {
  if (!raw) return null;
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('.')) {
      // ".oclc.org" matches "oclc.org" itself and any subdomain of it.
      suffixes.push(entry);
    } else {
      exact.add(entry);
    }
  }
  if (exact.size === 0 && suffixes.length === 0) return null;
  return { exact, suffixes };
}

/** True when `hostname` matches the parsed allowlist (exact or dot-suffix). */
export function hostAllowlisted(
  hostname: string,
  allowlist: { exact: Set<string>; suffixes: string[] }
): boolean {
  const host = hostname.toLowerCase();
  if (allowlist.exact.has(host)) return true;
  for (const suffix of allowlist.suffixes) {
    // ".oclc.org" matches "api.oclc.org" (endsWith) and "oclc.org" (bare).
    if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
  }
  return false;
}

/**
 * Throw unless the URL is plain public http(s). Applied to the initial URL
 * and to every redirect location. When an allowlist is supplied the host must
 * additionally be on it — this is the deployment's anti-rebind control (a
 * public name that resolves into private space is refused because its NAME is
 * not allowlisted; see the module header for why in-isolate IP checks are
 * impossible).
 */
export function assertPublicHttpUrl(
  rawUrl: string,
  allowlist?: { exact: Set<string>; suffixes: string[] } | null
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`web_fetch: invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web_fetch: only http(s) URLs are allowed, got ${url.protocol}`);
  }
  // Strip a single trailing dot (the FQDN root label): the WHATWG parser keeps
  // it on DNS names, so `localhost.` / `foo.internal.` would otherwise slip the
  // name blocklist below while still resolving to the same host. (IPv4 literals
  // already have it stripped by the parser, so this is a no-op for them.)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
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
  if (allowlist && !hostAllowlisted(hostname, allowlist)) {
    throw new Error(
      `web_fetch: destination not on the configured allowlist (${hostname}).`
    );
  }
  return url;
}

export interface WebFetchCredentialEnv extends TokenBrokerEnv, WebFetchAllowlistEnv {
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
  fetchImpl: typeof fetch,
  allowlist: { exact: Set<string>; suffixes: string[] } | null
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
      url = assertPublicHttpUrl(new URL(location, url).toString(), allowlist);
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
  const allowlist = parseWebFetchAllowlist(env.CAIL_WEBFETCH_ALLOWLIST);
  const startUrl = applyConfiguredApiParams(assertPublicHttpUrl(rawUrl, allowlist), env);

  let { response, provider } = await fetchFollowingRedirects(startUrl, env, fetchImpl, allowlist);
  if (response.status === 401 && provider) {
    invalidateToken(provider);
    ({ response } = await fetchFollowingRedirects(startUrl, env, fetchImpl, allowlist));
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
