import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';
import type { CailLogEnvironment } from '@cuny-ai-lab/cail-log';

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
  // CAIL backbone: model calls go through the CAIL model proxy, never a
  // provider key. See src/lib/cail-model.ts and src/lib/cail-identity.ts.
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  // Operational-log resource identity. Deployment wiring is intentionally
  // separate from this source-only integration.
  CAIL_LOG_RELEASE?: string;
  CAIL_LOG_ENV?: CailLogEnvironment;
  CAIL_IDENTITY_JWKS?: string;
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
  // Base path this tool is served under, used as the Path scope of the
  // `cail_csrf_agentstudio` CSRF cookie (fleet contract §3¾ rule 3 delivery
  // amendment, 2026-07-05). Path-scoping is what keeps sibling tools / user
  // content on tools.ailab from reading the token via document.cookie. Defaults
  // to '/'; production on tools.ailab sets '/agent-studio'. '/' is acceptable
  // locally / on workers.dev because there are no same-origin siblings there.
  // See src/lib/csrf.ts.
  CAIL_BASE_PATH?: string;
  GIT_AUTH_TOKEN?: string;
  // Comma-separated host allowlist for GIT_AUTH_TOKEN injection. The default git token
  // is attached to clone/fetch/pull/push ONLY when the target URL host matches one of
  // these exact hostnames. Unset/empty = the token is never attached to user-supplied
  // git URLs (safe default). See src/lib/git-guard.ts.
  GIT_AUTH_ALLOWED_HOSTS?: string;
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
  | 'cail_sso_switched_at_missing'
  | 'cail_sso_switched_at_invalid'
  | 'cail_account_import_until_missing'
  | 'cail_account_import_until_invalid'
  | 'cail_account_import_until_before_switch'
  | 'cail_account_import_window_too_long';

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
  env:
    | Pick<
        Env,
        | 'SESSION_SECRET'
        | 'CAIL_REQUIRE_IDENTITY'
        | 'CAIL_SSO_SWITCHED_AT'
        | 'CAIL_ACCOUNT_IMPORT_UNTIL'
      >
    | ({ SESSION_SECRET?: unknown } & Partial<AccountImportEnv>)
): AgentStudioConfigValidation {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length === 0) {
    return { ok: false, errorCode: 'session_secret_missing' };
  }
  if (env.SESSION_SECRET.length < MIN_REQUIRED_SESSION_SECRET_LENGTH) {
    return { ok: false, errorCode: 'session_secret_too_short' };
  }
  return validateAccountImportWindow(env);
}
