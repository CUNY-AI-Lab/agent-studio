# CAIL operational event alignment

Status: source-ready; no deployment or live production configuration changes
Reviewed dependency: `@cuny-ai-lab/cail-log` commit `4d747988966e657ef44081e68bc95bc758713604`
Fleet product: `agent-studio`

## Final source design

The load-bearing unit is the canonical request/action/model-call lifecycle: it
is consumed by fleet dashboards, incident investigation, user-level diagnostic
joins, and gateway correlation. The contract stays small and catalog-owned.
Studio adds only fixed route dimensions and pre-admission denial events that it
can determine authoritatively.

Source defaults and failure semantics are now explicit:

- [`contracts/observability/agent-studio.v1.json`](../contracts/observability/agent-studio.v1.json)
  is the versioned source contract for collection, dashboard access, windows,
  denominators, coverage, SLOs, and the initial alert recipe.
- V2 full-samples bounded custom lifecycle logs into Workers Logs and fans the
  same accepted portable event into cail-log's `cail_fleet_events_v1`
  Analytics Engine projection. Native
  invocation logs, automatic traces, Logpush, Tail consumers, streaming Tail
  consumers, and OTLP or other external exporters are off. These source
  settings affect production only after a separately authorized deployment.
- Wrangler declares `CAIL_FLEET_EVENTS` against `cail_fleet_events_v1` using
  Cloudflare's canonical source configuration. Cloudflare creates the dataset
  automatically on the first post-deployment write; this work performed
  neither the deployment nor a live resource mutation.
- `service.version` comes from Cloudflare's immutable
  `CF_VERSION_METADATA.id`; no manually maintained release variable remains.
- `CAIL_LOG_ENV` is required deployment configuration, not an unresolved policy
  choice. The production Wrangler source fixes it to `production`; local
  development overrides it with `development`.
- Health returns 503 when either telemetry resource field is unavailable. The
  logging adapter itself returns no logger for invalid resource configuration,
  so a health check and its error path cannot throw while trying to report the
  telemetry failure.
- Action admission begins only after prechecks pass. A canonical terminal event
  is never emitted without its matching admission. An admission without a
  terminal means the process/framework was interrupted before an observable
  machine terminal; dashboards treat that as incomplete work, not success.
- Workers Logs and Analytics Engine terminal projections are diagnostic only.
  Exact action/call success and lifecycle coverage come from Studio's
  SQLite-backed WorkspaceAgent lifecycle tables and internal admin RPC.

## Identity and ownership

- `service.name = agent-studio` identifies the emitting Worker and Durable Object code.
- Every Studio event requires `cail.product.id = agent-studio`.
- `cail.kale.project.name` is never set. Agent Studio is not a Kale tenant project.
- Identified users appear only as the verified CAIL pseudonym (`cail-` plus 32 lowercase hexadecimal characters). Anonymous and pre-admission paths use an atomic `{ type: "anonymous" }` principal.
- The CAIL gateway owns model tokens, cost, quota charging, and authoritative per-user spend. Studio records per-step model-call success and latency, but never duplicates tokens, cost, quota state, or spend.
- The gateway/key service owns the native $10 model limit and all model cost.
  Sandbox accounting owns Sandbox settlement and cost. Studio emits neither.
- Logs are diagnostic projections. They are not an action ledger, spend ledger, quota authority, or sandbox settlement record.

## Workflow and boundary inventory

| Surface | User workflow or boundary | Machine acknowledgement | Operational mapping |
|---|---|---|---|
| `/health` | Public configuration and telemetry readiness | `validateAgentStudioConfig` result | `cail.request.completed` when the logger is valid; 200 success or 503 application failure |
| `/api/session` | Session and CSRF bootstrap | signed session plus CSRF cookie produced | `cail.request.completed` |
| `/api/models` | Fetch curated model catalog | proxy response validated, cached, or explicit local fallback returned | `cail.request.completed`; proxy auth/quota/application failures retain a non-success terminal fact |
| `/api/workspaces*` | List, create, load, patch, import, export, and delete workspaces | R2 write/delete, CAS update, Durable Object sync, runtime-file write/delete, or export assembly has returned | `cail.request.completed` using the matched Hono route template |
| `/api/gallery*` | List, publish, clone, unpublish, and serve gallery artifacts | gallery objects plus workspace CAS stamp are acknowledged; clone/import rollback completes before failure returns | `cail.request.completed` |
| `/api/workspaces/{id}/files*` and `/upload` | Read, write, delete, and upload files | Dynamic Worker workspace operation returns; batch upload rolls back acknowledged earlier writes on failure | `cail.request.completed` |
| `/api/workspaces/{id}/panels*` and `/layout` | Mutate canvas state | Durable Object state mutation returns | `cail.request.completed` |
| `/agents/*` WebSocket | Upgrade and CSRF/origin gate | edge/DO accepts or rejects the connection | `cail.auth.denied` for rejected upgrades; accepted transport is correlated with later action events |
| Studio chat turn | Multi-step agent workflow across model calls, tools, streaming, and SQLite | `AIChatAgent.onChatResponse` fires after the final assistant message is persisted | `cail.action.admitted` then `cail.action.terminal` |
| Each `streamText` step | One model-proxy/LLM call inside the agent loop | AI SDK `onStepFinish`, `onAbort`, or `onError` | one `cail.model.call.admitted` / `cail.model.call.terminal` pair per step |
| `executeCode` RPC | Run isolated JavaScript with host tools | Dynamic Worker executor returns after runtime effects | `cail.action.admitted` then `cail.action.terminal` |
| Legacy account import | Copy anonymous workspace state into the pseudonymous namespace | migration registry and copy/delete workflow returns | `agent_studio.account_import.terminal` |
| Legacy workspace hydration | Compatibility copy into runtime workspace | every source object is readable and written before legacy deletion | failures remain application errors; an out-of-window skip emits `agent_studio.legacy_hydration.skipped` |
| Queued downloads | Persist/list/clear generated downloads | R2 object operation returns | corrupt stored objects emit `agent_studio.download.corrupt`; keys and filenames never enter the event |

The research tools also call public or credential-brokered upstream APIs (OpenAlex, Crossref, PubMed, Primo, WorldCat, LibGuides, and guarded web fetch) and guarded Git operations. Their request content and destination URLs remain outside `cail-log`. They are not model-spend events.

## Event map

| Event | Admission or terminal point | Required correlation and attribution |
|---|---|---|
| `cail.request.completed` | Hono response boundary after handler/middleware completion | request UUID, complete trace, method, matched route template, status, product; verified user or anonymous principal |
| `cail.auth.denied` | HTTP/upgrade authentication or authorization rejection | request UUID, complete trace, method, route template, status, product, atomic principal |
| `cail.action.admitted` | Chat after verified credential and model selection; code execution after frozen/rate/session checks | action UUID, request UUID, complete trace, product, atomic principal, fixed workflow route; code also records its known POST method |
| `cail.action.terminal` | Chat only after SQLite message persistence; code execution only after executor return; explicit post-admission error/cancellation paths at their machine terminal | same action/request/trace/product/principal/route plus atomic terminal and duration |
| `cail.model.call.admitted` | AI SDK step start immediately before the provider call | fresh call UUID, parent action/request/trace, product, principal, `provider=cail`, requested model |
| `cail.model.call.terminal` | AI SDK step finish, abort, or error | admitted-call fields, atomic terminal, duration, safe error type when non-success |
| `agent_studio.startup.config_invalid` | one-time source configuration check | product, denied terminal, closed error type |
| `agent_studio.account_import.terminal` | migration returns or fails | product, pseudonymous principal, terminal, duration, optional safe error type |
| `agent_studio.legacy_hydration.skipped` | compatibility window rejects hydration | product, denied terminal, safe error type |
| `agent_studio.download.corrupt` | an existing R2 download object fails parsing/shape validation | product, error terminal, safe error type |
| `agent_studio.credential.rejected` | workspace credential cannot bind or verify | request UUID, trace, product, atomic principal, denied terminal, safe error type |
| `agent_studio.chat.denied` | chat lacks the verified credential required by the gateway | request UUID, trace, product, atomic principal, denied terminal, safe error type |
| `agent_studio.code.denied` | code execution is rate-limited before admission | request UUID, trace, product, atomic principal, fixed route/method, denied terminal, safe error type |

No Studio code emits `cail.quota.charged` or `cail.sandbox.usage.settled`. There is no durable accounting acknowledgement in this service, so either event would make the diagnostic log falsely authoritative.

## Framework lifecycle seam

The installed `@cloudflare/ai-chat` 0.9.3 exposes the documented `onChatResponse` lifecycle hook, which fires only after the assistant message is persisted. Successful Studio action completion is emitted there. `streamText.onFinish` still closes model work only; treating it as workflow completion would report success before the durable acknowledgement.

Studio does not override `persistMessages` for instrumentation. Cloudflare
documents that method as an application API for inserting messages, not as an
error lifecycle callback. The public post-persistence hook owns success, and a
runtime test pins that boundary. If persistence prevents the hook from firing,
the admitted action remains incomplete; reporting a synthetic failure from an
undocumented override would be version-sensitive and could misstate framework
recovery. The package defaults to queued chat turns, so one pending action
remains sufficient.

The AI SDK still exposes step admission only through
`experimental_onStepStart`; `onStepFinish` is stable. There is no stable
per-step-start replacement in the pinned SDK, so the experimental surface is
isolated to one callback and protected by compile/runtime coverage. Replacing
it with model middleware would add a second streaming lifecycle without
improving the contract.

## Dashboard-ready rollups

The dashboard is restricted to the Kale administrator role. Reliability uses a
rolling 24-hour window. Spend uses calendar month-to-date in
`America/New_York`, sourced from the shared gateway's accounting rather than
from Studio logs.

The v2 source contract defines both product-owned reliability indicators as
exact micro rollups over lifecycle rows in each existing SQLite-backed
WorkspaceAgent:

- Action success uses `cail.action.terminal` for the two fixed Studio action
  routes. Model-call success uses `cail.model.call.terminal` with
  `gen_ai.provider.name = cail`.
- `ok` is success. `error`, `timeout`, and `outcome_unknown` are failures.
  `client_error`, `denied`, and `cancelled` remain visible lifecycle outcomes
  but are excluded from the reliability denominator.
- Empty or undersized denominators are unavailable, never zero or green. V1
  requires 20 eligible terminals before publishing either indicator.
- Coverage pairs durable admissions and terminals by their canonical
  action/call ID.
  Actions receive a 30-minute completion grace period and model calls receive
  10 minutes. Coverage is matching single terminals divided by admissions old
  enough to have completed. The target is 100%; below 95%, stale data, orphan
  terminals, or duplicate IDs suppress the reliability result.

`getProductReliabilityAdminRead()` is internal Durable Object RPC, not an
`@callable` browser method or HTTP route. It returns exact 24-hour counts for
the two recognized action routes and model calls, including incomplete,
duplicate, orphan, and mismatched lifecycle facts. It returns no workspace,
session, user, prompt, message, code, model-cost, or Sandbox-settlement field.
An authorized Kale-admin collector must aggregate the per-object reads; this
repository does not add an admin route or service binding.

Analytics Engine is a separate weighted diagnostic view. The library-owned
projection removes the stable user pseudonym, per-event UUIDs, quota, usage,
cost, and Kale project identity. Its sampling index is
`deployment environment + product_id`, and every aggregate must weight rows by
`_sample_interval`. Even a sample interval of one does not promote it to exact
lifecycle or accounting authority.

| Diagnostic view | Filter | Group by | Weighted measures |
|---|---|---|---|
| Studio workflow trend | projected action terminals for `agent-studio` | route, outcome, service version, environment | `SUM(_sample_interval)`; weighted duration averages/quantiles |
| Model-call trend | projected model-call terminals for `agent-studio` | provider, requested model, outcome, service version | `SUM(_sample_interval)`; weighted duration averages/quantiles |
| Cohort trend | projected principal type or approved cohort | route/model and outcome | weighted count and latency; never user history or spend |

The fixed chat route is `/agents/{agent}/{name}` and the fixed code route is
`/api/workspaces/{id}/runtime/execute`. Neither includes a workspace, session,
file, prompt, or user-supplied value. The gateway remains the only source for
token, cost, quota, and spend rollups.

## Initial SLO and alert recipe

The v2 SLO target is 99% over the rolling 24-hour durable admin-read window for
both action and model-call success. The evaluator runs every five minutes and
applies coverage, freshness, and minimum-volume gates before evaluating either SLO. Two
consecutive breaches are required so a low-volume single failure does not
immediately create an alert.

The source contract defines six alert conditions: failed `/health` probes,
stale `/health` lifecycle telemetry, orphan or duplicate lifecycle IDs,
coverage below 95%, action SLO breach, and model-call SLO breach. Contract
violations alert on the first evaluation; the other operational/SLO conditions
require two consecutive evaluations and two healthy evaluations to recover.
The health recipe is an authorized HTTPS `GET /health` probe with a 10-second
timeout. Activating that probe and evaluator remains a deployment action.

Cloudflare documents neither Workers Logs saved queries nor Analytics Engine as
an exact scheduled lifecycle-join alert path. The contract therefore records
portable conditions over the durable admin read rather than treating a sampled
projection as an SLO ledger.
Notification recipients are intentionally absent from source.

## Standards and vendor review

The following sources changed or confirmed the implementation:

- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (updated 2026-06-09) recommends logging structured objects, indexes their fields, documents a 256 KB event limit, and defines a head sampling rate of `1` as 100%. `workersStructuredSink` is therefore the explicit full-sampled sink; Studio does not stringify portable records inside Workers.
- The same Workers Logs documentation says invocation logs include request URL and response metadata and can be disabled independently. Wrangler sets `invocation_logs: false`. Cloudflare can still retain platform-generated errors and uncaught exceptions; its current source configuration does not expose a switch that keeps custom logs while suppressing only those provider records.
- [Cloudflare Version Metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) (updated 2026-07-03) explicitly supports aggregating analytics by Worker version. Its immutable version ID now supplies `service.version`.
- [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) (updated 2026-04-23) supports filters, grouping, counts, distinct counts, and numeric aggregates. It does not document a scheduled join/ratio alert facility, so source defines the fleet evaluator contract and uses Query Builder for component inspection.
- [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) (updated 2026-04-23) fixes one index, twenty blobs, twenty doubles, 16 KB of blobs, and 250 points per Worker invocation. Studio uses the exported cail-log projection unchanged, caps corrupt-download diagnostics at 20 per read, and sets a 32-point structural source ceiling (the chat lifecycle maximum is 26).
- [Analytics Engine get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) (updated 2026-04-23) defines the Wrangler binding as the canonical source path and states that the dataset is created automatically on first write. Studio therefore checks in the binding declaration but leaves its activation to an authorized deployment.
- [Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) and the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) (updated 2026-04-23) require `_sample_interval` weighting and explain index-scoped adaptive sampling. That evidence made Analytics Engine cohort-only diagnostics rather than lifecycle/accounting authority.
- [Cloudflare Agents internals](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/) (current 2026-07) documents synchronous SQLite initialization in `onStart` and parameterized Agent SQL. Studio uses that stable path for its product-owned lifecycle tables.
- [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/) (updated 2026-04-21) exposes public object methods internally through bindings, while Agents `@callable` is for WebSocket clients. The exact admin read therefore remains internal RPC and has no browser decorator or HTTP route.
- [Cloudflare Traces](https://developers.cloudflare.com/workers/observability/traces/) (updated 2026-05-29) describes tracing as early beta and notes future compatibility behavior. Wrangler explicitly disables it rather than relying on a version-sensitive default.
- [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) (updated 2026-07-05) can export logs and traces to OTLP destinations, but is beta and provider/pricing specific. V1 explicitly configures no destinations and keeps all external export off.
- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) is stable and keeps resource identity, event name, body, trace context, severity, and attributes distinct. The `cail-log` portable record preserves that separation; the Workers sink is only a projection.
- [OpenTelemetry semantic conventions 1.43.0](https://opentelemetry.io/docs/specs/semconv/) remain mixed-stability; HTTP duration is stable while `url.template` and GenAI conventions continue to evolve. Studio uses bounded route templates and the reviewed cail-log field contract rather than chasing provider-specific metric names. Official AI SDK documentation defines each agentic step as one LLM call, so Studio emits a separate call lifecycle per step. `provider=cail` states the client instrumentation's best-known intermediary; Studio does not invent the underlying hosted provider or response model.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) requires valid complete context and a new parent identifier for each outgoing operation. HTTP boundaries adopt a valid trace and mint a local span; each model-proxy fetch now mints a child span while preserving trace ID, flags, tracestate, and the fleet request UUID.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) recommends excluding access tokens, session identifiers, sensitive personal data, file paths, and higher-classification data, and testing logging failures. The catalog has no prompt, message, header, JWT, session, workspace, filename, URL, exception-text, or arbitrary-attribute channel; runtime canary tests exercise that boundary.
- [Google SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) recommends burn-rate alerting for sufficiently busy services and warns that low request rates make individual failures disproportionately noisy. The initial recipe therefore gates on 20 eligible terminals and two consecutive evaluations; it does not claim high-traffic multi-window burn-rate precision at Studio's current volume.
- [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) and [event callbacks](https://ai-sdk.dev/docs/ai-sdk-core/event-listeners) define step start as immediately before one LLM call and `onStepFinish` as its completion. `experimental_onStepStart` is explicitly unstable in patch releases, so its use is isolated and covered by compile/runtime tests.
- [Cloudflare Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) (updated 2026-06-26) confirms automatic SQLite persistence and resumable streams. [Autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/) (updated 2026-06-03) states that messages are persisted before `onChatResponse`; the repository's pinned package source confirms the exact callback order.

## Remaining deployment and institutional inputs

Only the following remain unresolved outside source:

- actual notification recipients;
- institution-approved retention and deletion requirements within Cloudflare's
  plan limits;
- production secrets; and
- provisioning the authorized Kale-admin collector's private binding and
  WorkspaceAgent inventory needed to aggregate per-object exact reads; and
- authorization to deploy and activate the bindings, health probe, evaluator,
  dashboard, and source configuration.

Dashboard access, production environment classification, full sampling,
invocation-log suppression, exporter suppression, reliability/spend windows,
denominators, coverage, and the initial SLO/alert recipe are closed source
decisions. This work did not deploy, alter a binding or secret, activate a
probe or exporter, create a dataset, change retention, or mutate production state.

There is no reviewed-commit dependency blocker: the immutable dependency pin is the merged commit above.
