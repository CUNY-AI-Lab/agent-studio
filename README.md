# Agent Studio

Agent Studio is the CUNY AI Lab research workspace. A React/Vite client talks
to a Hono Cloudflare Worker, which owns one `WorkspaceAgent` Durable Object per
workspace and persists workspace records and files in R2. The app is mounted
at `/agent-studio` in the shared CAIL host.

The repository contains application source and local validation. Production
access, secrets, domains, and Cloudflare resources remain operator-controlled.
OpenWebUI is a separate protected application and is out of scope for this
repository.

## Local setup

Use Bun from the repository root:

```bash
bun install
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
bun run dev
```

Set a local `SESSION_SECRET`. Leave identity values empty for anonymous local
work, or provide a complete local issuer and JWKS together. Never put a token,
private key, or user data in source control.

The client can run separately when needed:

```bash
bun run dev:worker
bun run dev:frontend
```

The split client proxies `/api`, `/agents`, and `/health` to the Worker. The
same `/agent-studio` base path is used by the production build, API, WebSocket,
and CSRF cookie.

## CAIL identity and model path

The Worker accepts only the verified `X-CAIL-Identity-JWT` header. The token is
checked against the one configured CUNY SSO issuer, the configured RS256 JWKS,
and audience `cail:agent-studio`; ownership uses the stable pseudonymous CAIL
subject, never email. The app identity is the exact slug `agent-studio` and
model requests carry `X-CAIL-App: agent-studio`.

The production issuer is `https://tools.ailab.gc.cuny.edu/cail-sso`; the
staging issuer is `https://tools.cuny.qzz.io/cail-sso`. A deployment selects
one exact issuer and never combines them.

Credentialed model work uses the separate gateway leg in
`X-CAIL-Gateway-Identity-JWT`, whose audience is `cail:gateway`. The Worker
installs that verified credential into the workspace Durable Object before a
chat request. `CAIL_API_BASE` identifies the CAIL Model API and the `GATEWAY`
Cloudflare service binding carries the direct Vercel AI SDK OpenAI-compatible
transport. Agent Studio stores no provider key and does not select a second
model path.

## What the app provides

- Workspace create, edit, import/export, and deletion with Durable Object state
  and R2 records.
- Authenticated streaming chat with the CAIL model gateway.
- Files, previews, canvas panels, groups, connections, gallery publication,
  and cloning.
- Isolated JavaScript execution through Cloudflare Dynamic Workers.
- Guarded research fetches and server-side credentials for Primo, WorldCat,
  and LibGuides; host-side PDF, XLSX, and DOCX tools; and the runtime research
  skill documents.

The first successful login may perform the one-time lazy import described in
[One-time first-login import](./docs/legacy-account-import.md). It requires a
currently verified identity and a verified signed legacy session mapping,
copies the complete content and relationships, writes one per-user completion
marker only after success, and then uses the new subject namespace as the
authority. There is no dual read, background job, alias, or synchronization
path.

## Validation

Run the same checks used by CI:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

The local Worker integration smoke creates a synthetic workspace, verifies
protected API, WebSocket, file, canvas, and Dynamic Worker behavior, and
deletes the workspace before it exits. It prints only safe step labels; it
never prints JWTs, subjects, emails, workspace identifiers, or user content.

```bash
bun run smoke
```

For an authenticated staging check, export the URL and both identity-keyring
legs through the environment. The default script runs the paid chat leg and
requires both tokens. To run an app-only staging smoke, pass the explicit
flag:

```bash
export AGENT_STUDIO_STAGING_URL
export AGENT_STUDIO_APP_IDENTITY_JWT
export AGENT_STUDIO_GATEWAY_IDENTITY_JWT
bun run smoke:staging
bun run smoke:staging -- --with-chat=false
```

The staging smoke uses the isolated preview R2 bucket, verifies useful output
and persisted state, and deletes its synthetic workspace even when a check
fails. Keep all credentials in the secret-handling environment.

## Reviewed staging deploy

Review source and the checks above before deploying. The direct staging
command is:

```bash
cd cloudflare
wrangler deploy --env staging --strict
```

The checked-in staging environment binds `GATEWAY` and `CAIL_API_BASE` to the
staging CAIL Model API and binds `WORKSPACE_FILES` to `agent-studio-preview`.
That bucket is separate from production `agent-studio`; staging validation
must never mutate live workspace data. Do not add deployment flags that change
identity, service bindings, routes, or the bucket.

See [Security and operations](./docs/security-and-operations.md) for the
current trust boundaries and [cloudflare/README.md](./cloudflare/README.md) for
Worker-specific commands.
