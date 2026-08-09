/** Direct authenticated CAIL Gateway model catalog transport. */

import { z } from 'zod';
import { CAIL_APP_SLUG } from './cail-identity';
import { resolveCailModelName, type CailModelEnv } from './cail-model';
import { CAIL_MODEL_ID_PATTERN } from './workspace-validation';

export type CailModelTier = 'recommended' | 'advanced';
export type CailModelStatus = 'active' | 'deprecated' | 'retiring';

export interface CailModelInfo {
  id: string;
  recommended: boolean;
  tier: CailModelTier;
  status: CailModelStatus;
  sunset: string | null;
  capabilities: string[];
  contextLength: number | null;
  registryUrl: string | null;
  name: string | null;
  description: string | null;
}

export interface CailModelsResult {
  models: CailModelInfo[];
}

export class ModelCatalogAuthError extends Error {}
export class ModelCatalogQuotaError extends Error {}

export interface FetchCailModelsOptions {
  env: CailModelEnv;
  identityJwt: string | null;
  /** Injectable transport for unit tests; deployed code uses env.GATEWAY. */
  fetchImpl?: typeof fetch;
}

const modelEntrySchema = z.object({
  id: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  recommended: z.boolean().optional(),
  tier: z.string().optional(),
  status: z.string().optional(),
  sunset: z.string().nullable().optional(),
  capabilities: z.array(z.string()).optional(),
  context_length: z.number().nullable().optional(),
  registry_url: z.string().nullable().optional(),
});

const modelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(z.unknown()).min(1),
});

function canonicalBase(value: string): string {
  if (value.trim() !== value || /[\u0000-\u001f\u007f\\\s]/.test(value)) {
    throw new Error('CAIL_API_BASE must be a trimmed absolute HTTPS URL.');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CAIL_API_BASE must use HTTPS and cannot contain credentials, a query, or a fragment.');
  }
  return value.replace(/\/+$/, '');
}

function normalizeEntry(entry: z.infer<typeof modelEntrySchema>, index: number): CailModelInfo {
  const tier: CailModelTier = entry.tier === 'recommended' || entry.tier === 'advanced'
    ? entry.tier
    : entry.recommended === true || index === 0 ? 'recommended' : 'advanced';
  const status: CailModelStatus = entry.status === 'deprecated'
    || entry.status === 'retiring' || entry.status === 'active' ? entry.status : 'active';
  return {
    id: entry.id,
    recommended: index === 0,
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

export async function fetchCailModels(options: FetchCailModelsOptions): Promise<CailModelsResult> {
  const { env, identityJwt } = options;
  if (!identityJwt) throw new ModelCatalogAuthError('CAIL authentication is required to list models.');
  const apiBase = canonicalBase(env.CAIL_API_BASE ?? '');
  const fetchImpl = options.fetchImpl
    ?? (env.GATEWAY ? env.GATEWAY.fetch.bind(env.GATEWAY) as typeof fetch : null);
  if (!fetchImpl) throw new Error('GATEWAY service binding is required for model catalog calls.');

  const response = await fetchImpl(`${apiBase}/v1/models`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${identityJwt}`,
      'x-cail-app': CAIL_APP_SLUG,
    },
    credentials: 'omit',
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) {
    throw new ModelCatalogAuthError('Model catalog authentication failed.');
  }
  if (response.status === 429) {
    throw new ModelCatalogQuotaError('Model catalog quota exceeded.');
  }
  if (!response.ok) {
    throw new Error(`Model catalog request failed with status ${response.status}.`);
  }

  const parsed = modelListSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Model catalog response did not match the CAIL schema.');
  const entries = parsed.data.data
    .map((entry) => modelEntrySchema.safeParse(entry))
    .filter((result): result is { success: true; data: z.infer<typeof modelEntrySchema> } => result.success)
    .map((result) => result.data);
  if (entries.length === 0) throw new Error('Model catalog contains no in-policy models.');
  return { models: entries.map(normalizeEntry) };
}

export { resolveCailModelName };
