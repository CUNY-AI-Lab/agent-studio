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
`CAIL_API_BASE`. Anonymous local mode may omit the identity JWKS and dedicated
gallery-owner keyring; production may not. `CAIL_IDENTITY_ISSUER` selects one
exact issuer for the environment; staging must use the staging issuer.

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
or invalid. `/health` reports the same validation result.

Operational and security requirements are canonical in
[Security and operations](../docs/security-and-operations.md). The temporary
identity migration is documented in
[Legacy account import](../docs/legacy-account-import.md), and logging
authority is documented in [Observability](../docs/observability.md).

Package checks:

```bash
bun run --cwd cloudflare typecheck
bun run --cwd cloudflare test
```
