import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';
import { loadIdentityVerifierConfig } from '@cuny-ai-lab/cail-identity';
import { z } from 'zod';
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

export interface AgentStudioConfigInput {
  SESSION_SECRET?: string;
  CAIL_REQUIRE_IDENTITY?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  GATEWAY?: { fetch?: typeof fetch };
  CAIL_CANONICAL_ORIGIN?: string;
  CAIL_BASE_PATH?: string;
}

const stringSchema = z.string();
const gatewayBindingSchema = z.object({ fetch: z.function() });

function containsForbiddenControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function validHttpsBase(value: string | undefined): boolean {
  const candidate = stringSchema.safeParse(value).data;
  if (candidate === undefined) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && !parsed.hostname.endsWith('.invalid')
      && !parsed.href.includes('REPLACE')
      && candidate === candidate.trim()
      && !containsForbiddenControl(candidate)
      && !/[\s\\]/.test(candidate);
  } catch {
    return false;
  }
}

function validCanonicalOrigin(value: string | undefined): boolean {
  const candidate = stringSchema.safeParse(value).data;
  if (candidate === undefined) return false;
  try {
    const parsed = new URL(candidate);
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
export async function validateAgentStudioConfig(env: AgentStudioConfigInput): Promise<AgentStudioConfigValidation> {
  const sessionSecretResult = stringSchema.safeParse(env.SESSION_SECRET);
  const sessionSecret = sessionSecretResult.data;
  if (!sessionSecret) {
    return { ok: false, errorCode: 'session_secret_missing' };
  }
  if (sessionSecret.length < MIN_REQUIRED_SESSION_SECRET_LENGTH) {
    return { ok: false, errorCode: 'session_secret_too_short' };
  }

  if (env.CAIL_MODEL !== undefined && !isAllowedCailModelId(env.CAIL_MODEL)) {
    return { ok: false, errorCode: 'cail_model_invalid' };
  }
  if (env.CAIL_API_BASE !== undefined && !validHttpsBase(env.CAIL_API_BASE)) {
    return { ok: false, errorCode: 'cail_api_base_invalid' };
  }

  const requireIdentity = stringSchema.safeParse(env.CAIL_REQUIRE_IDENTITY).data;
  const issuerResult = stringSchema.safeParse(env.CAIL_IDENTITY_ISSUER);
  const jwksResult = stringSchema.safeParse(env.CAIL_IDENTITY_JWKS);
  const issuer = issuerResult.data;
  const jwks = jwksResult.data;
  const canonicalOrigin = stringSchema.safeParse(env.CAIL_CANONICAL_ORIGIN).data;
  const basePath = stringSchema.safeParse(env.CAIL_BASE_PATH).data;
  if (env.CAIL_IDENTITY_ISSUER !== undefined && !issuerResult.success) {
    return { ok: false, errorCode: 'cail_identity_issuer_invalid' };
  }
  if (env.CAIL_IDENTITY_JWKS !== undefined && !jwksResult.success) {
    return { ok: false, errorCode: 'cail_identity_jwks_invalid' };
  }
  const required = requireIdentity === 'true';
  const issuerConfigured = Boolean(issuer);
  const jwksConfigured = Boolean(jwks?.trim());
  const identityConfigured = required || issuerConfigured || jwksConfigured;
  if (required && !issuerConfigured) {
    return { ok: false, errorCode: 'cail_identity_issuer_missing' };
  }
  if (issuerConfigured && issuer !== CAIL_CANONICAL_ISSUER) {
    return { ok: false, errorCode: 'cail_identity_issuer_invalid' };
  }
  if (identityConfigured) {
    const identityConfig = await loadSharedIdentityConfig(
      jwks,
      issuer,
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
    if (!gatewayBindingSchema.safeParse(env.GATEWAY).success) {
      return { ok: false, errorCode: 'production_gateway_binding_missing' };
    }
    if (!validCanonicalOrigin(canonicalOrigin)) {
      return { ok: false, errorCode: 'production_canonical_origin_invalid' };
    }
    if (!basePath?.trim()) {
      return { ok: false, errorCode: 'production_base_path_missing' };
    }
    if (!isValidBasePath(basePath)) {
      return { ok: false, errorCode: 'production_base_path_invalid' };
    }
    if (normalizeBasePath(basePath) === '/') {
      return { ok: false, errorCode: 'production_base_path_root' };
    }
  }

  return { ok: true };
}
