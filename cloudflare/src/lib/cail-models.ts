/**
 * CAIL model catalog client for Agent Studio.
 *
 * The user-facing model picker is fed by the CAIL model proxy's curated
 * catalog: `GET {CAIL_API_BASE}/models` with the caller's identity JWT and the
 * agent-studio app header. The response is an OpenAI list; the proxy returns it
 * ordered, with the FIRST entry being the recommended default.
 *
 * When the proxy is unreachable (no base URL, anonymous, upstream error, or a
 * response that fails shape validation) we fall back to a single-entry list of
 * the configured default model, so the picker always has something to show and
 * chat never breaks. Only the proxy list is cached (globally, ~5 min); the
 * catalog is not per-user beyond auth, so one cache serves everyone.
 */

import { z } from 'zod';
import { CAIL_APP_SLUG, CAIL_IDENTITY_HEADER } from './cail-identity';
import { resolveCailModelName, type CailModelEnv } from './cail-model';

export interface CailModelInfo {
  id: string;
  /** True for the catalog's recommended default. Exactly one when from proxy. */
  recommended: boolean;
}

export interface CailModelsResult {
  models: CailModelInfo[];
  source: 'proxy' | 'fallback';
}

export interface FetchCailModelsOptions {
  env: CailModelEnv;
  /** The caller's verified X-CAIL-Identity-JWT, forwarded as the credential. */
  identityJwt: string | null;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const modelListSchema = z.object({
  object: z.literal('list'),
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        object: z.string().optional(),
      })
    )
    .min(1),
});

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ProxyCacheEntry {
  models: CailModelInfo[];
  expiresAt: number;
}

// Module-global cache of the proxy catalog. The catalog is the same for every
// authenticated user, so we key nothing per-subject. Fallbacks are never cached.
let proxyCache: ProxyCacheEntry | null = null;

/** Reset the in-memory proxy cache. Test-only hook. */
export function resetCailModelsCache(): void {
  proxyCache = null;
}

function fallbackResult(env: CailModelEnv): CailModelsResult {
  return {
    models: [{ id: resolveCailModelName(env), recommended: true }],
    source: 'fallback',
  };
}

async function requestModels(
  apiBase: string,
  identityJwt: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(`${apiBase.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers: {
      [CAIL_IDENTITY_HEADER]: identityJwt,
      'X-CAIL-App': CAIL_APP_SLUG,
    },
  });
}

/**
 * Fetch the curated model catalog from the proxy, or fall back to the single
 * configured default. Retries once on a network error or 5xx; never retries a
 * 4xx (auth/quota — retrying won't help).
 */
export async function fetchCailModels(options: FetchCailModelsOptions): Promise<CailModelsResult> {
  const { env, identityJwt } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = env.CAIL_API_BASE;

  if (!apiBase || !identityJwt) {
    return fallbackResult(env);
  }

  if (proxyCache && proxyCache.expiresAt > Date.now()) {
    return { models: proxyCache.models, source: 'proxy' };
  }

  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await requestModels(apiBase, identityJwt, fetchImpl);
    } catch {
      response = null; // network error — eligible for one retry
    }
    if (response && response.status >= 400 && response.status < 500) {
      return fallbackResult(env); // do not retry 4xx
    }
    if (response && response.ok) {
      break;
    }
    // network error or 5xx: retry once, then give up
  }

  if (!response || !response.ok) {
    return fallbackResult(env);
  }

  let parsed: z.infer<typeof modelListSchema>;
  try {
    parsed = modelListSchema.parse(await response.json());
  } catch {
    return fallbackResult(env);
  }

  // Convention: the proxy returns the catalog ordered, recommended-first.
  const models: CailModelInfo[] = parsed.data.map((entry, index) => ({
    id: entry.id,
    recommended: index === 0,
  }));

  proxyCache = { models, expiresAt: Date.now() + CACHE_TTL_MS };
  return { models, source: 'proxy' };
}
