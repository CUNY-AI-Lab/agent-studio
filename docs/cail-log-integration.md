# CAIL operational event alignment

Status: source-ready; no deployment or live production configuration changes
Reviewed dependency: `@cuny-ai-lab/cail-log` commit `862067d3ac83d0cde456eb38d3a6bad6df0476e5`
Fleet product: `agent-studio`

## Final source design

The load-bearing unit is the canonical request/action/model-call lifecycle: it
is consumed by fleet dashboards, incident investigation, user-level diagnostic
joins, and gateway correlation. The contract stays small and catalog-owned.
Studio adds only fixed route dimensions and pre-admission denial events that it
can determine authoritatively.

Source defaults and failure semantics are now explicit:

- Wrangler disables native invocation logs because they contain raw request
  URLs and platform request/response metadata. Studio custom logs remain
  enabled through `observability.enabled` and the explicit Workers structured
  sink. This source change affects a deployment only when separately deployed.
- `service.version` comes from Cloudflare's immutable
  `CF_VERSION_METADATA.id`; no manually maintained release variable remains.
- `CAIL_LOG_ENV` is required and must be one of the cail-log environment
  values. Environment classification is a CAIL deployment-policy input and is
  not inferred from a hostname, branch, or version tag.
- Health returns 503 when either telemetry resource field is unavailable. The
  logging adapter itself returns no logger for invalid resource configuration,
  so a health check and its error path cannot throw while trying to report the
  telemetry failure.
- Action admission begins only after prechecks pass. A canonical terminal event
  is never emitted without its matching admission. An admission without a
  terminal means the process/framework was interrupted before an observable
  machine terminal; dashboards treat that as incomplete work, not success.
- Terminal events are the dashboard source. Studio does not emit duplicate
  aggregate events or counters, avoiding double counting and another delivery
  path.

## Identity and ownership

- `service.name = agent-studio` identifies the emitting Worker and Durable Object code.
- Every Studio event requires `cail.product.id = agent-studio`.
- `cail.kale.project.name` is never set. Agent Studio is not a Kale tenant project.
- Identified users appear only as the verified CAIL pseudonym (`cail-` plus 32 lowercase hexadecimal characters). Anonymous and pre-admission paths use an atomic `{ type: "anonymous" }` principal.
- The CAIL gateway owns model tokens, cost, quota charging, and authoritative per-user spend. Studio records per-step model-call success and latency, but never duplicates tokens, cost, quota state, or spend.
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

Cloudflare Query Builder can filter, group, count, and aggregate numeric custom
log fields. The canonical terminals therefore support these directly:

| View | Filter | Group by | Measures |
|---|---|---|---|
| Studio workflow success and latency | `event.name = cail.action.terminal` and `cail.product.id = agent-studio` | `url.template`, `cail.outcome`, `service.version`, `deployment.environment.name` | count; average/min/max `cail.operation.duration_ms` |
| Model-call success and latency | `event.name = cail.model.call.terminal` and `cail.product.id = agent-studio` | `gen_ai.provider.name`, `gen_ai.request.model`, `cail.outcome`, `service.version` | count; average/min/max `cail.operation.duration_ms` |
| User-level diagnostic slice | either terminal filter plus a specific approved `enduser.pseudo.id` | route/model and outcome | count and latency; never spend |
| Incomplete lifecycle quality | compare distinct action/call IDs on admitted events with matching terminal IDs over a window longer than the workflow timeout | route/model and `service.version` | admission-terminal difference |

The fixed chat route is `/agents/{agent}/{name}` and the fixed code route is
`/api/workspaces/{id}/runtime/execute`. Neither includes a workspace, session,
file, prompt, or user-supplied value. The gateway remains the only source for
token, cost, quota, and spend rollups.

## Standards and vendor review

The following sources changed or confirmed the implementation:

- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (updated 2026-06-09) recommends logging structured objects, indexes their fields, and documents a 256 KB event limit. `workersStructuredSink` is therefore the explicit sink; Studio does not stringify portable records inside Workers.
- The same Workers Logs documentation says invocation logs include request URL and response metadata and can be disabled independently. Wrangler now sets `invocation_logs: false`, retaining only Studio's bounded custom records after a future separately authorized deployment.
- [Cloudflare Version Metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) (updated 2026-07-03) explicitly supports aggregating analytics by Worker version. Its immutable version ID now supplies `service.version`.
- [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) (updated 2026-04-23) supports filters, grouping, counts, and numeric min/max/average/sum. That makes the canonical terminal records dashboard-ready without duplicate rollup events.
- [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) (updated 2026-07-05) can export logs and traces to OTLP destinations, but is beta and provider/pricing specific. No exporter, destination, sampling rate, or persistence setting is added here.
- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) is stable and keeps resource identity, event name, body, trace context, severity, and attributes distinct. The `cail-log` portable record preserves that separation; the Workers sink is only a projection.
- [OpenTelemetry semantic conventions 1.43.0](https://opentelemetry.io/docs/specs/semconv/) remain mixed-stability; HTTP duration is stable while `url.template` and GenAI conventions continue to evolve. Studio uses bounded route templates and the reviewed cail-log field contract rather than chasing provider-specific metric names. Official AI SDK documentation defines each agentic step as one LLM call, so Studio emits a separate call lifecycle per step. `provider=cail` states the client instrumentation's best-known intermediary; Studio does not invent the underlying hosted provider or response model.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) requires valid complete context and a new parent identifier for each outgoing operation. HTTP boundaries adopt a valid trace and mint a local span; each model-proxy fetch now mints a child span while preserving trace ID, flags, tracestate, and the fleet request UUID.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) recommends excluding access tokens, session identifiers, sensitive personal data, file paths, and higher-classification data, and testing logging failures. The catalog has no prompt, message, header, JWT, session, workspace, filename, URL, exception-text, or arbitrary-attribute channel; runtime canary tests exercise that boundary.
- [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) and [event callbacks](https://ai-sdk.dev/docs/ai-sdk-core/event-listeners) define step start as immediately before one LLM call and `onStepFinish` as its completion. `experimental_onStepStart` is explicitly unstable in patch releases, so its use is isolated and covered by compile/runtime tests.
- [Cloudflare Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) (updated 2026-06-26) confirms automatic SQLite persistence and resumable streams. [Autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/) (updated 2026-06-03) states that messages are persisted before `onChatResponse`; the repository's pinned package source confirms the exact callback order.

## Deployment items intentionally not changed

- No deploy, binding, secret, ingress, spending, sampling, retention, Logpush, OTLP destination, or persistent production-state change.
- `CAIL_LOG_ENV` remains the sole logging policy value: the deployment owner must choose `production`, `staging`, `development`, or `test`. Missing/invalid values fail health rather than being guessed. `CF_VERSION_METADATA` is source-bound and requires no chosen value.
- Retention, access, sampling, Workers Logpush, and any OTLP destination remain deployment policy. Source does not set or change them.
- Cloudflare OTLP export is beta and is not treated as a required collector or durable delivery guarantee.

There is no reviewed-commit dependency blocker: the immutable dependency pin is the merged commit above.
