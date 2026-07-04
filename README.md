# Agent Studio

Agent Studio is now a single Cloudflare-native application.

- [cloudflare](/Users/stephenzweibel/Apps/agent-studio/cloudflare): Worker API, Durable Object agent, Dynamic Worker runtime, R2-backed workspace storage, and static asset hosting
- [frontend](/Users/stephenzweibel/Apps/agent-studio/frontend): React/Vite client served by the worker

The legacy Next.js + runner implementation lives on the `main` branch (it remains the source of the live pm2 deployment); this lineage replaces it and is the deployment target once the institutional Cloudflare contract signs.

## Requirements

- Node.js 20+
- npm
- Wrangler / Cloudflare auth for worker development and deploys

## Setup

Install both active packages:

```bash
npm run install:all
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
CAIL_IDENTITY_JWT_SECRET=                    # blank locally = anonymous
```

`cloudflare/wrangler.jsonc` also expects a bound R2 bucket for `WORKSPACE_FILES` and a Worker Loader binding for Dynamic Workers.

For deployed environments, set `SESSION_SECRET` and `CAIL_IDENTITY_JWT_SECRET` as Wrangler secrets. `CAIL_API_BASE` and `CAIL_MODEL` are `vars`.

### CAIL backbone integration

Agent Studio holds **no provider API key**. All model calls go through the
[CAIL model proxy](https://tools.ailab.gc.cuny.edu) at `{CAIL_API_BASE}/v1/...`
(Cloudflare AI Gateway's OpenAI-compatible path), forwarding the signed-in
user's `X-CAIL-Identity-JWT` as the credential plus `X-CAIL-App: agent-studio`
for spend attribution. Identity is verified locally (HS256, pinned) from that
JWT — bare `X-CAIL-*` headers are never trusted — and all per-user data keys to
the stable pseudonymous CAIL subject, never email. Quota/auth error envelopes
from the proxy (`quota_exceeded`, `authentication_required`, …) pass through to
the client unmodified; browser 401s follow the `/login?rt=` redirect pattern.
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
the `MigrationRegistry` Durable Object; see `cloudflare/src/lib/migration.ts`).

## Running

Worker-first local development:

```bash
npm run dev
```

This runs Wrangler from [cloudflare](/Users/stephenzweibel/Apps/agent-studio/cloudflare), builds [frontend](/Users/stephenzweibel/Apps/agent-studio/frontend), and serves the client from the worker.

Split local workflows are also available:

```bash
npm run dev:worker
npm run dev:frontend
```

`dev:frontend` proxies `/api`, `/agents`, and `/health` to `http://127.0.0.1:8787` by default.

## Verification

```bash
npm run typecheck
npm run build
```

## Architecture

- Cloudflare Worker + Hono routes for the application API
- `WorkspaceAgent` Durable Object for workspace chat, canvas state, and runtime orchestration
- Dynamic Workers via the Worker Loader binding for isolated code execution
- `@cloudflare/shell` workspace state inside the Dynamic Worker runtime
- R2-backed workspace files and gallery storage
- React/Vite frontend served as worker assets
