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
SDK's OpenAI-compatible provider. `CAIL_API_BASE` is the public Gateway origin
`https://tools.ailab.gc.cuny.edu`; the transport appends the canonical `/v1`
path, while the `GATEWAY` service binding supplies the same-account request
path. Model calls carry the verified gateway credential and
`X-CAIL-App: agent-studio`; Agent Studio stores no provider key.

Gateway spend and quota are attributed to the verified canonical Gateway JWT
subject for each user; Agent Studio also limits heavy Durable Object RPC calls
to 20 per minute per session, which is a separate application safeguard.

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
than treated as anonymous. The flag accepts only `true`, `false`, or omission;
a misspelled value fails configuration instead of disabling identity.

Agent-owned auth failures use cail-identity 5.2.5's strict nested envelope,
`{ "error": { "code", "message", "launch"? } }`. OpenAI-compatible
`type`/`param`/`cail` errors are parsed only at the upstream Gateway boundary;
they are not accepted as browser login challenges.

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

Gallery publication writes private ownership and state before the shared
gallery manifest and uses a client operation identifier to make a repeated
request safe. Gallery links open only for signed-in CAIL members; gallery
records are returned through authenticated routes and do not contain owner
identifiers. The private owner tag is keyed by `SESSION_SECRET` and is never
logged.

Publish, unpublish, upload batches, and competing file/tool writes share one
in-memory queue in the workspace Durable Object. Unpublish reads the current
publication inside that queue. Upload rollback finishes before a later writer
can start. This serializes operations in the running isolate; it is not a
transaction across R2 and Durable Object storage or a crash-recovery lock.
Unconfirmed cleanup returns an error, not a success response.

Queued downloads are acknowledged by the IDs actually delivered to the
browser. A later download is not removed by an earlier acknowledgement.
Interrupted delivery may be repeated; delivery is not exactly-once.

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
HTML previews run in sandboxed iframes without same-origin authority. The
browser does not open unknown files as top-level Blob pages. Native PDF
previews require PDF MIME; unknown or mismatched files remain downloadable.
Workspace export/import preserves non-UTF-8 bytes and UTF-8 byte-order marks.

Dynamic Worker code receives only the declared workspace capabilities. Guarded
web fetch remains available for public destinations, blocks private targets,
and checks every redirect. Optional Git credentials are considered only for
commands with an explicit allowlisted HTTPS URL; remote-only fetch, pull, and
push do not receive the default token. The native shell owns remote and
redirect handling, so this check is not a general Git egress policy. Do not
extend credential injection to remote-only commands without checking the
effective push URL and redirect behavior. Credentials are not placed in model
context. When configured, Primo, WorldCat, and LibGuides credentials are attached
server-side only for their approved API hosts. PDF, XLSX, and DOCX tools run
on the host side of the Worker boundary.

Stop aborts the model request, prevents later host/provider dispatches, and
cancels supported native fetches. Queued writes recheck the turn signal before
starting. Stop cannot undo a dispatched write or forcibly interrupt JavaScript
already running inside Code Mode; the installed executor has no abort API.

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

Production is front-door-only: `workers_dev=false`, preview URLs are disabled,
and the production manifest has no public Worker route. The canonical Doorway
host owns the public route and forwards `/agent-studio/*` over the private
Agent Studio service binding. CI reads back the exact tagged serving version
and production bindings, invokes the private `AgentStudioReadiness` named
WorkerEntrypoint through a local helper with `remote: true`, and then probes
`https://tools.ailab.gc.cuny.edu/agent-studio/` for the SSO redirect and
`/agent-studio/api/session` for a bounded unauthenticated 401. These probes do
not log in or send identity credentials.

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
