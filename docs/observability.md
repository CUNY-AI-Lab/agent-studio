# Observability

Agent Studio separates diagnostic logs, exact product reliability, and shared
accounting. No one source is treated as all three.

## Authorities

| Question | Authority |
| --- | --- |
| Request and failure diagnostics | Structured Workers Logs and the bounded cail-log Analytics Engine projection |
| Exact action/model lifecycle reliability | SQLite tables inside each `WorkspaceAgent` |
| Model tokens, cost, quota, and spend | CAIL gateway/key-service accounting |
| Sandbox usage or settlement | Sandbox accounting, not Agent Studio logs |

The machine-readable collection, coverage, SLO, and alert contract is
[`contracts/observability/agent-studio.v1.json`](../contracts/observability/agent-studio.v1.json).

## Event boundaries

Every Hono request emits one `cail.request.completed` boundary event after its
response is canonicalized. Rejected WebSocket upgrades emit
`cail.auth.denied`. Route fields are fixed templates; user-supplied ids and
paths do not enter them.

Portable records use cail-log schema 2. Platform loggers declare subject
version `v1`; the identity boundary maps the existing durable
`cail-<32-lowercase-hex>` key to the log-only
`cail-v1-<32-lowercase-hex>` representation without changing session or data
ownership keys. Sinks accept only events produced by the same installed
cail-log package instance, so callers cannot forge an event-shaped object at
an adapter boundary.

Chat and code execution emit paired `cail.action.admitted` and
`cail.action.terminal` events. Each model step emits its own paired
`cail.model.call.admitted` and `cail.model.call.terminal`. Successful chat
completion occurs in `AIChatAgent.onChatResponse`, after the assistant message
is persisted. Agent Studio does not override message persistence as an
instrumentation hook.

The product-specific event catalog also includes configuration rejection,
account-import completion, skipped legacy hydration, corrupt-download
diagnostics, credential rejection, chat denial, and code rate denial. Events
carry closed error types, not exception text.

Agent Studio does not emit quota-charge, token, cost, or sandbox-settlement
events because it has no authoritative acknowledgement for them.

## Privacy

The application event schema has no field for prompts, messages, generated
code, JWTs, session or workspace ids, filenames, arbitrary destination URLs,
or raw exceptions. The fleet Analytics Engine projection also omits stable
user pseudonyms and per-event UUIDs. Exact Durable Object reads contain counts
and lifecycle integrity facts, not workspace content or identity.

Cloudflare platform-generated errors can exist outside this application
schema. Retention, provider access, exports, legal deletion, and incident
controls must cover those records separately.

## Reliability collection

`getProductReliabilityAdminRead()` is internal Durable Object RPC with no HTTP
route or browser `@callable` decorator. It returns exact rolling-window counts
for the fixed chat and code action routes and model calls, including missing,
duplicate, orphan, and mismatched lifecycle facts.

An authorized Kale-admin collector must inventory and aggregate existing
workspace objects. The source contract requires:

- a rolling 24-hour reliability window;
- micro-aggregated action and model-call results;
- `ok` as success and `error`, `timeout`, or `outcome_unknown` as failures;
- denial, cancellation, and client errors excluded from the reliability
  denominator but retained as lifecycle outcomes;
- at least 20 eligible terminals;
- at least 95% admission/terminal coverage, no duplicate ids, no orphan
  terminals, and data no older than five minutes;
- a 99% initial target evaluated every five minutes with the contract's
  consecutive-failure and recovery rules.

Analytics Engine is a weighted cohort diagnostic only. Queries must weight by
`_sample_interval`; it is not an exact lifecycle join or accounting ledger.

## Activation

Source declares full-sampled custom logs, disables content-bearing invocation
logs and automatic traces, declares the Analytics Engine binding, and exposes
the private per-object read. An authorized deployment still must provision the
collector's private binding and workspace inventory, health probe, evaluator,
dashboard access, alerts and recipients, retention, and incident procedures.
No public admin endpoint should be added for collection.
