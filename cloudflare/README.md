# Agent Studio Worker

This package contains the Hono API, `WorkspaceAgent` and
`MigrationRegistry` Durable Objects, Dynamic Worker execution boundary, R2
storage adapters, and frontend asset binding.

Install from the repository root, then copy the local variable template:

```bash
bun install
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
bun run dev
```

Local development requires a unique `SESSION_SECRET` and
`CAIL_LOG_ENV=development`. Model calls also require an approved
`CAIL_API_BASE`. Anonymous local mode leaves the identity issuer and JWKS
unset, along with the dedicated gallery-owner keyring; production may not.
When identity is configured, `CAIL_IDENTITY_ISSUER` and its JWKS must be
provided together. The issuer selects one exact environment value; staging
must use the staging issuer.

The production build uses `/agent-studio` for Vite assets, API calls, the
Agents WebSocket path, Worker routing, and CSRF-cookie scope. Wrangler routes
all paths through the Worker before explicit asset delegation.

`wrangler.jsonc` declares the production and preview R2 bindings, Worker
Loader, Durable Objects, rate-limit bindings, version metadata, Analytics
Engine projection, and frontend build. The preview bucket must remain distinct
from production. The file deliberately does not contain production secrets or
the final identity/cutover inputs.

Production preflight rejects traffic when identity, JWKS, model-proxy URL,
canonical origin, non-root base path, rate-limit bindings, versioned gallery
owner keys, telemetry metadata, or the temporary migration window is missing
or invalid. `CAIL_MODEL` and proxy catalog entries must use the Cloudflare
Workers AI `@cf/...` namespace. `/health` reports the same validation result.

Operational and security requirements are canonical in
[Security and operations](../docs/security-and-operations.md). The temporary
identity migration is documented in
[Legacy account import](../docs/legacy-account-import.md), and logging
authority is documented in [Observability](../docs/observability.md).

Package checks:

```bash
bun run --cwd cloudflare typecheck
bun run --cwd cloudflare test
(cd cloudflare && bunx wrangler deploy --env staging --strict --keep-vars --dry-run)
```

## Reviewed staging deployment

`wrangler.jsonc` has an explicit `staging` environment. It targets the
`cail-model-api-staging` service binding and staging workers.dev URL, requires
the staging issuer, classifies logs as `staging`, and keeps identity required.
The named environment deploys as `agent-studio-staging`, leaving the live
`agent-studio` Worker untouched until a separate, authorized promotion.
The environment repeats the Worker Loader, Durable Object, R2, rate-limit,
Analytics Engine, version-metadata, and migration declarations because
Wrangler does not inherit those bindings into named environments. Its R2
binding uses the established `agent-studio-preview` bucket, not production
`agent-studio`. The default `deploy` script selects this profile, enables
strict conflict checks, and keeps undeclared remote variables; it cannot
silently select the candidate service.

After reviewing the release commit, provide a private secrets file containing
the approved staging `SESSION_SECRET` and `CAIL_IDENTITY_JWKS` (and any other
secrets being rotated) without printing its contents. The profile declares
those two names as required, so a first deploy cannot create an identity-gated
Worker without them. Then run:

```bash
RELEASE_TAG='<reviewed full 40-character Git SHA>'
RELEASE_MESSAGE='Agent Studio staging: cail-model-api-staging'
bun run --cwd cloudflare deploy -- \
  --tag "$RELEASE_TAG" \
  --message "$RELEASE_MESSAGE" \
  --secrets-file "$CAIL_STAGING_SECRETS_FILE"
```

`wrangler` is resolved from the exact `4.115.0` workspace dependency. The
script's `--strict --keep-vars` flags prevent a conflicting remote upload and
preserve existing cutover variables; Wrangler never deletes secrets during a
deployment. Keep `CAIL_STAGING_SECRETS_FILE` outside the repository and remove
it through the approved secret-handling process after the release.

Probe `/agent-studio/health`, an authenticated workspace, and one model call
after activation. For an incident, route traffic back to the previously
verified Worker version through Cloudflare's version rollback mechanism, then
repeat the health and workspace smoke checks. A rollback is not a reason to
reintroduce the candidate binding in source.
