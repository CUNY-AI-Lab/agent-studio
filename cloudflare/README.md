# Agent Studio Worker

This package is the canonical backend/runtime for Agent Studio.

It provides:

- Hono API routes
- `WorkspaceAgent` Durable Object state
- Chat routed through the CAIL model proxy (no provider key held here)
- Dynamic Worker execution through the Worker Loader binding
- `@cloudflare/shell` workspace state inside the sandbox runtime
- R2-backed workspace and gallery files
- static asset hosting for the built frontend

## Local setup

```bash
bun install
cp .dev.vars.example .dev.vars
```

Run installation from the repository root. Set `SESSION_SECRET`, `CAIL_LOG_ENV`, and
`CAIL_API_BASE` in `.dev.vars` (see the CAIL backbone notes in the root README).
`CAIL_MODEL` overrides the default model. `CAIL_IDENTITY_JWKS` verifies the
canonical `X-CAIL-Identity-JWT` header with RS256 for audience
`cail:agent-studio`. Leave it blank locally for anonymous mode. Then confirm
the R2 bucket and Worker Loader bindings in [wrangler.jsonc](./wrangler.jsonc).

When setting `CAIL_REQUIRE_IDENTITY=true`, also set `CAIL_SSO_SWITCHED_AT` and
`CAIL_ACCOUNT_IMPORT_UNTIL` to timezone-bearing ISO instants. The end must be
at or after the switch and no more than 30 days later. The Worker returns 503
for health and application traffic when this enforced configuration is missing
or invalid. See [legacy-account-import.md](../docs/legacy-account-import.md).
Health also fails closed when `CAIL_LOG_ENV` is missing/invalid or the
Wrangler-managed `CF_VERSION_METADATA` binding is unavailable, so telemetry is
never silently assigned to a guessed environment or release.
The checked-in production Wrangler configuration supplies
`CAIL_LOG_ENV=production`; `.dev.vars` must override it with `development` for
local work. Runtime health also requires the checked-in `CAIL_FLEET_EVENTS`
Analytics Engine binding declaration. Cloudflare creates its dataset on the
first write after an authorized deployment; no live resource was created by
this source change. Collection and dashboard rollup rules are versioned in
[`contracts/observability/agent-studio.v1.json`](../contracts/observability/agent-studio.v1.json).

Run local development with:

```bash
bun run dev
```

Wrangler may prompt for Cloudflare login because the AI binding is remote.
