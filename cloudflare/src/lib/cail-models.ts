/** Authenticated model discovery from LiteLLM's standard `GET /v1/models`. */

import { createCailClient } from '@cuny-ai-lab/cail-client';
import { z } from 'zod';
import { CAIL_APP_SLUG } from './cail-identity';
import type { CailModelEnv } from './cail-model';
import { outboundCorrelationHeaders, type CailCorrelation } from './logging';

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
  source: 'gateway';
}

export class ModelCatalogAuthError extends Error {}
export class ModelCatalogQuotaError extends Error {}
export class ModelCatalogUnavailableError extends Error {}

export interface FetchCailModelsOptions {
  env: CailModelEnv;
  identityJwt: string | null;
  fetchImpl?: typeof fetch;
  correlation?: CailCorrelation;
}

// LiteLLM requires only OpenAI's `id` and `object`. Optional display metadata
// can be added to catalog entries without becoming part of the auth contract.
const modelEntrySchema = z.object({
  id: z.string().min(1),
  object: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  tier: z.string().optional(),
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

function normalizeEntry(entry: ModelEntry, index: number): CailModelInfo {
  const isDefault = index === 0;
  const explicitTier: CailModelTier | null =
    entry.tier === 'recommended' || entry.tier === 'advanced' ? entry.tier : null;
  const status: CailModelStatus =
    entry.status === 'deprecated' || entry.status === 'retiring' || entry.status === 'active'
      ? entry.status
      : 'active';

  return {
    id: entry.id,
    recommended: isDefault,
    tier: explicitTier ?? (entry.recommended === true || isDefault ? 'recommended' : 'advanced'),
    status,
    sunset: entry.sunset ?? null,
    capabilities: entry.capabilities ?? [],
    contextLength: entry.context_length ?? null,
    registryUrl: entry.registry_url ?? null,
    name: entry.name ?? null,
    description: entry.description ?? null,
  };
}

async function standardErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as {
      error?: { message?: unknown };
    };
    if (typeof body.error?.message === 'string') return body.error.message;
  } catch {
    // Use the status fallback.
  }
  return `Model gateway returned HTTP ${response.status}.`;
}

export async function fetchCailModels(
  options: FetchCailModelsOptions,
): Promise<CailModelsResult> {
  const baseUrl = options.env.CAIL_OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new ModelCatalogUnavailableError(
      'CAIL_OPENAI_BASE_URL is not configured.',
    );
  }
  if (!options.identityJwt) {
    throw new ModelCatalogAuthError(
      'CAIL authentication is required to list models.',
    );
  }

  let response: Response;
  try {
    const cail = createCailClient({
      baseUrl,
      app: CAIL_APP_SLUG,
      fetchImpl: options.fetchImpl,
    });
    response = await cail.request(
      'models',
      {
        method: 'GET',
        headers: options.correlation
          ? outboundCorrelationHeaders(options.correlation)
          : undefined,
      },
      options.identityJwt,
    );
  } catch (error) {
    throw new ModelCatalogUnavailableError(
      error instanceof Error ? error.message : 'Model gateway is unavailable.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ModelCatalogAuthError(await standardErrorMessage(response));
  }
  if (response.status === 429) {
    throw new ModelCatalogQuotaError(await standardErrorMessage(response));
  }
  if (!response.ok) {
    throw new ModelCatalogUnavailableError(await standardErrorMessage(response));
  }

  let parsed: z.infer<typeof modelListSchema>;
  try {
    parsed = modelListSchema.parse(await response.json());
  } catch {
    throw new ModelCatalogUnavailableError(
      'Model gateway returned an invalid model list.',
    );
  }

  return {
    models: parsed.data.map((entry, index) => normalizeEntry(entry, index)),
    source: 'gateway',
  };
}
