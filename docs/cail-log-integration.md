# CAIL operational event alignment

Status: source-ready; no deployment or production configuration changes
Reviewed dependency: `@cuny-ai-lab/cail-log` commit `862067d3ac83d0cde456eb38d3a6bad6df0476e5`
Fleet product: `agent-studio`

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
| `/health` | Public configuration health | `validateAgentStudioConfig` result | `cail.request.completed`; 200 success or 503 application failure |
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
| `cail.action.admitted` | Chat after verified credential and model selection; code execution after frozen/rate/session checks | action UUID, request UUID, complete trace, product, atomic principal |
| `cail.action.terminal` | Chat only after SQLite message persistence; code execution only after executor return; explicit denial/error/cancellation paths at their machine terminal | same action/request/trace/product/principal plus atomic terminal and duration |
| `cail.model.call.admitted` | AI SDK step start immediately before the provider call | fresh call UUID, parent action/request/trace, product, principal, `provider=cail`, requested model |
| `cail.model.call.terminal` | AI SDK step finish, abort, or error | admitted-call fields, atomic terminal, duration, safe error type when non-success |
| `agent_studio.startup.config_invalid` | one-time source configuration check | product, denied terminal, closed error type |
| `agent_studio.account_import.terminal` | migration returns or fails | product, pseudonymous principal, terminal, duration, optional safe error type |
| `agent_studio.legacy_hydration.skipped` | compatibility window rejects hydration | product, denied terminal, safe error type |
| `agent_studio.download.corrupt` | an existing R2 download object fails parsing/shape validation | product, error terminal, safe error type |
| `agent_studio.credential.rejected` | workspace credential cannot bind or verify | request UUID, trace, product, atomic principal, denied terminal, safe error type |
| `agent_studio.chat.denied` | chat lacks the verified credential required by the gateway | request UUID, trace, product, atomic principal, denied terminal, safe error type |

No Studio code emits `cail.quota.charged` or `cail.sandbox.usage.settled`. There is no durable accounting acknowledgement in this service, so either event would make the diagnostic log falsely authoritative.

## Framework lifecycle seam

The installed `@cloudflare/ai-chat` 0.9.3 exposes the documented `onChatResponse` lifecycle hook, which fires only after the assistant message is persisted. Successful Studio action completion is emitted there. `streamText.onFinish` still closes model work only; treating it as workflow completion would report success before the durable acknowledgement.

`WorkspaceAgent.persistMessages` remains overridden only to report and rethrow a persistence failure. Successful persistence is not inferred from that internal write path. The public post-persistence hook owns success, and a runtime test pins that boundary. The package defaults to queued chat turns, so one pending action remains sufficient.

## Standards and vendor review

The following sources changed or confirmed the implementation:

- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (updated 2026-06-09) recommends logging structured objects, indexes their fields, and documents a 256 KB event limit. `workersStructuredSink` is therefore the explicit sink; Studio does not stringify portable records inside Workers.
- The same Workers Logs documentation says invocation logs include request URL and response metadata and can be disabled independently. The current repository has observability enabled but does not disable invocation logs. Deciding whether to disable them, and approving retention/access if they remain, is a deployment review item; this source-only task does not change Wrangler production configuration.
- [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) (updated 2026-07-05) can export logs and traces to OTLP destinations, but is beta and provider/pricing specific. No exporter, destination, sampling rate, or persistence setting is added here.
- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) is stable and keeps resource identity, event name, body, trace context, severity, and attributes distinct. The `cail-log` portable record preserves that separation; the Workers sink is only a projection.
- [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) remain under active development. Official AI SDK documentation defines each agentic step as one LLM call, so Studio emits a separate call lifecycle per step. `provider=cail` states the client instrumentation's best-known intermediary; Studio does not invent the underlying hosted provider or response model.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) requires valid complete context and a new parent identifier for each outgoing operation. HTTP boundaries adopt a valid trace and mint a local span; each model-proxy fetch now mints a child span while preserving trace ID, flags, tracestate, and the fleet request UUID.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) recommends excluding access tokens, session identifiers, sensitive personal data, file paths, and higher-classification data, and testing logging failures. The catalog has no prompt, message, header, JWT, session, workspace, filename, URL, exception-text, or arbitrary-attribute channel; runtime canary tests exercise that boundary.
- [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) and [event callbacks](https://ai-sdk.dev/docs/ai-sdk-core/event-listeners) define step start as immediately before one LLM call and `onStepFinish` as its completion. `experimental_onStepStart` is explicitly unstable in patch releases, so its use is isolated and covered by compile/runtime tests.
- [Cloudflare Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) (updated 2026-06-26) confirms automatic SQLite persistence and resumable streams. The repository's pinned package source remains the ground truth for exact callback order.

## Deployment items intentionally not changed

- No deploy, binding, secret, ingress, spending, sampling, retention, Logpush, OTLP destination, or persistent production-state change.
- `CAIL_LOG_RELEASE` and `CAIL_LOG_ENV` are source-level optional inputs. Their authoritative production values require a separate deployment change; source defaults are `0.1.0` and `development`.
- Native invocation-log privacy, retention, access, and cost need explicit approval or `invocation_logs: false` in a separate production review.
- Cloudflare OTLP export is beta and is not treated as a required collector or durable delivery guarantee.

There is no reviewed-commit dependency blocker: the immutable dependency pin is the merged commit above.
