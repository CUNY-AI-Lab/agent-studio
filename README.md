# Agent Studio

Agent Studio is now a single Cloudflare-native application.

- [cloudflare](/Users/stephenzweibel/Apps/agent-studio/cloudflare): Worker API, Durable Object agent, Dynamic Worker runtime, R2-backed workspace storage, and static asset hosting
- [frontend](/Users/stephenzweibel/Apps/agent-studio/frontend): React/Vite client served by the worker

The legacy Next.js + runner implementation has been archived under [archive/legacy-next-app](/Users/stephenzweibel/Apps/agent-studio/archive/legacy-next-app) and is no longer the active app.

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
OPENROUTER_API_KEY=<your-openrouter-api-key>
OPENROUTER_MODEL=anthropic/claude-sonnet-4
```

`cloudflare/wrangler.jsonc` also expects a bound R2 bucket for `WORKSPACE_FILES` and a Worker Loader binding for Dynamic Workers.

For deployed environments, set `SESSION_SECRET` and `OPENROUTER_API_KEY` as Wrangler secrets for the worker. `OPENROUTER_MODEL` is optional unless you want to override the default model.

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
