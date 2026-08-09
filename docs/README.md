# Documentation map

These are the maintained guides for the Agent Studio repository.

| Path | Purpose |
| --- | --- |
| [`../README.md`](../README.md) | Setup, architecture, validation, staging smoke, and deploy command. |
| [`security-and-operations.md`](./security-and-operations.md) | Current identity, storage, content, tool, validation, and staging operations contract. |
| [`legacy-account-import.md`](./legacy-account-import.md) | The one-time first-login import for a verified legacy session. |
| [`../cloudflare/README.md`](../cloudflare/README.md) | Worker package setup, bindings, local run, and direct staging deploy. |
| [`../AGENTS.md`](../AGENTS.md) | Repository invariants and workflow for agents and contributors. |
| [`../ACCESSIBILITY.md`](../ACCESSIBILITY.md) | Keyboard, ARIA, and current accessibility decisions. |
| [`../CANVAS-DESIGN.md`](../CANVAS-DESIGN.md) | Canvas vocabulary and interaction model. |

Runtime skill instructions live under `cloudflare/src/skills/docs/` and are
generated into `cloudflare/src/skills/docs.generated.ts`; edit the Markdown
sources and run the existing build script when they change.

The `.github/workflows/ci.yml` file is the executable CI contract. It runs one
validation job with the repository checks and a clearly labeled local Worker
process integration smoke. The smoke is not an end-to-end claim and never
prints identity or workspace values.

Git history is the change record; the current first-login import behavior is
described only in [legacy-account-import.md](./legacy-account-import.md).
