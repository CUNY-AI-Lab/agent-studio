# Agent Studio repository instructions

## Invariants

- Use Bun for JavaScript and TypeScript work. Read the relevant source and run
  the real local path before changing behavior.
- Agent Studio is the CUNY AI Lab app with slug `agent-studio`, mounted at
  `/agent-studio`. The application identity header is
  `X-CAIL-Identity-JWT` with audience `cail:agent-studio`; accept one exact
  configured CUNY issuer and use only the verified pseudonymous subject for
  ownership. Never authorize by email or a bare identity header.
- Credentialed model calls use the separate
  `X-CAIL-Gateway-Identity-JWT` leg with audience `cail:gateway`. The Worker
  must have the `GATEWAY` service binding, `CAIL_API_BASE`, and the direct AI
  SDK transport. Keep `X-CAIL-App: agent-studio` on model requests. Agent
  Studio stores no provider key.
- Workspace state belongs to the workspace Durable Object; workspace records
  and files belong to R2. Staging always uses the isolated
  `agent-studio-preview` bucket and must not touch production `agent-studio`.
- OpenWebUI is a separate protected application. Preserve it and do not edit
  or deploy it from this repository.

## Workflow

- Read `CANVAS-DESIGN.md` before changing canvas behavior or product language,
  and `ACCESSIBILITY.md` before changing interactions. Runtime capability
  guidance must follow the file-first tool contract in
  `cloudflare/src/agent/instructions.ts`: durable artifacts use workspace files
  plus `ui_show_file`, and direct text/data downloads use `ui_download`. Do not
  restore legacy preview-panel or `addPanel` examples in skill instructions.
- Keep the implementation direct. Do not add compatibility aliases, fallback
  reads, provenance or receipt theater, broad polling, or hidden retries.
  Tests and smoke commands must be labeled honestly; the local Worker process
  smoke is an integration smoke, not an end-to-end claim.
- The only legacy bridge is one-time lazy import on first successful login:
  require the verified current identity and a verified signed legacy Agent
  Studio session cookie, copy complete content and relationships privately,
  write one per-user completion marker only after success, then make the new
  subject namespace authoritative. A failed copy is retryable; do not add
  dual reads, aliases, synchronization, framework jobs, or a broad time
  window. Keep the narrow per-legacy-session lock that fences already-admitted
  anonymous writes; it contains claim/lease state only, never user content.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and
  the local smoke before claiming a change is ready. Review source and checks
  before the direct staging command:

  ```bash
  cd cloudflare
  wrangler deploy --env staging --strict
  ```

- Production release is CI-only: `.github/workflows/ci.yml` validates PRs and
  main, then serializes the main deploy. Its exact-SHA readback and health,
  root, and unauthenticated no-store-401 probes are release gates. Use the
  direct `wrangler deploy --env staging --strict` command above only for the
  isolated staging environment; there is no PR production preview.

- Never expose JWTs, subjects, emails, workspace identifiers, prompts, files,
  credentials, or user data in logs, smoke output, command arguments, or
  documentation. Keep secrets in the authorized environment.

## Test value

- Every test protects a visible user action, a load-bearing boundary, or a
  deliberately injected failure such as cancellation, stale state, or a race.
  Delete harness-only checks and duplicate DOM or CSS assertions.
- Name the boundary honestly: component tests exercise rendered components,
  in-process tests exercise a local adapter or Worker seam, and browser tests
  exercise the built frontend across a real local Worker process. Do not call a
  mocked callback or an in-process fake an end-to-end test.
- Browser acceptance acts through accessible controls and checks what a user
  sees, downloads, and finds persisted after reload. It does not assert CSS
  classes, framework internals, callback counts, or implementation-only DOM
  rows.
- Keep model behavior deterministic. Use a maintained local fake/provider seam
  when model protocol behavior is in scope; otherwise use a deterministic
  artifact path and state explicitly which model behavior was not tested.
