/** Direct authenticated CAIL Gateway model catalog transport. */

import { z } from 'zod';
import { CAIL_APP_SLUG } from './cail-identity';
import { resolveCailModelName, type CailModelEnv } from './cail-model';
import { CAIL_MODEL_ID_PATTERN } from './workspace-validation';

export type CailModelTier = 'recommended' | 'advanced';
export type CailModelStatus = 'active' | 'deprecated' | 'retiring';

export const FUNCTION_CALLING_CAPABILITY = 'function-calling';

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
export class ModelCatalogDefaultError extends Error {}
export class ModelCatalogCapabilityError extends Error {}

export interface FetchCailModelsOptions {
  env: CailModelEnv;
  identityJwt: string | null;
  /** Injectable transport for unit tests; deployed code uses env.GATEWAY. */
  fetchImpl?: typeof fetch;
}

export function supportsFunctionCalling(model: Pick<CailModelInfo, 'capabilities'>): boolean {
  return model.capabilities.includes(FUNCTION_CALLING_CAPABILITY);
}

export function requireFunctionCallingModel(
  models: readonly CailModelInfo[],
  modelId: string,
): CailModelInfo {
  const model = models.find((entry) => entry.id === modelId);
  if (!model || !supportsFunctionCalling(model)) {
    throw new ModelCatalogCapabilityError(
      'Agent Studio requires a function-capable model; choose one marked for tools.',
    );
  }
  return model;
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

const modelListEnvelopeSchema = z.object({
  object: z.literal('list'),
  data: z.array(z.unknown()),
});

const supportedModelIdSchema = z.object({
  id: z.string().regex(CAIL_MODEL_ID_PATTERN).max(200),
});

function canonicalBase(value: string): string {
  const containsForbiddenControl = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (value.trim() !== value || containsForbiddenControl || /[\s\\]/.test(value)) {
    throw new Error('CAIL_API_BASE must be a trimmed absolute HTTPS URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CAIL_API_BASE must be a trimmed absolute HTTPS URL.');
  }
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
  const gateway = env.GATEWAY;
  const fetchImpl = options.fetchImpl
    ?? (gateway ? (input: RequestInfo | URL, init?: RequestInit) => gateway.fetch(input, init) : null);
  if (!fetchImpl) throw new Error('GATEWAY service binding is required for model catalog calls.');

  const response = await fetchImpl(`${apiBase}/v1/models`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${identityJwt}`,
      'x-cail-app': CAIL_APP_SLUG,
    },
    credentials: 'omit',
    // Cloudflare service bindings reject `redirect:'error'`; manual handling
    // keeps redirect responses fail-closed without forwarding credentials.
    redirect: 'manual',
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

  const envelope = modelListEnvelopeSchema.safeParse(await response.json());
  if (!envelope.success) throw new Error('Model catalog response did not match the CAIL schema.');

  // The shared Gateway serves multiple products and may include OpenRouter
  // entries alongside Workers AI. Agent Studio's runtime and workspace model
  // contract are intentionally Workers AI-only, so discard unsupported
  // provider namespaces before validating individual supported entries. A
  // malformed @cf entry still fails closed rather than being hidden.
  const supportedEntries = envelope.data.data.filter(
    (entry) => supportedModelIdSchema.safeParse(entry).success,
  );
  const parsedEntries = z.array(modelEntrySchema).min(1).safeParse(supportedEntries);
  if (!parsedEntries.success) throw new Error('Model catalog response did not match the CAIL schema.');
  return { models: parsedEntries.data.map(normalizeEntry) };
}

export { resolveCailModelName };
