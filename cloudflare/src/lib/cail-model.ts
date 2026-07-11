/**
 * CAIL model-proxy client for Agent Studio.
 *
 * Agent Studio never holds a provider API key. All model calls go through the
 * CAIL gateway's OpenAI-compatible chat endpoint
 * (`POST {CAIL_API_BASE}/v1/chat/completions`). The gateway attaches the real
 * upstream credentials, stamps per-user spend metadata, and translates
 * quota/auth failures into the CAIL error envelope (see
 * cail-gateway docs/INTEGRATION.md and model-proxy/README.md).
 *
 * Transport: the shared `@cuny-ai-lab/cail-client` owns the wire discipline.
 * Its `chatFetch()` adapter plugs into the Vercel AI SDK's
 * `createOpenAICompatible({ fetch })`: it strips the dummy Authorization,
 * sends the caller's verified `X-CAIL-Identity-JWT` plus `X-CAIL-App`, and
 * keeps raw fetch semantics (non-2xx returned to the SDK, no client retries)
 * with ONE carve-out: a gateway 429 `quota_exceeded` envelope THROWS the
 * parsed `CailError` so the SDK cannot retry-and-bury it — the workspace
 * agent surfaces that error's verbatim message to the chat user (see
 * lib/quota-error.ts).
 *
 * Credential: this is a browser tool behind the SSO gate, so we forward the
 * requesting user's verified identity JWT. No personal `sk-cail-…` key is
 * ever used by this tool.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createCailClient } from '@cuny-ai-lab/cail-client';
import type { LanguageModel } from 'ai';
import { CAIL_APP_SLUG } from './cail-identity';

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
   * cail-gateway docs/LAUNCH_CHECKLIST.md. No trailing slash.
   */
  CAIL_API_BASE?: string;
  /** Optional model override; defaults to DEFAULT_CAIL_MODEL. */
  CAIL_MODEL?: string;
}

export function resolveCailModelName(env: CailModelEnv): string {
  return env.CAIL_MODEL || DEFAULT_CAIL_MODEL;
}

export interface CreateCailModelOptions {
  env: CailModelEnv;
  /** The caller's verified X-CAIL-Identity-JWT, forwarded as the credential. */
  identityJwt: string;
  /** Optional per-call model override (falls back to env / default). */
  model?: string;
}

/**
 * Construct a LanguageModel that routes every request through the CAIL
 * gateway's `/v1/chat/completions` with the caller's identity JWT and the
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

  // The client trims trailing slashes from its baseUrl; mirror that here so
  // the SDK-derived URL matches chatFetch()'s single served target exactly:
  // `${base}/v1` + `/chat/completions`.
  const base = apiBase.replace(/\/+$/, '');
  const cail = createCailClient({
    baseUrl: base,
    app: CAIL_APP_SLUG,
  });

  const provider = createOpenAICompatible({
    name: 'cail',
    baseURL: `${base}/v1`,
    // Dummy key: the adapter strips Authorization and sends the identity JWT.
    apiKey: 'cail-proxy',
    // chatFetch accepts string | URL inputs; the AI SDK always calls with a
    // string URL, and the adapter throws loudly on anything unexpected.
    fetch: cail.chatFetch({ kind: 'jwt', token: identityJwt }) as typeof fetch,
  });

  return provider(options.model || resolveCailModelName(env));
}
