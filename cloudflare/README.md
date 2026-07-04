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
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
```

Set `SESSION_SECRET` and `CAIL_API_BASE` in `.dev.vars` (see the CAIL backbone notes in the root README). `CAIL_MODEL` overrides the default model; `CAIL_IDENTITY_JWT_SECRET` (blank locally = anonymous) verifies the SSO gate's identity JWT. Then confirm the R2 bucket and Worker Loader bindings in [wrangler.jsonc](/Users/stephenzweibel/Apps/agent-studio/cloudflare/wrangler.jsonc).

Run local development with:

```bash
npm run dev
```

Wrangler may prompt for Cloudflare login because the AI binding is remote.
