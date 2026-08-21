# Agent Studio Worker

This package contains the Hono API, `WorkspaceAgent` Durable Object, Dynamic
Worker execution boundary, R2 adapters, and `/agent-studio` asset delivery.
The React/Vite client lives in `../frontend`.

## Local Worker

From the repository root:

```bash
bun install
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
bun run dev
```

Set a unique local `SESSION_SECRET`. Anonymous local work may leave the
identity issuer and JWKS empty. If identity is used,
set one exact CUNY issuer with its complete JWKS; do not mix staging and
production values.

The Worker accepts `X-CAIL-Identity-JWT` for audience `cail:agent-studio` and
uses the verified pseudonymous subject for ownership. Before credentialed chat,
the server verifies the gateway leg (`X-CAIL-Gateway-Identity-JWT`, audience
`cail:gateway`) and installs it into the workspace Durable Object. Model calls
use the direct AI SDK transport through `GATEWAY`, with `CAIL_API_BASE` set to
the public Gateway origin `https://tools.ailab.gc.cuny.edu`; the transport
appends the canonical `/v1` path. Requests carry `X-CAIL-App: agent-studio`.
Agent Studio stores no provider key.

Production and staging use the standalone Doorway issuer
`https://tools.ailab.gc.cuny.edu/cail-sso` and canonical origin
`https://tools.ailab.gc.cuny.edu`. Configure that one issuer with
its matching JWKS.

Workspace state and chat messages live in the Durable Object. Workspace
records and files live in R2. Dynamic Workers isolate code execution. Staging
binds `WORKSPACE_FILES` to `agent-studio-preview`; production uses
`agent-studio`. Keep the buckets separate. Wrangler's declarative `exports`
map identifies the live SQLite workspace class and the small first-login lock
class without retaining a deployment-history ledger. Both create instances
only on use; the lock stores no user content.

The one-time first-login import is described in
[the current import guide](../docs/legacy-account-import.md). It requires a
verified current identity and a valid signed legacy session cookie, copies
complete content and relationships, writes a per-user completion marker only
after success, and then uses the subject namespace as authority.

## Checks

```bash
bun run --cwd cloudflare typecheck
bun run --cwd cloudflare test
```

From the repository root, the local Worker integration smoke is:

```bash
bun run smoke
```

It creates and deletes a synthetic workspace, checks protected API and
WebSocket paths, verifies file/canvas/runtime state, and emits no JWTs,
subjects, emails, identifiers, or user content.

## Reviewed staging deploy

Review source and run the repository checks before deploying. Use the direct
manifest command; do not use a deploy wrapper or override its reviewed
bindings:

```bash
wrangler deploy --env staging --strict
```

The `staging` environment binds `GATEWAY` to the staging CAIL Model API and
`CAIL_API_BASE` to the canonical Gateway origin
(`https://tools.ailab.gc.cuny.edu`), requires the canonical Doorway identity
settings, and uses the isolated preview R2 bucket. After activation, run the
authenticated smoke with `AGENT_STUDIO_STAGING_URL`,
`AGENT_STUDIO_APP_IDENTITY_JWT`, and `AGENT_STUDIO_GATEWAY_IDENTITY_JWT`
supplied through the private environment.

OpenWebUI remains a separate protected application and is outside this Worker
package's scope.
