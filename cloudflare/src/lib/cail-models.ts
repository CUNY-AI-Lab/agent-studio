/**
 * CAIL model catalog client for Agent Studio.
 *
 * The user-facing model picker is fed by the CAIL model proxy's curated
 * catalog: `GET {CAIL_API_BASE}/v1/models` with the caller's identity JWT and the
 * agent-studio app header. The response is an OpenAI list; the proxy returns it
 * pre-sorted by `order`, so `data[0]` is the fleet default.
 *
 * Beyond the OpenAI-list basics, each entry carries CAIL policy + facts
 * (`tier`/`recommended`, `status`/`sunset`, `capabilities`, `context_length`,
 * `registry_url`). We validate tolerantly — only `id` is required, and enum-ish
 * fields are parsed as free strings so an unknown `tier`/`status` value the
 * fleet adds later never fails the whole list — then normalize downstream.
 *
 * When the proxy is unreachable (no base URL, anonymous, non-auth upstream
 * error, or a response that fails shape validation) we fall back to a
 * single-entry list of the configured default model, so the picker always has
 * something to show and chat never breaks. A proxy 401/403 for a
 * gateway-verified identity is config/secret drift and throws
 * ModelCatalogAuthError instead — masking it with a working-looking picker
 * would hide a broken deployment. A proxy 429 similarly throws
 * ModelCatalogQuotaError so an over-quota user never sees a working-looking
 * fallback. Only the proxy list is cached (globally, ~5 min); the catalog is
 * not per-user beyond auth, so one cache serves everyone.
 */

import { CailError, createCailClient } from '@cuny-ai-lab/cail-client';
import { z } from 'zod';
import { CAIL_APP_SLUG } from './cail-identity';
import { resolveCailModelName, type CailModelEnv } from './cail-model';

export type CailModelTier = 'recommended' | 'advanced';
export type CailModelStatus = 'active' | 'deprecated' | 'retiring';

export interface CailModelInfo {
  id: string;
  /** True for the catalog's recommended default. Exactly one when from proxy. */
  recommended: boolean;
  /** Disclosure boundary: recommended tier is shown by default, advanced hidden. */
  tier: CailModelTier;
  /** Lifecycle. 'retiring' surfaces a sunset note; 'deprecated' is hidden unless selected. */
  status: CailModelStatus;
  /** ISO date the model retires, when status is 'retiring'; otherwise null. */
  sunset: string | null;
  /** Facts: e.g. 'text-generation', 'vision', 'function-calling', 'long-context'. */
  capabilities: string[];
  /** Max context window in tokens, when known. */
  contextLength: number | null;
  /** Link to the public Model Registry entry, when known. */
  registryUrl: string | null;
  /** Human-friendly name from the catalog, when provided. */
  name: string | null;
  /** Short description from the catalog, when provided. */
  description: string | null;
}

export interface CailModelsResult {
  models: CailModelInfo[];
  source: 'proxy' | 'fallback';
}

export class ModelCatalogAuthError extends Error {}
export class ModelCatalogQuotaError extends Error {}

export interface FetchCailModelsOptions {
  env: CailModelEnv;
  /** The caller's verified X-CAIL-Identity-JWT, forwarded as the credential. */
  identityJwt: string | null;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// Tolerant entry schema: only `id` is required. Enum-ish fields are free
// strings so an unknown tier/status the fleet adds later doesn't reject the
// list — normalization below coerces to known values with sensible defaults.
const modelEntrySchema = z.object({
  id: z.string().min(1),
  object: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  task: z.string().optional(),
  recommended: z.boolean().optional(),
  tier: z.string().optional(),
  order: z.number().optional(),
  status: z.string().optional(),
  sunset: z.string().nullable().optional(),
  capabilities: z.array(z.string()).optional(),
  context_length: z.number().nullable().optional(),
  registry_url: z.string().nullable().optional(),
});

type ModelEntry = z.infer<typeof modelEntrySchema>;

const modelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(modelEntrySchema).min(1),
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

/**
 * Normalize a raw catalog entry into a CailModelInfo.
 *
 * tier precedence: an explicit valid `tier` wins; else `recommended: true`
 * (or being data[0]) means 'recommended'; else 'advanced'. status defaults to
 * 'active' when absent or unrecognized. `recommended` is true only for data[0]
 * (the fleet default), matching the proxy's pre-sorted, recommended-first list.
 */
function normalizeEntry(entry: ModelEntry, index: number): CailModelInfo {
  const isDefault = index === 0;

  const explicitTier: CailModelTier | null =
    entry.tier === 'recommended' || entry.tier === 'advanced' ? entry.tier : null;
  const tier: CailModelTier =
    explicitTier ?? (entry.recommended === true || isDefault ? 'recommended' : 'advanced');

  const status: CailModelStatus =
    entry.status === 'deprecated' || entry.status === 'retiring' || entry.status === 'active'
      ? entry.status
      : 'active';

  return {
    id: entry.id,
    recommended: isDefault,
    tier,
    status,
    sunset: entry.sunset ?? null,
    capabilities: entry.capabilities ?? [],
    contextLength: entry.context_length ?? null,
    registryUrl: entry.registry_url ?? null,
    name: entry.name ?? null,
    description: entry.description ?? null,
  };
}

function fallbackResult(env: CailModelEnv): CailModelsResult {
  return {
    models: [
      {
        id: resolveCailModelName(env),
        recommended: true,
        tier: 'recommended',
        status: 'active',
        sunset: null,
        capabilities: [],
        contextLength: null,
        registryUrl: null,
        name: null,
        description: null,
      },
    ],
    source: 'fallback',
  };
}

/**
 * Fetch the curated model catalog from the proxy, or fall back to the single
 * configured default. The shared CAIL client owns the retry and error contract.
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

  let response: Response;
  try {
    const cail = createCailClient({
      baseUrl: apiBase,
      app: CAIL_APP_SLUG,
      onAuthRequired: () => {},
      fetchImpl,
    });
    // Model discovery follows the OpenAI-compatible surface. The old root
    // `/models` route is intentionally retired by the gateway.
    response = await cail.call('/v1/models', { method: 'GET' }, { kind: 'jwt', token: identityJwt });
  } catch (error) {
    if (error instanceof CailError && (error.status === 401 || error.status === 403)) {
      throw new ModelCatalogAuthError(error.message);
    }
    if (error instanceof CailError && error.status === 429) {
      throw new ModelCatalogQuotaError(error.message);
    }
    return fallbackResult(env);
  }

  let parsed: z.infer<typeof modelListSchema>;
  try {
    parsed = modelListSchema.parse(await response.json());
  } catch {
    return fallbackResult(env);
  }

  // Convention: the proxy returns the catalog pre-sorted, recommended-first.
  const models: CailModelInfo[] = parsed.data.map((entry, index) => normalizeEntry(entry, index));

  proxyCache = { models, expiresAt: Date.now() + CACHE_TTL_MS };
  return { models, source: 'proxy' };
}
