# Agent Studio

Agent Studio is a Cloudflare-native research workspace application.

- [cloudflare](./cloudflare): Worker API, Durable Object agent, Dynamic Worker runtime, R2-backed workspace storage, and static asset hosting
- [frontend](./frontend): React/Vite client served by the worker

## Requirements

- Bun 1.3.5
- Node.js 22 (backend tests run on Node's test runner)
- Wrangler / Cloudflare auth for worker development and deploys

## Setup

Install the workspace from the repository root:

```bash
bun install
```

Create the worker env file:

```bash
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
```

Set at least:

```bash
SESSION_SECRET=<random-32-byte-hex>
CAIL_API_BASE=<cail-model-proxy-base-url>   # placeholder until launch
CAIL_MODEL=@cf/zai-org/glm-5.2              # optional; Workers AI (@cf/...) ids only
CAIL_IDENTITY_JWKS=                          # static public JWKS JSON for RS256 identity
```

`cloudflare/wrangler.jsonc` also expects a bound R2 bucket for `WORKSPACE_FILES` and a Worker Loader binding for Dynamic Workers.

For deployed environments, set `SESSION_SECRET` and `CAIL_IDENTITY_JWKS`
through Wrangler. `CAIL_API_BASE` and `CAIL_MODEL` are `vars`.

### CAIL backbone integration

Agent Studio holds **no provider API key**. All model calls go through the
[CAIL model proxy](https://tools.ailab.gc.cuny.edu) at `{CAIL_API_BASE}/v1/...`
(Cloudflare AI Gateway's OpenAI-compatible path), forwarding the signed-in
user's selected raw identity JWT as the credential plus
`X-CAIL-App: agent-studio` for spend attribution. The canonical
`X-CAIL-Identity-JWT` header is verified locally as RS256 against the static
`CAIL_IDENTITY_JWKS`, audience `cail:agent-studio`, and the canonical/staging
issuer allowlist. `CAIL_REQUIRE_IDENTITY=true` fails closed when verification
cannot succeed. Identity enforcement also requires `CAIL_SSO_SWITCHED_AT` and
`CAIL_ACCOUNT_IMPORT_UNTIL` as complete ISO instants. The import deadline must
be at or after the switch and no more than 30 days later. Invalid or missing
values fail health checks and application traffic with 503. Bare `X-CAIL-*`
identity claims are never trusted, and all
per-user data keys to the stable pseudonymous CAIL subject, never email.
Quota/auth error envelopes from the proxy (`quota_exceeded`,
`authentication_required`, …) pass through to the client unmodified; browser
401s follow the `/login?rt=` redirect pattern.
See `cail-gateway/docs/INTEGRATION.md` for the full contract. `CAIL_API_BASE` is
a placeholder until the institutional Cloudflare contract signs
(`cail-gateway/docs/LAUNCH_CHECKLIST.md`).

Model policy (CAIL, 2026-07-04): **Workers AI catalog models only** — `@cf/...`
ids. The default is `@cf/zai-org/glm-5.2` (agentic, 262k context, function
calling); `@cf/openai/gpt-oss-120b` is a cheaper general-purpose override via
`CAIL_MODEL`.

Anything created anonymously before SSO enforcement follows the user on first
login: when an authenticated request still carries the legacy anonymous session
cookie, that namespace's workspaces, chat history, files, and gallery
authorship are copied into the subject namespace exactly once (claim-once via
the `MigrationRegistry` Durable Object). This compatibility applies only during
the configured account-import window. See
[`docs/legacy-account-import.md`](./docs/legacy-account-import.md) for rollout,
telemetry, and required deletion follow-up.

## Product surface

- Create blank workspaces or start from a prompt; export and import complete workspace bundles.
- Stream agent chat, retry failed turns, choose an allowed model, and surface authentication or quota failures.
- Upload and download files; render text, CSV, images, PDF, HTML previews, tables, charts, cards, and linked detail views.
- Arrange canvas tiles with pointer or keyboard controls, groups, connections, contextual chat, minimize/maximize, alignment, distribution, and zoom.
- Publish workspace metadata and artifacts to the public gallery, open shared gallery URLs, clone published workspaces, and unpublish owned items.
- Run isolated JavaScript through the Dynamic Worker boundary with guarded research API access and host-side PDF, XLSX, and DOCX tools.

## Running

Worker-first local development:

```bash
bun run dev
```

This runs Wrangler from [cloudflare](./cloudflare), builds [frontend](./frontend), and serves the client from the worker.

Split local workflows are also available:

```bash
bun run dev:worker
bun run dev:frontend
```

`dev:frontend` proxies `/api`, `/agents`, and `/health` to `http://127.0.0.1:8787` by default.

## Verification

```bash
bun run typecheck
bun run test
bun run build
```

## Architecture

- Cloudflare Worker + Hono routes for the application API
- `WorkspaceAgent` Durable Object for workspace chat, canvas state, and runtime orchestration
- Dynamic Workers via the Worker Loader binding for isolated code execution
- `@cloudflare/shell` workspace state inside the Dynamic Worker runtime
- R2-backed workspace files and gallery storage
- React/Vite frontend served as worker assets
