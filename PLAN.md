# Agent Studio Plan (Cloudflare Worker lineage)

This file tracks the Worker architecture and its open decisions. The legacy
Next.js + runner plan lives on `main`.

## Current architecture

- Cloudflare Worker (Hono) as the application API and static-asset host
- `WorkspaceAgent` Durable Object per workspace: chat, canvas state, tools
- Model calls through the CAIL model proxy — no provider keys; Workers AI
  catalog models only (default `@cf/zai-org/glm-5.2`, override via `CAIL_MODEL`)
- Identity: pinned-HS256 `X-CAIL-Identity-JWT` verification; all data keyed by
  the pseudonymous CAIL subject; anonymous sessions migrate claim-once on
  first login
- Execution: JS-only codemode in Dynamic Workers (Worker Loader), sandbox
  network blocked; the host `web_fetch` tool is the only egress, with a
  public-destination policy and server-side credential injection (Primo)
- Research capability: curated skill docs (`cloudflare/src/skills/`) exposed
  via the `read_skill` tool and indexed in the system prompt; docs are
  markdown source compiled into `docs.generated.ts` by
  `scripts/build-skill-docs.mjs`
- Storage: R2 (bucket `agent-studio`) + DO SQLite

## Product contract (unchanged from main)

- Files are durable artifacts; tiles are views over files or derived data
- The agent is a source-forward research assistant: discovery assistance over
  answer generation, verifiable identifiers on claims, no fabricated citations

## Open decisions

1. **Python / document-format capability.** ~~The legacy Python sandbox
   (pandas, pdfplumber, openpyxl; pdf/xlsx/docx/pptx skills) has no Worker
   equivalent.~~ **JS document capability shipped host-side.** Pure-JS,
   workerd-compatible libraries run in the main Worker and are exposed to the
   codemode sandbox as host tools (same pattern as web_fetch) via
   `cloudflare/src/lib/document-tools.ts` — no external conversion service, no
   Python. **In:** PDF text extraction (`unpdf`/pdf.js → `codemode.parse_pdf`,
   page-marked, ~200k-char/500-page caps), XLSX read + write (SheetJS CE →
   `codemode.read_xlsx` / `codemode.write_xlsx`, JSON rows in/out, 5k-row cap),
   and DOCX generation from a declarative block schema (`docx` →
   `codemode.write_docx`: heading/paragraph/list/table). These tools are
   codemode-only (excluded from direct model tools, like web_fetch) so bulk
   content flows through sandbox code. Skill docs restored under
   `src/skills/docs/{pdf,xlsx,docx}.md`. `pdf-lib` is a dev-only dependency used
   to generate the test PDF fixture. **Deferred (honest limits):** no OCR for
   scanned PDFs; no PDF generation/merge/split/forms; XLSX writes static values
   only (no formulas/formatting/in-place template edits); DOCX is generation
   only (no reading/editing/tracked-changes) and covers no images/headers/
   footers; **pptx** has no generation path at all. Larger option: Cloudflare
   Sandbox SDK (containers) for real Bash/Python and the deferred cases — cost
   and complexity to evaluate after launch usage data (stays post-launch).
2. **WorldCat and LibGuides skills.** ~~Dropped in the port — both need OAuth
   client-credential token exchanges, which belong server-side.~~ **Resolved.**
   Server-side OAuth client-credentials implemented in
   `cloudflare/src/lib/api-token-broker.ts` (per-provider in-memory token cache,
   expiry with a 60s safety margin, single 401-retry). web-fetch-guard attaches
   the bearer token per-hop only on the allowlisted API host (WorldCat
   `metadata.api.oclc.org`; LibGuides host derived from `LIBGUIDES_BASE_URL`),
   dropping it across any off-host redirect — same no-credentials-in-model-
   context posture as Primo. Skill docs restored under `cloudflare/src/skills/
   docs/`. Secrets arrive at deploy per the cail-gateway `LAUNCH_CHECKLIST`
   (commit b449c84 there); canonical local source `~/Apps/library-tools/.env`
   (values never in this repo).
3. **CSRF and rate limiting.** The legacy middleware had both; the Worker has
   neither. **Rate limiting resolved for the HTTP surface.** Uses Cloudflare's
   Rate Limiting binding (wrangler.jsonc `unsafe.bindings`, type "ratelimit"),
   not in-memory maps — see `cloudflare/src/lib/rate-limit.ts`. Two namespaces:
   `API_RATE_LIMIT` (300/60s) for general `/api/*`, `HEAVY_RATE_LIMIT` (20/60s)
   for expensive POSTs (runtime/execute, upload, import, publish). Keyed by
   session id (stable across SSO subjects and anonymous cookies), not IP.
   Counting is per-colo — acceptable for launch scale, not a global hard cap.
   Fail-open: bindings are declared optional and limiting is skipped when
   absent (local dev / tests / miniflare), so CI smoke stays green. On limit:
   429 `{error:'rate_limited', message}` + `Retry-After: 30`. **Known
   remainder:** the WebSocket chat path (`/agents/*`) does NOT go through the
   `/api/*` middleware and is unlimited in this pass — per-message limiting
   belongs inside the DO and needs product thinking about long agent turns.
   CSRF still needs a decision once the SSO gate's cookie/header model is final
   ­— JSON APIs behind SameSite=Lax cookies plus JWT-gated mutations may be
   sufficient; confirm against the gateway contract before launch.
4. **Frontend monolith and accessibility.** `frontend/src/App.tsx` (~5k lines)
   is a 1:1 port of the legacy canvas page: 40+ state hooks, minimal ARIA on a
   drag-heavy canvas, no error boundaries, no UI tests. Splitting the
   presentational components out and doing a real accessibility pass are
   scoped, separate efforts.
5. **Test breadth.** Coverage is deep on auth/identity/migration and the new
   guard/skills/upload slices, but `server.ts` routes and the WorkspaceAgent
   DO itself are untested. Route-level tests against a mocked env are the
   next highest-value addition.

## Hard constraints

- No deploys until the institutional Cloudflare contract signs
- Backbone contract changes (model proxy, error envelope, budgets) are
  proposed to the gateway project, not made here
- `*.cuny.qzz.io` hostnames are interim config values, never literals in code
