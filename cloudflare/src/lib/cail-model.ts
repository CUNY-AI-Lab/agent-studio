/**
 * CAIL model-proxy client for Agent Studio.
 *
 * Agent Studio never holds a provider API key. All model calls go through the
 * CAIL gateway's OpenAI-compatible chat endpoint
 * (`POST {CAIL_API_BASE}/v1/chat/completions`). The gateway attaches the real
 * upstream credentials, stamps per-user spend metadata, and translates
 * quota/auth failures into the CAIL error envelope (see
 * the institutional CAIL tool integration contract).
 *
 * Transport: the Vercel AI SDK's OpenAI-compatible provider talks directly to
 * the required GATEWAY service binding. The verified gateway JWT is the
 * provider API key, so exactly one `Authorization: Bearer …` credential
 * reaches the wire. A final fetch sanitizer keeps only ordinary
 * JSON/content-negotiation headers, then stamps the server-owned credential
 * and app header. Ambient credentials and redirects never cross the boundary.
 *
 * Credential: this is a browser tool behind the SSO gate, so we forward the
 * requesting user's verified gateway-audience JWT. No personal `sk-cail-…`
 * key is ever used by this tool.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { CAIL_APP_SLUG } from './cail-identity';
import { isAllowedCailModelId } from './workspace-validation';

/**
 * Default model slug. CAIL policy (2026-07-04) is Workers AI catalog only —
 * `@cf/...` ids resolved by the AI Gateway. GLM-5.2 is the catalog's flagship
 * agentic model (262k context, function calling, parallel tool calls), which
 * fits this tool's multi-step tool-loop + codemode workload. Ops can override
 * via CAIL_MODEL — e.g. `@cf/openai/gpt-oss-120b` as a cheaper general model.
 */
export const DEFAULT_CAIL_MODEL = '@cf/zai-org/glm-5.2';

export interface CailModelEnv {
  /**
   * Public base URL of the CAIL model proxy (serves /v1/… and /keys). Set at
   * launch against the institutional Cloudflare account — see
   * the authorized deployment configuration. Trailing slashes are normalized.
   */
  CAIL_API_BASE?: string;
  /** Optional model override; defaults to DEFAULT_CAIL_MODEL. */
  CAIL_MODEL?: string;
  /** Service binding to CAIL Model API. Required for deployed model calls. */
  GATEWAY?: Fetcher;
}

export function resolveCailModelName(env: CailModelEnv): string {
  return isAllowedCailModelId(env.CAIL_MODEL) ? env.CAIL_MODEL : DEFAULT_CAIL_MODEL;
}

export interface CreateCailModelOptions {
  env: CailModelEnv;
  /** The caller's verified gateway JWT, forwarded as the Bearer credential. */
  identityJwt: string;
  /** Optional per-call model override (falls back to env / default). */
  model?: string;
}

function containsForbiddenControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function canonicalCailApiBase(apiBase: string): string {
  if (apiBase.trim() !== apiBase || containsForbiddenControl(apiBase) || /[\s\\]/.test(apiBase)) {
    throw new Error('CAIL_API_BASE must be a trimmed absolute HTTPS URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error('CAIL_API_BASE must be a trimmed absolute HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || apiBase.includes('?')
    || apiBase.includes('#')
  ) {
    throw new Error(
      'CAIL_API_BASE must use HTTPS and cannot contain credentials, a query, or a fragment.',
    );
  }

  return apiBase.replace(/\/+$/, '');
}

/**
 * Construct a LanguageModel that routes every request through the CAIL
 * gateway's `/v1/chat/completions` with the caller's gateway JWT and the
 * agent-studio app header. Throws if CAIL_API_BASE or the identity JWT is
 * missing — the tool has no other path to model access, so this fails loud
 * rather than silently.
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
  if (options.model !== undefined && !isAllowedCailModelId(options.model)) {
    throw new Error('Model id is outside the Cloudflare Workers AI catalog namespace.');
  }

  // Trim all trailing slashes once so the provider's `/chat/completions`
  // suffix resolves to the one canonical gateway endpoint.
  const canonicalBase = canonicalCailApiBase(apiBase);
  const gateway = env.GATEWAY;
  if (!gateway?.fetch) {
    throw new Error('GATEWAY service binding is required for CAIL model calls.');
  }
  const headers = { 'X-CAIL-App': CAIL_APP_SLUG };
  const upstreamFetch: typeof globalThis.fetch = (input, init) => gateway.fetch(input, init);
  const safeFetch: typeof globalThis.fetch = (input, init) => upstreamFetch(input, {
    ...init,
    headers: (() => {
      const sdkHeaders = new Headers(init?.headers);
      const safeHeaders = new Headers();

      // OpenAI-compatible chat is always a JSON POST. Keep ordinary content
      // negotiation and the SDK's telemetry, but do not trust any caller
      // value for the body type or authority/routing headers.
      safeHeaders.set('content-type', 'application/json');
      for (const name of ['accept', 'user-agent']) {
        const value = sdkHeaders.get(name);
        if (value !== null) safeHeaders.set(name, value);
      }

      // The provider merges per-call headers after its static configuration;
      // stamp these last so options.headers cannot replace or add authority.
      safeHeaders.set('authorization', `Bearer ${identityJwt}`);
      safeHeaders.set('x-cail-app', CAIL_APP_SLUG);
      return safeHeaders;
    })(),
    // Model requests never need browser cookies or other ambient credentials.
    credentials: 'omit',
    // Service bindings support manual redirect handling, not `redirect:'error'`.
    // A gateway redirect is still an invalid model response; never follow it
    // with a bearer credential attached.
    redirect: 'manual',
  });

  const provider = createOpenAICompatible({
    name: 'cail',
    baseURL: `${canonicalBase}/v1`,
    // The gateway accepts a trusted Doorway JWT as a normal Bearer credential.
    apiKey: identityJwt,
    headers,
    fetch: safeFetch,
  });

  return provider(options.model ?? resolveCailModelName(env));
}
