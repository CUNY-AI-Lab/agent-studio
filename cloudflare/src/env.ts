import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';
import { loadIdentityVerifierConfig } from '@cuny-ai-lab/cail-identity';
import { isValidBasePath, normalizeBasePath } from './lib/base-path';
import { CAIL_CANONICAL_ISSUER, CAIL_IDENTITY_AUDIENCE } from './lib/cail-identity';
import { isAllowedCailModelId } from './lib/workspace-validation';

/** Runtime bindings and settings used by the worker. */
export interface Env {
  ASSETS: Fetcher;
  /** Cloudflare version metadata used by the public readiness probe. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  LOADER: WorkerLoader;
  WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  MIGRATION_REGISTRY: DurableObjectNamespace<MigrationRegistry>;
  WORKSPACE_FILES: R2Bucket;
  /** Required by deployed model and model-catalog requests. */
  GATEWAY?: Fetcher;
  SESSION_SECRET: string;
  HEAVY_RATE_LIMIT?: RateLimit;
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_REQUIRE_IDENTITY?: string;
  CAIL_CANONICAL_ORIGIN?: string;
  CAIL_BASE_PATH?: string;
  GIT_AUTH_TOKEN?: string;
  GIT_AUTH_ALLOWED_HOSTS?: string;
  CAIL_WEBFETCH_ALLOWLIST?: string;
  PRIMO_API_BASE?: string;
  PRIMO_API_KEY?: string;
  PRIMO_VID?: string;
  PRIMO_SCOPE?: string;
  OCLC_CLIENT_ID?: string;
  OCLC_CLIENT_SECRET?: string;
  OCLC_INSTITUTION_ID?: string;
  LIBGUIDES_BASE_URL?: string;
  LIBGUIDES_CLIENT_ID?: string;
  LIBGUIDES_CLIENT_SECRET?: string;
  LIBGUIDES_SITE_ID?: string;
}

export const MIN_REQUIRED_SESSION_SECRET_LENGTH = 32;

// The verifier loader caches imported keys by its complete input. Keeping one
// small local cache avoids re-importing the same JWKS on every health request.
let identityConfigValidationCache: {
  key: string;
  result: ReturnType<typeof loadIdentityVerifierConfig>;
} | null = null;

function loadSharedIdentityConfig(jwks: string | undefined, issuer: string | undefined) {
  const cacheKey = `${issuer ?? ''}\u0000${jwks ?? ''}`;
  if (identityConfigValidationCache?.key === cacheKey) {
    return identityConfigValidationCache.result;
  }
  const result = loadIdentityVerifierConfig({
    jwks,
    issuer,
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
  }).catch(() => ({ ok: false as const, reason: 'jwks_malformed' as const }));
  identityConfigValidationCache = { key: cacheKey, result };
  return result;
}

export type AgentStudioConfigErrorCode =
  | 'session_secret_missing'
  | 'session_secret_too_short'
  | 'cail_identity_issuer_missing'
  | 'cail_identity_issuer_invalid'
  | 'cail_identity_jwks_missing'
  | 'cail_identity_jwks_invalid'
  | 'production_gateway_binding_missing'
  | 'cail_model_invalid'
  | 'cail_api_base_invalid'
  | 'production_canonical_origin_invalid'
  | 'production_base_path_missing'
  | 'production_base_path_invalid'
  | 'production_base_path_root';

export type AgentStudioConfigValidation =
  | { ok: true }
  | { ok: false; errorCode: AgentStudioConfigErrorCode };

function validHttpsBase(value: string | undefined): boolean {
  try {
    const parsed = new URL(value ?? '');
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && !parsed.hostname.endsWith('.invalid')
      && !parsed.href.includes('REPLACE')
      && value === value?.trim()
      && !/[\u0000-\u001f\u007f\\\s]/.test(value ?? '');
  } catch {
    return false;
  }
}

function validCanonicalOrigin(value: string | undefined): boolean {
  try {
    const parsed = new URL(value ?? '');
    return parsed.protocol === 'https:'
      && parsed.origin === parsed.href.replace(/\/$/, '')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

/** Validate configuration that the worker actually consumes. */
export async function validateAgentStudioConfig(env: {
  SESSION_SECRET?: unknown;
  CAIL_REQUIRE_IDENTITY?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  GATEWAY?: { fetch?: unknown };
  CAIL_CANONICAL_ORIGIN?: string;
  CAIL_BASE_PATH?: string;
}): Promise<AgentStudioConfigValidation> {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length === 0) {
    return { ok: false, errorCode: 'session_secret_missing' };
  }
  if (env.SESSION_SECRET.length < MIN_REQUIRED_SESSION_SECRET_LENGTH) {
    return { ok: false, errorCode: 'session_secret_too_short' };
  }

  if (env.CAIL_MODEL !== undefined && !isAllowedCailModelId(env.CAIL_MODEL)) {
    return { ok: false, errorCode: 'cail_model_invalid' };
  }
  if (env.CAIL_API_BASE !== undefined && !validHttpsBase(env.CAIL_API_BASE)) {
    return { ok: false, errorCode: 'cail_api_base_invalid' };
  }

  const required = env.CAIL_REQUIRE_IDENTITY === 'true';
  const issuerConfigured = typeof env.CAIL_IDENTITY_ISSUER === 'string'
    && env.CAIL_IDENTITY_ISSUER !== '';
  const jwksConfigured = typeof env.CAIL_IDENTITY_JWKS === 'string'
    && env.CAIL_IDENTITY_JWKS.trim() !== '';
  const identityConfigured = required || issuerConfigured || jwksConfigured;
  if (required && !issuerConfigured) {
    return { ok: false, errorCode: 'cail_identity_issuer_missing' };
  }
  if (issuerConfigured && env.CAIL_IDENTITY_ISSUER !== CAIL_CANONICAL_ISSUER) {
    return { ok: false, errorCode: 'cail_identity_issuer_invalid' };
  }
  if (identityConfigured) {
    const identityConfig = await loadSharedIdentityConfig(
      env.CAIL_IDENTITY_JWKS,
      env.CAIL_IDENTITY_ISSUER,
    );
    if (!identityConfig.ok) {
      return {
        ok: false,
        errorCode: identityConfig.reason === 'jwks_missing'
          ? 'cail_identity_jwks_missing'
          : 'cail_identity_jwks_invalid',
      };
    }
  }

  // A deployed identity profile has no anonymous model transport. The service
  // binding and authenticated base URL are both explicit requirements.
  if (required) {
    if (!validHttpsBase(env.CAIL_API_BASE)) {
      return { ok: false, errorCode: 'cail_api_base_invalid' };
    }
    if (typeof env.GATEWAY?.fetch !== 'function') {
      return { ok: false, errorCode: 'production_gateway_binding_missing' };
    }
    if (!validCanonicalOrigin(env.CAIL_CANONICAL_ORIGIN)) {
      return { ok: false, errorCode: 'production_canonical_origin_invalid' };
    }
    if (!env.CAIL_BASE_PATH?.trim()) {
      return { ok: false, errorCode: 'production_base_path_missing' };
    }
    if (!isValidBasePath(env.CAIL_BASE_PATH)) {
      return { ok: false, errorCode: 'production_base_path_invalid' };
    }
    if (normalizeBasePath(env.CAIL_BASE_PATH) === '/') {
      return { ok: false, errorCode: 'production_base_path_root' };
    }
  }

  return { ok: true };
}
