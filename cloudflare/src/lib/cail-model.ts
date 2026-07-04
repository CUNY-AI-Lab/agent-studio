/**
 * CAIL model-proxy client for Agent Studio.
 *
 * Agent Studio never holds a provider API key. All model calls go through the
 * CAIL model proxy at `{CAIL_API_BASE}/v1/...` using Cloudflare AI Gateway's
 * OpenAI-compatible path (`/v1/compat/chat/completions`). The proxy attaches
 * the real gateway credentials, stamps per-user spend metadata, and translates
 * quota/auth failures into the CAIL error envelope (see
 * cail-gateway docs/INTEGRATION.md and model-proxy/README.md).
 *
 * Credential: this is a browser tool behind the SSO gate, so we forward the
 * requesting user's verified `X-CAIL-Identity-JWT`. `X-CAIL-App` attributes
 * spend to Agent Studio. No `Authorization: Bearer` is set — that slot is
 * reserved for personal `sk-cail-…` keys, which this tool does not use.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { CAIL_APP_SLUG, CAIL_IDENTITY_HEADER } from './cail-identity';

/**
 * Default model slug. Kept configurable via CAIL_MODEL so ops can point it at
 * whatever the AI Gateway is routing (OpenAI/Anthropic/Google/Workers AI). The
 * value is a plain OpenAI-compatible model id; the proxy/gateway resolves it.
 */
export const DEFAULT_CAIL_MODEL = 'anthropic/claude-sonnet-4';

export interface CailModelEnv {
  /**
   * Public base URL of the CAIL model proxy (serves /v1/… and /keys). Set at
   * launch against the institutional Cloudflare account — see
   * cail-gateway docs/LAUNCH_CHECKLIST.md. No trailing slash.
   */
  CAIL_API_BASE?: string;
  /** Optional model override; defaults to DEFAULT_CAIL_MODEL. */
  CAIL_MODEL?: string;
}

export function resolveCailModelName(env: CailModelEnv): string {
  return env.CAIL_MODEL || DEFAULT_CAIL_MODEL;
}

/**
 * Build the OpenAI-compatible base URL for the AI Gateway compat surface
 * exposed by the proxy: `{CAIL_API_BASE}/v1/compat`. The provider appends
 * `/chat/completions`, yielding the contract path
 * `{CAIL_API_BASE}/v1/compat/chat/completions`.
 */
export function cailCompatBaseUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/v1/compat`;
}

export interface CreateCailModelOptions {
  env: CailModelEnv;
  /** The caller's verified X-CAIL-Identity-JWT, forwarded as the credential. */
  identityJwt: string;
  /** Optional per-call model override (falls back to env / default). */
  model?: string;
}

/**
 * Construct a LanguageModel that routes every request through the CAIL model
 * proxy with the caller's identity JWT and the agent-studio app header.
 * Throws if CAIL_API_BASE or the identity JWT is missing — the tool has no
 * other path to model access, so this fails loud rather than silently.
 */
export function createCailModel(options: CreateCailModelOptions): LanguageModel {
  const { env, identityJwt } = options;
  const apiBase = env.CAIL_API_BASE;
  if (!apiBase) {
    throw new Error('CAIL_API_BASE is not configured; cannot reach the CAIL model proxy.');
  }
  if (!identityJwt) {
    throw new Error('Missing CAIL identity JWT; cannot authenticate the model call.');
  }

  const provider = createOpenAICompatible({
    name: 'cail',
    baseURL: cailCompatBaseUrl(apiBase),
    // No apiKey: we forward the SSO identity JWT, not a Bearer provider key.
    headers: {
      [CAIL_IDENTITY_HEADER]: identityJwt,
      'X-CAIL-App': CAIL_APP_SLUG,
    },
  });

  return provider(options.model || resolveCailModelName(env));
}
