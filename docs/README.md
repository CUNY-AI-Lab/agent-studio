# Documentation map

This index classifies every maintained documentation surface in the checkout.
The canonical operator contract is
[Security and operations](./security-and-operations.md).

## Current guides

| Path | Classification | Canonical purpose |
| --- | --- | --- |
| [`../README.md`](../README.md) | Current | Repository entry point, local setup, product summary, and architecture overview. |
| [`security-and-operations.md`](./security-and-operations.md) | Current, canonical | Identity, authorization, configuration, quota, storage, concurrency, recovery, privacy, and deployment. |
| [`observability.md`](./observability.md) | Current | Diagnostic, exact reliability, accounting authorities, privacy, and activation. |
| [`legacy-account-import.md`](./legacy-account-import.md) | Current, temporary | Bounded anonymous-to-subject migration, retry, recovery, and cutoff removal. |
| [`../cloudflare/README.md`](../cloudflare/README.md) | Current | Worker-package development entry point; policy defers to the canonical operations guide. |
| [`../ACCESSIBILITY.md`](../ACCESSIBILITY.md) | Current | Keyboard map, ARIA decisions, testing, and current accessibility limitations. |
| [`../CANVAS-DESIGN.md`](../CANVAS-DESIGN.md) | Current product record | Canvas vocabulary, state model, interaction model, and unresolved product questions. |
| [`../contracts/observability/agent-studio.v1.json`](../contracts/observability/agent-studio.v1.json) | Current, machine-readable | Reliability collection, coverage, SLO, and alert rules. |

There is no repository `AGENTS.md`, `CLAUDE.md`, roadmap, incident report, or
standalone audit file. Workspace-level agent instructions are outside this
checkout.

## Configuration and command guidance

| Path | Classification | Purpose |
| --- | --- | --- |
| [`../.env.example`](../.env.example) | Current pointer | Directs users to the active Worker and frontend templates. |
| [`../cloudflare/.dev.vars.example`](../cloudflare/.dev.vars.example) | Current | Local Worker variables and safe production distinctions. |
| [`../frontend/.env.example`](../frontend/.env.example) | Current | Split-development Worker origin. |
| [`../cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc) | Current executable guidance | Bindings, mounted build, preview isolation, telemetry, and intentionally incomplete production variables. |
| [`../package.json`](../package.json) and workspace manifests | Current | Bun commands and pinned runtime dependencies. A deploy script is not deployment authorization. |
| [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Current | Repository-native CI commands. |
| [`../scripts/build-skill-docs.mjs`](../scripts/build-skill-docs.mjs) | Current | Runtime skill-document generation. |

Configuration comments in `cloudflare/src/env.ts`,
`cloudflare/src/lib/csrf.ts`, `cloudflare/src/lib/rate-limit.ts`,
`cloudflare/src/lib/git-guard.ts`, `frontend/src/api.ts`, and the Wrangler and
environment templates are implementation-adjacent guidance. They describe the
same current contract rather than separate runbooks.

## Runtime skill documentation

These are current user-facing instruction sources embedded into the Worker:

- `cloudflare/src/skills/docs/arxiv.md`
- `cloudflare/src/skills/docs/citation.md`
- `cloudflare/src/skills/docs/crossref.md`
- `cloudflare/src/skills/docs/docx.md`
- `cloudflare/src/skills/docs/frontend-design.md`
- `cloudflare/src/skills/docs/leaflet.md`
- `cloudflare/src/skills/docs/libguides.md`
- `cloudflare/src/skills/docs/openalex.md`
- `cloudflare/src/skills/docs/pdf.md`
- `cloudflare/src/skills/docs/primo.md`
- `cloudflare/src/skills/docs/pubmed.md`
- `cloudflare/src/skills/docs/semantic-scholar.md`
- `cloudflare/src/skills/docs/worldcat.md`
- `cloudflare/src/skills/docs/xlsx.md`

`cloudflare/src/skills/docs.generated.ts` is the required generated copy. The
Markdown sources are canonical and the generated file is not hand-edited.

## Project-local assistant instructions

The tracked `.claude/skills/*/SKILL.md` files are current development-time
assistant inputs, not product or operator documentation. The maintained set is:
`arxiv`, `census`, `citation`, `crossref`, `frontend-design`, `leaflet`,
`libguides`, `network-graph`, `nyc-opendata`, `openalex`, `pdf`, `primo`,
`pubmed`, `semantic-scholar`, `threejs`, `unpaywall`, `wikipedia`, `worldcat`,
and `xlsx`.

The untracked `.agents/skills` mirror is environment-managed and is not a
repository documentation authority.

## Disposition summary

Updated:

- `README.md`, `cloudflare/README.md`, `ACCESSIBILITY.md`, and
  `CANVAS-DESIGN.md`
- `docs/security-and-operations.md` and `docs/legacy-account-import.md`
- `.env.example`, `cloudflare/.dev.vars.example`, `cloudflare/wrangler.jsonc`,
  and configuration comments in source

Consolidated:

- production configuration, security, state, rollback, recovery, quota, and
  deploy guidance into `docs/security-and-operations.md`
- current logging and reliability guidance into `docs/observability.md` and
  the machine-readable observability contract

Retained:

- current accessibility and canvas product records
- the temporary migration runbook because it remains load-bearing until the
  cutoff removal
- runtime skill sources and distinct development-time skill instructions

Removed:

- `docs/cail-log-integration.md`; its current operational rules are represented
  by `docs/observability.md`, the canonical operations guide, source tests, and
  the machine-readable contract. The resolved review narrative and dated
  vendor survey had no remaining operational authority.
- `.claude/skills/docx/SKILL.md` and `.claude/skills/pptx/SKILL.md`; both were
  broken duplicates whose required companion assets were absent. Runtime
  document guidance remains under `cloudflare/src/skills/docs/`.

No historical audit or roadmap was retained solely as proof of prior review.
Ordinary change history remains in Git and regression tests.
