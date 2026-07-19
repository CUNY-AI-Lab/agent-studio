/**
 * Agent Studio's OpenAI-compatible CAIL model provider.
 *
 * The verified CAIL identity JWT is forwarded as an ordinary bearer token.
 * LiteLLM verifies it, binds the stable subject to policy and spend, and holds
 * every upstream provider credential.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createCailClient } from '@cuny-ai-lab/cail-client';
import type { LanguageModel } from 'ai';
import { CAIL_APP_SLUG } from './cail-identity';
import { outboundCorrelationHeaders, type CailCorrelation } from './logging';

/** Provider-neutral public alias owned by the LiteLLM model catalog. */
export const DEFAULT_CAIL_MODEL = 'cail/default';

export interface CailModelEnv {
  /** Exact public OpenAI-compatible base URL, including its final `/v1`. */
  CAIL_OPENAI_BASE_URL?: string;
  /** Optional curated public model override. */
  CAIL_MODEL?: string;
}

export function resolveCailModelName(env: CailModelEnv): string {
  return env.CAIL_MODEL || DEFAULT_CAIL_MODEL;
}

export interface CreateCailModelOptions {
  env: CailModelEnv;
  /** The caller's verified CAIL identity JWT, forwarded as a bearer token. */
  identityJwt: string;
  model?: string;
  correlation?: CailCorrelation;
}

export function createCailModel(options: CreateCailModelOptions): LanguageModel {
  const { env, identityJwt } = options;
  const baseUrl = env.CAIL_OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'CAIL_OPENAI_BASE_URL is not configured; cannot reach the CAIL model gateway.',
    );
  }
  if (!identityJwt) {
    throw new Error('Missing CAIL identity JWT; cannot authenticate the model call.');
  }

  const cail = createCailClient({
    baseUrl,
    app: CAIL_APP_SLUG,
    allowInsecureLoopback: true,
  });
  const provider = createOpenAICompatible({
    name: 'cail',
    baseURL: baseUrl,
    // The SDK requires no key when a custom fetch is present, but using a
    // visible placeholder makes accidental adapter removal fail closed.
    apiKey: 'replaced-by-cail-client',
    fetch: cail.openAIFetch(identityJwt) as typeof fetch,
    headers: options.correlation
      ? outboundCorrelationHeaders(options.correlation)
      : undefined,
    includeUsage: true,
  });

  return provider(options.model || resolveCailModelName(env));
}
