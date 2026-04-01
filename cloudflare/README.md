# Agent Studio Worker

This package is the canonical backend/runtime for Agent Studio.

It provides:

- Hono API routes
- `WorkspaceAgent` Durable Object state
- OpenRouter-backed chat
- Dynamic Worker execution through the Worker Loader binding
- `@cloudflare/shell` workspace state inside the sandbox runtime
- R2-backed workspace and gallery files
- static asset hosting for the built frontend

## Local setup

```bash
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
```

Set `SESSION_SECRET` and `OPENROUTER_API_KEY` in `.dev.vars`. `OPENROUTER_MODEL` is optional unless you want to override the default model. Then confirm the R2 bucket and Worker Loader bindings in [wrangler.jsonc](/Users/stephenzweibel/Apps/agent-studio/cloudflare/wrangler.jsonc).

Run local development with:

```bash
npm run dev
```

Wrangler may prompt for Cloudflare login because the AI binding is remote.
