# Security and operations

This is the canonical current-state contract for the Agent Studio Worker. It
defines what the source enforces and which deployment or institutional actions
remain outside the repository.

## Shared primitive revisions

| Primitive | Consumer boundary | Reviewed revision |
| --- | --- | --- |
| `cail-identity` | Direct identity verification dependency | `00419a9409680716a04e514068ba2b128ce7afa7` |
| `cail-log` | Direct event/correlation dependency and the single transitive instance used by `cail-client` | `75e0dda3068794ae1543e1e2bb98c9c920bb848f` |
| `cail-client` | Direct model and catalog transport dependency | `16da40171381b8bf38543730b45dba484ba01940` |
| `cail-sandbox-client` | Not installed; reviewed as a separate remote-sandbox boundary that Agent Studio does not call | `3d90d1cdcf8953cf64822682f589099484734b5d` |

`cloudflare/package.json` and `bun.lock` are the executable pin authorities.
The table records why each shared primitive is or is not part of this consumer.

## Production preflight

`validateAgentStudioConfig` runs before application traffic and backs
`/health`. When `CAIL_LOG_ENV=production`, all of these are mandatory:

| Boundary | Required state |
| --- | --- |
| Session | `SESSION_SECRET` is at least 32 characters and comes from the authorized secret store. |
| Identity | `CAIL_REQUIRE_IDENTITY=true`; `CAIL_IDENTITY_ISSUER` is the one exact issuer for the deployment environment; `CAIL_IDENTITY_JWKS` is a non-empty RS256 RSA signing-key set with `kid`, `n`, and `e`. |
| Model proxy | `CAIL_API_BASE` is an HTTPS, non-placeholder URL without credentials, query, or fragment. |
| Browser origin | `CAIL_CANONICAL_ORIGIN` is one exact HTTPS origin with no path, query, or fragment. |
| Shared mount | `CAIL_BASE_PATH` is a valid non-root path. The checked-in build uses `/agent-studio`. |
| Rate limiting | Both `API_RATE_LIMIT` and `HEAVY_RATE_LIMIT` bindings expose `limit()`. |
| Gallery ACL | `GALLERY_OWNER_KEYS` is a JSON keyring of 32-or-more-character secrets and `GALLERY_OWNER_ACTIVE_KEY_ID` selects a present key. |
| Compatibility window | `CAIL_SSO_SWITCHED_AT` and `CAIL_ACCOUNT_IMPORT_UNTIL` are complete instants; the exclusive deadline is no more than 30 days after the switch. |
| Telemetry | `CAIL_LOG_ENV`, `CF_VERSION_METADATA`, and `CAIL_FLEET_EVENTS` are valid. |

Invalid production configuration returns a canonical 503 for application
traffic. `/health` remains reachable and returns 503. The checked-in Wrangler
variables intentionally fail this gate because identity enforcement is
`false`; an authorized deployment must inject the final values atomically.

Local and test environments may omit rate bindings, use `/`, run anonymously,
and use `SESSION_SECRET` as the gallery-owner compatibility key. Those
allowances are not production defaults.

## Identity, sessions, and CSRF

The Worker verifies only the canonical `X-CAIL-Identity-JWT`. Verification is
RS256 against the configured JWKS, one exact environment issuer, and audience
`cail:agent-studio`. Authenticated ownership derives from the stable
pseudonymous subject. Bare identity claims and email are not authorization
inputs.

Each HTTP request resolves one session before authorization. Production
requires a verified subject. The raw identity JWT is installed into a
workspace Durable Object only through an internal server RPC, reverified, and
bound to that object's subject-derived session before storage. It is used only
as the CAIL model-proxy credential.

The session bootstrap sets a script-readable CSRF cookie scoped to the app
mount. Each token is a signed, nonce-bearing capability with a ten-minute
lifetime, bound to the session and either the anonymous or subject principal
class. Mutations and sensitive workspace GET/HEAD routes require
`X-CAIL-CSRF`. Workspace file and preview URLs contain no token. The frontend
fetches protected bytes with the header and renders a temporary blob URL.

WebSocket upgrades enforce the exact origin and the same capability at the
edge and Durable Object. The token remains in the WebSocket query because the
browser API cannot set a custom header. `Referrer-Policy: no-referrer` is set
on application responses. Once identity is required, anonymous-class
capabilities are rejected; callable mutations also require a bound subject.
Private reads, credential installation, files, migration, deletion, and
reliability collection are not browser-callable.

An accepted WebSocket is authorized at connection time. A capability expiring
does not terminate an already accepted socket. Identity-enforcement releases
must assume old runtime connections can exist briefly during rollout and use
the platform's connection-drain/restart behavior as an activation check.

## Agent, model, and tool permissions

Agent Studio stores no provider API key. Model calls go to
`{CAIL_API_BASE}/v1/...` with the verified caller JWT and
`X-CAIL-App: agent-studio`. The shared proxy is authoritative for catalog
policy, token and cost accounting, and user quota. Studio does not emit
`cail.quota.charged` or maintain a remaining-budget ledger.

The model transport uses `cail-client` with an HTTPS configured base, manual
redirect handling, omitted ambient credentials, and no SDK-adapter retries.
Gateway-declared non-retryable responses and ambiguous network failures surface
as typed errors before an SDK can replay them. Correlation forwarding preserves
the W3C sampled flag and tracestate, replaces the correlation headers as one
unit, and requires lowercase UUID-v4 request IDs.

Studio code execution uses Cloudflare Dynamic Workers through codemode. It does
not call the remote CAIL Sandbox bridge and therefore does not depend on
`cail-sandbox-client`; its capabilities, lifecycle, and accounting contract are
separate.

Authentication and 429 quota responses are surfaced in the canonical error
shape. Quota failures are not automatically retried. A model call already
admitted by the proxy may finish while distributed accounting converges; local
rate limits are not a substitute for authoritative quota.

Code execution runs in the Dynamic Worker boundary. Browser-callable code,
panel, and layout inputs use the same bounded runtime schemas as HTTP. Host
research tools have explicit schemas. Credential brokers keep Primo,
WorldCat, and LibGuides secrets out of model context.

Guarded web fetch blocks private destinations and checks every redirect. A
production deployment should set `CAIL_WEBFETCH_ALLOWLIST` when exact
destinations are known because Workers cannot perform a resolve-then-check DNS
policy. Git token injection is limited to clone/fetch/pull/push, an exact
allowed hostname, HTTPS on the default port, and URLs without embedded user
credentials. Empty token or allowlist means no injection.

## Rate and quota behavior

The general API binding allows 300 operations per 60 seconds; the heavy
binding allows 20. Heavy operations include execute, upload, import, publish,
and WebSocket chat admission. Keys are session identifiers, never IP
addresses. Cloudflare rate-limit bindings count per data center, so these are
abuse controls rather than global quotas. Missing bindings fail open outside
production; production preflight requires them.

Rate-limit responses are HTTP 429 with `Retry-After` where the HTTP boundary
can supply it. The frontend surfaces the retryable error. It does not retry
paid model work automatically.

## Storage and concurrency

| Authority | Contents and boundary |
| --- | --- |
| Workspace Durable Object | Canvas state, messages, stored model credential, migration flag, and exact lifecycle rows for one workspace. |
| Dynamic Worker workspace | Active workspace files and isolated execution effects. |
| R2 session records | Workspace metadata, queued downloads, compatibility objects, and exports. |
| R2 gallery records | Public manifest/state/files plus a private versioned owner record. |
| MigrationRegistry Durable Object | One claim state machine per anonymous session. |

R2 workspace metadata updates use entity-tag compare-and-swap with bounded
retry. Layout changes merge panels, groups, and connections by identifier;
group deletion is explicit through `removeGroups`. R2 listing code follows
every cursor and fails rather than accepting a truncated page without a
continuation cursor.

These controls do not create a transaction across Durable Objects, Dynamic
Workers, and R2. Multi-store workflows use commit markers, idempotency keys,
compensation, and explicit unknown-outcome errors.

## Destructive and multi-store workflows

Workspace deletion first refuses an active mutation, freezes the agent,
clears runtime files, destroys Durable Object storage including messages,
credentials and lifecycle tables, removes both workspace and runtime R2
prefixes, then deletes the workspace record last. Any failed step returns an
error and the same DELETE is the recovery action. A failure after destructive
work may leave a frozen or partially removed workspace; do not recreate data
under the same id before the delete retry succeeds.

Batch upload accepts at most 50 files, 25 MB per file, and 50 MB total. It
validates count, size, type, and every path before writing. It
snapshots each original target. On failure it restores overwritten bytes and
deletes newly created paths. `upload_outcome_unknown` means rollback itself
failed; stop automatic retries, preserve the request file list, and reconcile
each named target before retrying.

Gallery publication requires a client operation UUID. Its deterministic
24-hex id makes an ambiguous retry return the committed manifest without
rereading files. State and private ownership are written before the public
manifest, which is the commit marker. The workspace record is stamped by CAS.
If another publication wins or the workspace disappears, Studio deletes the
losing gallery object. `publish_outcome_unknown` means the stamp failed and
compensation could not be confirmed; reconcile the workspace `galleryId` and
the deterministic gallery prefix before retrying.

One workspace has at most one live `galleryId`. Public manifests contain no
owner identifier. Authorization uses `owner.json` with a versioned HMAC key
id. Activate new owner keys by adding the key, retaining every old key, and
then changing the active id. There is no bulk re-signing job; an old key must
remain until all records signed by it have been republished, migrated, or
deleted. Legacy manifests are read only for compatibility and are converted
when account migration touches them.

The account-import state machine and recovery procedure are in
[Legacy account import](./legacy-account-import.md).

## Browser content boundary

Private workspace bytes are delivered only through header-authenticated
fetches. File responses use `nosniff`, a restrictive CSP, and attachment
disposition for active types. HTML previews run in sandboxed iframes without
same-origin authority. Markdown does not enable raw HTML.

Chart CSS generation accepts only bounded CSS identifiers and inert color
tokens before constructing a style block. Gallery data cannot inject an
arbitrary selector or declaration through chart keys or colors.

## API contract

JSON failures use:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_request",
    "cail": {
      "request_id": "optional-request-id",
      "retryable": false
    }
  }
}
```

Authentication may add `login_url`; quota errors may add retry metadata. The
HTTP boundary canonicalizes legacy flat failures, and the frontend can parse
both shapes during compatibility. Gallery listing is cursor-paginated with a
maximum page size of 100; the current frontend follows all pages.

## Logging and privacy

Application events use fixed route templates and bounded fields. They exclude
prompts, messages, code, JWTs, session/workspace identifiers, filenames,
destination URLs, and arbitrary exception text. One HTTP request produces one
boundary event. The gateway remains the accounting authority; exact local
action/model lifecycle rows live inside each workspace object.

Cloudflare may retain platform-generated failures outside the application
schema. Production retention, provider access, legal deletion requirements,
and incident access controls are deployment policies, not values this source
can choose. See [Observability](./observability.md).

## Deployment and recovery checklist

Before an authorized production release:

1. Provision distinct production and preview R2 buckets, Worker Loader,
   Durable Object migrations, rate-limit bindings, version metadata, and the
   Analytics Engine binding. Do not use the production bucket for preview.
2. Inject secrets and policy values without printing them: session secret,
   valid JWKS, gallery owner keyring and active id, optional Git/tool
   credentials, exact allowlists, canonical origin, and model-proxy base.
3. Set identity enforcement and the two migration instants in the same release.
4. Build with `/agent-studio`; verify `dist/index.html` asset URLs and exercise
   page, API, sensitive-read, and WebSocket routes through that mount.
5. Run typecheck, all tests, build, Wrangler dry-run, link check, diff check,
   and secret scan. Apply Durable Object class migrations only through the
   authorized deployment process; they do not migrate application data.
6. Probe `/agent-studio/health`, test one authenticated workspace and model
   quota failure, verify a preview-bucket write, and confirm no production R2
   mutation occurred during validation.
7. Activate the private reliability collector, health/SLO evaluator,
   dashboard, alerts, retention, backup, restore, and incident procedures.
8. Record the account-import removal ticket due at the exclusive cutoff.

Rollback is a deployment action. Preserve the gallery owner keyring and both
Durable Object classes across a code rollback. Do not roll back to code that
cannot read the current private owner record or migration claim state. If a
release changes only code and has not changed external data, route traffic back
through the authorized Cloudflare release mechanism. If migrations or user
data changed, use the tested restore/reconciliation procedure rather than a
blind code rollback.

The repository cannot activate or verify production secrets, domains, OAuth
grants, Cloudflare resources, backups, restore objectives, notification
recipients, retention rules, or the Kale-admin collector. Those are named
activation and policy inputs, not source defects.
