# Security and operations

This guide describes the current Agent Studio process. The Worker is a CUNY
AI Lab application mounted at `/agent-studio`; OpenWebUI is a separate
protected application and is not operated by this repository.

## Runtime boundaries

The React/Vite client calls a Hono Worker. The Worker routes each workspace to
one `WorkspaceAgent` Durable Object and stores workspace records, files,
exports, and gallery objects in R2. Dynamic Workers provide the isolated code
execution boundary. A workspace record is published only after its state and
required files are ready.

The Worker uses the direct CAIL Model API transport supplied by the Vercel AI
SDK's OpenAI-compatible provider. `CAIL_API_BASE` names the API and the
`GATEWAY` service binding supplies the same-account request path. Model calls
carry the verified gateway credential and `X-CAIL-App: agent-studio`; Agent
Studio stores no provider key.

## CAIL identity

Only `X-CAIL-Identity-JWT` is an application identity credential. The Worker
verifies its RS256 signature against `CAIL_IDENTITY_JWKS`, accepts CAIL's one
canonical Doorway issuer, and requires audience `cail:agent-studio`. The stable
pseudonymous CAIL subject is the ownership key. Email and bare identity
headers are never authorization inputs.

Production and staging use the standalone Doorway issuer
`https://tools.ailab.gc.cuny.edu/cail-sso` and canonical origin
`https://tools.ailab.gc.cuny.edu`.

Before a model call, the server may install the separate
`X-CAIL-Gateway-Identity-JWT` credential into the workspace Durable Object.
That token is checked for the same subject and audience `cail:gateway`. The
WebSocket carries no bearer token; it uses the session's CSRF capability while
the Durable Object uses the already verified gateway credential.

When identity is required, `CAIL_REQUIRE_IDENTITY=true`, a complete issuer/JWKS
pair, and the mounted base path are mandatory. Local development may leave
identity disabled, but a partial identity configuration is rejected rather
than treated as anonymous.

## Sessions, CSRF, and sockets

The session cookie is signed with `SESSION_SECRET`. A session bootstrap also
sets a short-lived CSRF cookie scoped to `CAIL_BASE_PATH`; protected reads and
mutations echo it in `X-CSRF-Token`. The browser WebSocket API cannot set a
custom header, so the same capability is carried in the upgrade query and
checked by both the Worker and Durable Object. The exact configured origin is
used for the origin check.

Durable Object methods exposed to the browser are explicit, schema-validated
operations. Generic state replacement, credential installation, private file
reads, deletion, and import internals remain server-side. An accepted socket
is authorized at connection time; a later CSRF expiry does not make it an
anonymous socket.

## Data and destructive operations

Workspace state, chat messages, credentials, and lifecycle state live in the
workspace Durable Object. R2 holds workspace metadata and bytes, queued
downloads, exports, and gallery records. The Worker writes the R2 workspace
record after the Durable Object and runtime state are ready, so list and get
routes do not expose an incomplete workspace.

Deletion freezes active mutations, clears runtime files, destroys Durable
Object state, removes workspace and runtime R2 prefixes, and then removes the
workspace record. If a step fails, the same authorized delete operation is the
recovery action; operators do not recreate the identifier while cleanup is
incomplete.

Gallery publication writes private ownership and state before the public
manifest and uses a client operation identifier to make a repeated request
safe. Public records do not contain owner identifiers. The private owner tag is
keyed by `SESSION_SECRET` and is never logged.

The only compatibility bridge is the [one-time first-login
import](./legacy-account-import.md). A verified current identity and a verified
signed legacy Agent Studio session cookie are required. The complete content
and relationships are copied privately, one per-user completion marker is
written only after success, and the new subject namespace becomes authoritative
then. A failed attempt remains retryable; there is no alias, dual read,
background job, synchronization loop, or broad time window.

Staging binds `WORKSPACE_FILES` to `agent-studio-preview`. Production binds to
`agent-studio`. Keep those buckets distinct so staging reads, writes, and
deletes cannot touch live data.

## Content and tool boundaries

Private files are fetched through the authenticated API. Responses use
`nosniff`, a restrictive CSP, and attachment disposition for active content;
HTML previews run in sandboxed iframes without same-origin authority.

Dynamic Worker code receives only the declared workspace capabilities. Guarded
web fetch blocks private destinations and checks every redirect. Git
credentials are injected only for explicitly allowed HTTPS hosts and are not
placed in model context. Primo, WorldCat, and LibGuides credentials are
attached server-side for their approved API hosts. PDF, XLSX, and DOCX tools
run on the host side of the Worker boundary.

## Errors and output

Operator-visible output is bounded and must not contain JWTs, subjects, emails,
workspace identifiers, prompts, messages, code, filenames, destination URLs,
or arbitrary exception text. Smoke output follows the same rule.

JSON failures use the nested CAIL error shape. Authentication failures identify
the login action without echoing a token. Model gateway quota and provider
errors are returned as bounded error types; model work is not silently sent to
another provider.

## Validation

From the repository root:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun run smoke
```

The local Worker process smoke creates a synthetic workspace, exercises the
protected API, WebSocket, file boundary, canvas state, and isolated runtime,
then deletes the workspace. An authenticated staging run additionally uses
both identity-keyring legs to exercise a paid chat and checks persisted
assistant state:

```bash
export AGENT_STUDIO_STAGING_URL
export AGENT_STUDIO_APP_IDENTITY_JWT
export AGENT_STUDIO_GATEWAY_IDENTITY_JWT
bun run smoke:staging
```

The smoke script never prints tokens, subjects, emails, identifiers, or user
content. Keep its environment private.

## Reviewed deploys

Production releases run from the `main` CI workflow after the repository check.
For the isolated staging environment, review source and run the direct
manifest command:

```bash
cd cloudflare
wrangler deploy --env staging --strict
```

The production manifest binds the production CAIL Model API and `agent-studio`
bucket. The staging environment binds the staging Model API and isolated
`agent-studio-preview` bucket. Both use the canonical Doorway issuer. Do not
override those bindings, identity settings, routes, or bucket names on the
command line. Run the authenticated staging smoke after activation and confirm
that the synthetic workspace was deleted.

Keep `SESSION_SECRET`, `CAIL_IDENTITY_JWKS`, and optional tool credentials in
the authorized secret store. Gallery ownership uses a private tag keyed by the
stable session secret. The public canonical origins are reviewed source
configuration, not secrets.
