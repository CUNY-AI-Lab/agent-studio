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

- Bun 1.3.5
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
example value is deliberately invalid. Local anonymous mode may leave the JWKS
and gallery-owner keyring values unset. `CAIL_IDENTITY_ISSUER` still names one
exact environment issuer; it is never a combined production/staging allowlist.

Agent Studio holds no model-provider key. It forwards a locally verified
`X-CAIL-Identity-JWT` to the CAIL model proxy with
`X-CAIL-App: agent-studio`. The proxy owns the model catalog, accounting, and
authoritative quota. Local model validation accepts only `@cf/...` identifiers.

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
  RPCs.
- Workspace metadata uses R2 compare-and-swap. Layout patches merge by item
  identifier. Migration and deletion fence active mutations before destructive
  state changes.
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
bun run typecheck
bun run test
bun run build
```

An authorized release should additionally run a Wrangler dry-run, verify the
mounted asset paths, probe `/agent-studio/health` with deployment inputs, and
complete the activation checklist in the operations guide. Do not infer
permission to create buckets, secrets, domains, OAuth grants, or deployments
from the presence of repository scripts.
