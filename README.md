# Agent Studio

Agent Studio is a Cloudflare-native research workspace: a React/Vite client,
Hono Worker API, `WorkspaceAgent` Durable Object, Dynamic Worker code runtime,
and R2-backed workspace and gallery storage.

This checkout contains deployable source, not deployment authorization. The
checked-in production variables intentionally leave identity enforcement off,
so production traffic fails closed until an authorized release supplies the
required identity, origin, migration-window, ownership-key, and secret values.
See [Security and operations](./docs/security-and-operations.md).

- [cloudflare](./cloudflare): Worker, Durable Objects, Dynamic Worker runtime,
  storage, and static-asset delivery
- [frontend](./frontend): React/Vite client
- [docs](./docs/README.md): documentation map and disposition

## Requirements

- Bun 1.3.14
- Node.js 22 for the backend test runner
- Wrangler and Cloudflare authentication for remote development or an
  authorized deployment

## Local setup

Install from the repository root:

```bash
bun install
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
```

At minimum, replace `SESSION_SECRET` and keep
`CAIL_LOG_ENV=development`. `CAIL_API_BASE` is required for model calls; the
example value is deliberately invalid. Local anonymous mode leaves all
identity fields unset; when identity is configured, provide the one exact
environment issuer and its JWKS together. The issuer is never a combined
production/staging allowlist.

Agent Studio holds no model-provider key. It forwards a locally verified
gateway-audience JWT as one `Authorization: Bearer …` credential to the CAIL
model proxy with `X-CAIL-App: agent-studio`. The proxy owns the model catalog,
accounting, and authoritative quota. Local model validation accepts only
`@cf/...` identifiers.

The root `.env.example` is only a pointer. Worker variables belong in
`cloudflare/.dev.vars`; split frontend development uses
`frontend/.env.example`.

## Running

Worker-first development builds the frontend and serves it from Wrangler:

```bash
bun run dev
```

Split development is also available:

```bash
bun run dev:worker
bun run dev:frontend
```

The split frontend proxies `/api`, `/agents`, and `/health` to
`VITE_WORKER_ORIGIN`, which defaults to `http://127.0.0.1:8787`.

The production build is mounted at `/agent-studio`. The Worker strips that
prefix before API, WebSocket, SPA, and asset routing; the Vite build and Agents
client use the same prefix. Local split development defaults to `/`.

## Product surface

- Create, import, export, update, and delete research workspaces.
- Stream agent chat, choose an allowed model, and surface canonical
  authentication, rate, and quota errors.
- Upload files and render text, CSV, images, PDF, HTML previews, tables,
  charts, cards, and linked detail views.
- Arrange canvas tiles with pointer or keyboard controls, groups,
  connections, contextual chat, and zoom.
- Publish one idempotent public gallery item per workspace, clone public
  items, and unpublish owned items.
- Run isolated JavaScript with guarded research APIs, Git credentials, and
  host-side PDF, XLSX, and DOCX tools.

## Architecture and trust boundaries

- A signed anonymous cookie owns local-development sessions. In identity mode,
  ownership keys to the verified CAIL pseudonymous subject, never email.
- Short-lived, nonce-bearing CSRF capabilities are bound to the session and
  anonymous/subject class. Mutations and sensitive reads use the header; the
  browser WebSocket handshake uses the query parameter because it cannot set a
  custom header.
- Browser-callable Durable Object methods are limited to bounded state
  mutations and code execution. Credential installation, private reads, file
  operations, migration, deletion, and reliability collection are internal
  RPCs. Generic client state replacement is refused; every browser mutation
  must pass through an explicit callable schema.
- Workspace metadata uses R2 compare-and-swap. Layout patches merge by item
  identifier. Create, import, and gallery clone write the workspace record last
  as their visibility marker. Migration and deletion fence active mutations
  before destructive state changes.
- Gallery publication uses a client operation UUID, deterministic object id,
  manifest-last commit marker, and compensating delete if the workspace CAS
  cannot be stamped.
- API errors use the canonical nested CAIL envelope. The frontend retains flat
  error parsing only for compatibility with older responses.

The complete identity, quota, storage, rollback, recovery, privacy, and deploy
contracts are in [Security and operations](./docs/security-and-operations.md).
The temporary anonymous-to-subject workflow is in
[Legacy account import](./docs/legacy-account-import.md).

## Verification

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun audit
(cd cloudflare && bunx wrangler deploy --env staging --strict --dry-run --outdir /tmp/agent-studio-wrangler-dry-run)
```

The smoke client accepts a mounted base URL and verifies the protected Agents
WebSocket without invoking a model. An authorized release should additionally
verify the mounted asset paths, probe `/agent-studio/health` with deployment
inputs, and complete the activation checklist in the operations guide. Do not
infer permission to create buckets, secrets, domains, OAuth grants, or
deployments from the presence of repository scripts.

For an authorized staging model smoke, provide both identity-keyring legs only
through the environment and keep output redacted. The command names the
variables without placing JWT values in shell arguments or logs:

```bash
export AGENT_STUDIO_STAGING_URL
export AGENT_STUDIO_APP_IDENTITY_JWT
export AGENT_STUDIO_GATEWAY_IDENTITY_JWT
bun run smoke:staging
```

The app-audience JWT authorizes Agent Studio; the same-subject gateway-audience
JWT is installed for the model call. The staging wrapper's `--with-chat=true`
fails closed when either leg is missing. `--quiet=true` (also accepted as
`--redacted=true`)
prints only boolean step receipts and still deletes the synthetic workspace.
The staging wrapper performs that keyring check before the health request;
it also takes the staging URL from `AGENT_STUDIO_STAGING_URL` so the command
line contains no deployment URL. Passing `--with-chat=false` runs an app-only
API smoke.

`bun run deploy` is the reviewed staging path. It selects the checked-in
`staging` Wrangler environment, uses strict conflict checks, applies the
source-controlled variables authoritatively, and targets the isolated
`agent-studio-staging` Worker at
`cail-model-api-staging`; see the Worker
[deployment notes](./cloudflare/README.md#reviewed-staging-deployment) for the
private JWKS file and reviewed tag/message command. The top-level production
profile remains intentionally fail-closed until its separate identity and
policy inputs are authorized.
