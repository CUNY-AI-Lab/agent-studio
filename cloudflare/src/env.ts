import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';

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
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_REQUIRE_IDENTITY?: string;
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
