import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';
import type { CailAnalyticsEngineDataset, CailLogEnvironment } from '@cuny-ai-lab/cail-log';
import { CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER } from '@cuny-ai-lab/cail-identity';
import { isValidBasePath, normalizeBasePath } from './lib/base-path';

export interface Env {
  ASSETS: Fetcher;
  LOADER: WorkerLoader;
  WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  MIGRATION_REGISTRY: DurableObjectNamespace<MigrationRegistry>;
  WORKSPACE_FILES: R2Bucket;
  SESSION_SECRET: string;
  // Cloudflare Rate Limiting bindings (wrangler.jsonc unsafe.bindings, type
  // "ratelimit"). Optional so local dev / tests / miniflare quirks fail open —
  // see src/lib/rate-limit.ts. RateLimit comes from @cloudflare/workers-types.
  API_RATE_LIMIT?: RateLimit;
  HEAVY_RATE_LIMIT?: RateLimit;
  // CAIL backbone: model calls go through LiteLLM, never a
  // provider key. See src/lib/cail-model.ts and src/lib/cail-identity.ts.
  CAIL_OPENAI_BASE_URL?: string;
  CAIL_MODEL?: string;
  // Operational-log resource identity. The deployment environment is an
  // explicit fleet classification; the immutable release comes from
  // Cloudflare's version_metadata binding.
  CAIL_LOG_ENV?: CailLogEnvironment;
  // Required fleet diagnostic projection. Source intentionally does not bind
  // or provision the Analytics Engine dataset.
  CAIL_FLEET_EVENTS?: CailAnalyticsEngineDataset;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_REQUIRE_IDENTITY?: string;
  // Temporary compatibility window for importing anonymous pre-SSO accounts.
  // Both values are required when identity enforcement is enabled. The end is
  // exclusive and may be no more than 30 days after the switch instant.
  CAIL_SSO_SWITCHED_AT?: string;
  CAIL_ACCOUNT_IMPORT_UNTIL?: string;
  // CSRF canonical-origin override (fleet contract §3¾ rule 2). Unset in local
  // dev / on workers.dev, where the request's own origin is canonical. Set to
  // https://tools.ailab.gc.cuny.edu for that deployment, where the
  // browser-visible origin differs from the worker's request URL. See
  // src/lib/csrf.ts.
  CAIL_CANONICAL_ORIGIN?: string;
  // One normalized mount for assets, API, agent WebSocket routing, frontend
  // URLs, and the `cail_csrf_agentstudio` cookie. Defaults to '/' locally;
  // production requires a non-root path and the checked-in build uses
  // '/agent-studio'. See src/lib/base-path.ts and src/lib/csrf.ts.
  CAIL_BASE_PATH?: string;
  GIT_AUTH_TOKEN?: string;
  // Comma-separated host allowlist for GIT_AUTH_TOKEN injection. The default git token
  // is attached to clone/fetch/pull/push ONLY when the target URL host matches one of
  // these exact hostnames. Unset/empty = the token is never attached to user-supplied
  // git URLs (safe default). See src/lib/git-guard.ts.
  GIT_AUTH_ALLOWED_HOSTS?: string;
  // Versioned gallery-owner HMAC keyring. JSON object keyed by stable key id;
  // the active id signs new private owner records while retained ids verify
  // existing records during rotation.
  GALLERY_OWNER_KEYS?: string;
  GALLERY_OWNER_ACTIVE_KEY_ID?: string;
  // Optional web_fetch destination allowlist (anti-DNS-rebind containment).
  // Comma-separated host patterns: an exact host ("api.openalex.org") or a
  // leading-dot suffix (".oclc.org" matches api.oclc.org and oclc.org). When
  // set, web_fetch and every redirect hop must match or are blocked; when
  // unset, the open research web works with the name-blocklist only. A true
  // resolve-then-check is impossible in a Workers isolate (no DNS API), so this
  // is the deployment's real rebind control. See src/lib/web-fetch-guard.ts.
  CAIL_WEBFETCH_ALLOWLIST?: string;
  // CUNY Primo (Ex Libris) search API. When configured, web_fetch attaches
  // apikey/vid/scope server-side for the Primo host — the key never enters
  // model context. All optional; Primo search is simply unavailable without.
  PRIMO_API_BASE?: string;
  PRIMO_API_KEY?: string;
  PRIMO_VID?: string;
  PRIMO_SCOPE?: string;
  // OCLC WorldCat Search/Metadata API. When configured, web_fetch exchanges the
  // client id/secret for a bearer token server-side (OAuth client-credentials)
  // and attaches it to the WorldCat API host. All optional; WorldCat search is
  // simply unavailable without. Values arrive at deploy per the ops checklist.
  OCLC_CLIENT_ID?: string;
  OCLC_CLIENT_SECRET?: string;
  OCLC_INSTITUTION_ID?: string;
  // Springshare LibGuides API. Same server-side bearer pattern as WorldCat; the
  // API host is derived from LIBGUIDES_BASE_URL. All optional.
  LIBGUIDES_BASE_URL?: string;
  LIBGUIDES_CLIENT_ID?: string;
  LIBGUIDES_CLIENT_SECRET?: string;
  LIBGUIDES_SITE_ID?: string;
}

export const MIN_REQUIRED_SESSION_SECRET_LENGTH = 32;
export const MAX_ACCOUNT_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type AccountImportWindowState =
  | 'pre-enforcement'
  | 'not-started'
  | 'open'
  | 'expired'
  | 'invalid';

export type AgentStudioConfigErrorCode =
  | 'session_secret_missing'
  | 'session_secret_too_short'
  | 'cail_log_environment_missing'
  | 'cail_log_environment_invalid'
  | 'worker_version_metadata_missing'
  | 'worker_version_metadata_invalid'
  | 'cail_fleet_events_missing'
  | 'cail_fleet_events_invalid'
  | 'cail_identity_issuer_missing'
  | 'cail_identity_issuer_invalid'
  | 'cail_identity_issuer_environment_mismatch'
  | 'cail_sso_switched_at_missing'
  | 'cail_sso_switched_at_invalid'
  | 'cail_account_import_until_missing'
  | 'cail_account_import_until_invalid'
  | 'cail_account_import_until_before_switch'
  | 'cail_account_import_window_too_long'
  | 'production_identity_required'
  | 'production_identity_jwks_missing'
  | 'production_identity_jwks_invalid'
  | 'production_api_base_invalid'
  | 'production_canonical_origin_invalid'
  | 'production_base_path_missing'
  | 'production_base_path_invalid'
  | 'production_base_path_root'
  | 'production_api_rate_limit_missing'
  | 'production_heavy_rate_limit_missing'
  | 'production_gallery_owner_keys_missing'
  | 'production_gallery_owner_keys_invalid'
  | 'production_gallery_owner_active_key_missing';

export type AgentStudioConfigValidation =
  | { ok: true }
  | { ok: false; errorCode: AgentStudioConfigErrorCode };

type AccountImportEnv = Pick<
  Env,
  'CAIL_REQUIRE_IDENTITY' | 'CAIL_SSO_SWITCHED_AT' | 'CAIL_ACCOUNT_IMPORT_UNTIL'
>;

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse a complete ISO 8601 instant. Date-only and timezone-less values fail. */
export function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;

  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function validateAccountImportWindow(
  env: Partial<AccountImportEnv>,
): AgentStudioConfigValidation {
  const required = env.CAIL_REQUIRE_IDENTITY === 'true';
  const configured =
    env.CAIL_SSO_SWITCHED_AT !== undefined || env.CAIL_ACCOUNT_IMPORT_UNTIL !== undefined;
  if (!required && !configured) return { ok: true };

  if (typeof env.CAIL_SSO_SWITCHED_AT !== 'string' || env.CAIL_SSO_SWITCHED_AT.length === 0) {
    return { ok: false, errorCode: 'cail_sso_switched_at_missing' };
  }
  const switchedAt = parseIsoInstant(env.CAIL_SSO_SWITCHED_AT);
  if (switchedAt === null) {
    return { ok: false, errorCode: 'cail_sso_switched_at_invalid' };
  }
  if (
    typeof env.CAIL_ACCOUNT_IMPORT_UNTIL !== 'string' ||
    env.CAIL_ACCOUNT_IMPORT_UNTIL.length === 0
  ) {
    return { ok: false, errorCode: 'cail_account_import_until_missing' };
  }
  const importUntil = parseIsoInstant(env.CAIL_ACCOUNT_IMPORT_UNTIL);
  if (importUntil === null) {
    return { ok: false, errorCode: 'cail_account_import_until_invalid' };
  }
  if (importUntil < switchedAt) {
    return { ok: false, errorCode: 'cail_account_import_until_before_switch' };
  }
  if (importUntil - switchedAt > MAX_ACCOUNT_IMPORT_WINDOW_MS) {
    return { ok: false, errorCode: 'cail_account_import_window_too_long' };
  }
  return { ok: true };
}

/**
 * Resolve the temporary compatibility state. Invalid configuration closes the
 * path; the request-level startup guard reports the specific configuration
 * error before application traffic reaches these helpers.
 */
export function accountImportWindowState(
  env: Partial<AccountImportEnv>,
  now = Date.now(),
): AccountImportWindowState {
  const hasWindow =
    env.CAIL_SSO_SWITCHED_AT !== undefined || env.CAIL_ACCOUNT_IMPORT_UNTIL !== undefined;
  if (!hasWindow && env.CAIL_REQUIRE_IDENTITY !== 'true') return 'pre-enforcement';
  if (!validateAccountImportWindow(env).ok) return 'invalid';

  const switchedAt = parseIsoInstant(env.CAIL_SSO_SWITCHED_AT);
  const importUntil = parseIsoInstant(env.CAIL_ACCOUNT_IMPORT_UNTIL);
  if (switchedAt === null || importUntil === null) return 'invalid';
  if (now < switchedAt) return 'not-started';
  if (now >= importUntil) return 'expired';
  return 'open';
}

export function legacyAccountCompatibilityAllowed(
  env: Partial<AccountImportEnv>,
  now = Date.now(),
): boolean {
  const state = accountImportWindowState(env, now);
  return state === 'pre-enforcement' || state === 'open';
}

/** Validate required runtime configuration before any application traffic. */
export function validateAgentStudioConfig(
  env: {
    SESSION_SECRET?: unknown;
    CAIL_LOG_ENV?: unknown;
    CF_VERSION_METADATA?: Partial<WorkerVersionMetadata>;
    CAIL_FLEET_EVENTS?: unknown;
    CAIL_REQUIRE_IDENTITY?: string;
    CAIL_SSO_SWITCHED_AT?: string;
    CAIL_ACCOUNT_IMPORT_UNTIL?: string;
    CAIL_IDENTITY_JWKS?: string;
    CAIL_IDENTITY_ISSUER?: string;
    CAIL_OPENAI_BASE_URL?: string;
    CAIL_CANONICAL_ORIGIN?: string;
    CAIL_BASE_PATH?: string;
    API_RATE_LIMIT?: { limit?: unknown };
    HEAVY_RATE_LIMIT?: { limit?: unknown };
    GALLERY_OWNER_KEYS?: string;
    GALLERY_OWNER_ACTIVE_KEY_ID?: string;
  }
): AgentStudioConfigValidation {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length === 0) {
    return { ok: false, errorCode: 'session_secret_missing' };
  }
  if (env.SESSION_SECRET.length < MIN_REQUIRED_SESSION_SECRET_LENGTH) {
    return { ok: false, errorCode: 'session_secret_too_short' };
  }
  if (env.CAIL_LOG_ENV === undefined || env.CAIL_LOG_ENV === '') {
    return { ok: false, errorCode: 'cail_log_environment_missing' };
  }
  if (!['production', 'staging', 'development', 'test'].includes(String(env.CAIL_LOG_ENV))) {
    return { ok: false, errorCode: 'cail_log_environment_invalid' };
  }
  if (env.CF_VERSION_METADATA === undefined) {
    return { ok: false, errorCode: 'worker_version_metadata_missing' };
  }
  if (
    typeof env.CF_VERSION_METADATA.id !== 'string'
    || env.CF_VERSION_METADATA.id.trim().length === 0
  ) {
    return { ok: false, errorCode: 'worker_version_metadata_invalid' };
  }
  if (env.CAIL_FLEET_EVENTS === undefined || env.CAIL_FLEET_EVENTS === null) {
    return { ok: false, errorCode: 'cail_fleet_events_missing' };
  }
  if (
    typeof env.CAIL_FLEET_EVENTS !== 'object'
    || typeof (env.CAIL_FLEET_EVENTS as { writeDataPoint?: unknown }).writeDataPoint !== 'function'
  ) {
    return { ok: false, errorCode: 'cail_fleet_events_invalid' };
  }

  const identityIssuer = env.CAIL_IDENTITY_ISSUER;
  if (env.CAIL_REQUIRE_IDENTITY === 'true' && !identityIssuer) {
    return { ok: false, errorCode: 'cail_identity_issuer_missing' };
  }
  if (
    identityIssuer !== undefined
    && identityIssuer !== CAIL_CANONICAL_ISSUER
    && identityIssuer !== CAIL_STAGING_ISSUER
  ) {
    return { ok: false, errorCode: 'cail_identity_issuer_invalid' };
  }
  if (
    (env.CAIL_LOG_ENV === 'production' && identityIssuer !== CAIL_CANONICAL_ISSUER)
    || (env.CAIL_LOG_ENV === 'staging' && identityIssuer !== CAIL_STAGING_ISSUER)
  ) {
    return { ok: false, errorCode: 'cail_identity_issuer_environment_mismatch' };
  }

  if (env.CAIL_LOG_ENV === 'production') {
    if (env.CAIL_REQUIRE_IDENTITY !== 'true') {
      return { ok: false, errorCode: 'production_identity_required' };
    }
    if (!env.CAIL_IDENTITY_JWKS?.trim()) {
      return { ok: false, errorCode: 'production_identity_jwks_missing' };
    }
    try {
      const jwks = JSON.parse(env.CAIL_IDENTITY_JWKS) as { keys?: unknown };
      if (
        !Array.isArray(jwks.keys)
        || jwks.keys.length === 0
        || jwks.keys.some((key) => {
          if (!key || typeof key !== 'object' || Array.isArray(key)) return true;
          const candidate = key as Record<string, unknown>;
          return candidate.kty !== 'RSA'
            || candidate.alg !== 'RS256'
            || candidate.use !== 'sig'
            || typeof candidate.kid !== 'string'
            || candidate.kid.length === 0
            || typeof candidate.n !== 'string'
            || candidate.n.length === 0
            || typeof candidate.e !== 'string'
            || candidate.e.length === 0;
        })
      ) {
        return { ok: false, errorCode: 'production_identity_jwks_invalid' };
      }
    } catch {
      return { ok: false, errorCode: 'production_identity_jwks_invalid' };
    }
    try {
      const apiBase = new URL(env.CAIL_OPENAI_BASE_URL ?? '');
      if (
        apiBase.protocol !== 'https:'
        || apiBase.username
        || apiBase.password
        || apiBase.search
        || apiBase.hash
        || !apiBase.pathname.replace(/\/+$/, '').endsWith('/v1')
        || apiBase.hostname.endsWith('.invalid')
        || apiBase.href.includes('REPLACE')
      ) {
        return { ok: false, errorCode: 'production_api_base_invalid' };
      }
    } catch {
      return { ok: false, errorCode: 'production_api_base_invalid' };
    }
    try {
      const canonicalOrigin = new URL(env.CAIL_CANONICAL_ORIGIN ?? '');
      if (
        canonicalOrigin.protocol !== 'https:'
        || canonicalOrigin.origin !== canonicalOrigin.href.replace(/\/$/, '')
      ) {
        return { ok: false, errorCode: 'production_canonical_origin_invalid' };
      }
    } catch {
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
    if (typeof env.API_RATE_LIMIT?.limit !== 'function') {
      return { ok: false, errorCode: 'production_api_rate_limit_missing' };
    }
    if (typeof env.HEAVY_RATE_LIMIT?.limit !== 'function') {
      return { ok: false, errorCode: 'production_heavy_rate_limit_missing' };
    }
    if (!env.GALLERY_OWNER_KEYS?.trim()) {
      return { ok: false, errorCode: 'production_gallery_owner_keys_missing' };
    }
    let ownerKeys: Record<string, unknown>;
    try {
      ownerKeys = JSON.parse(env.GALLERY_OWNER_KEYS) as Record<string, unknown>;
      if (
        !ownerKeys
        || Array.isArray(ownerKeys)
        || Object.keys(ownerKeys).length === 0
        || Object.entries(ownerKeys).some(([id, secret]) =>
          !/^[A-Za-z0-9_-]{1,32}$/.test(id)
          || typeof secret !== 'string'
          || secret.length < MIN_REQUIRED_SESSION_SECRET_LENGTH)
      ) {
        return { ok: false, errorCode: 'production_gallery_owner_keys_invalid' };
      }
    } catch {
      return { ok: false, errorCode: 'production_gallery_owner_keys_invalid' };
    }
    if (
      !env.GALLERY_OWNER_ACTIVE_KEY_ID
      || typeof ownerKeys[env.GALLERY_OWNER_ACTIVE_KEY_ID] !== 'string'
    ) {
      return { ok: false, errorCode: 'production_gallery_owner_active_key_missing' };
    }
  }
  return validateAccountImportWindow(env);
}
