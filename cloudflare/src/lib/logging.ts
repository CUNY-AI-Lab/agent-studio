/**
 * Structured wide-event logging for Agent Studio, built on the fleet
 * primitive `@cuny-ai-lab/cail-log`.
 *
 * The fleet logging standard (2026-07-11): ONE structured JSON event per unit
 * of work, emitted on EVERY outcome, carrying only the typed safe-to-log
 * allowlist — subject HMAC (never email), correlation ids, classified route,
 * method, status, outcome, durations, stable error codes, byte/token COUNTS.
 * Chat messages, tool outputs, file contents, header values, and raw URLs are
 * structurally impossible to log: `CailLogFields` has no field for them and
 * the library drops/redacts anything smuggled past the types.
 *
 * This module keeps the agent-studio glue thin:
 *   - `studioLogger()` — the shared logger (`service: "agent-studio"`).
 *   - `logBoundaryEvent()` — the one wide event for a completed unit of work
 *     at a request boundary (HTTP route or DO op).
 *   - `mintCorrelation()` — correlation for work that does not arrive over
 *     HTTP (WebSocket chat turns, RPC ops), adopting a caller-supplied
 *     request id when it is shaped like one.
 *   - `withOutboundCorrelation()` — wraps a fetch-shaped function so
 *     downstream calls (the model proxy) carry `traceparent` +
 *     `X-CAIL-Request-Id` and one action can be followed across services.
 */

import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createCailLogger,
  outboundCorrelationHeaders,
  workersStructuredSink,
  type CailCorrelation,
  type CailLogFields,
  type CailLogger,
  type CailLogSink,
} from '@cuny-ai-lab/cail-log';

export { CAIL_EVENTS, correlationFromHeaders, outboundCorrelationHeaders };
export type { CailCorrelation, CailLogFields, CailLogger };

/** Service + X-CAIL-App slug for every event this Worker emits. */
export const LOG_SERVICE = 'agent-studio';

/**
 * Build an agent-studio logger. Workers use Cloudflare's structured console
 * sink; tests can inject a capture sink.
 */
export function createStudioLogger(options: { sink?: CailLogSink } = {}): CailLogger {
  return createCailLogger({
    service: LOG_SERVICE,
    sink: options.sink ?? workersStructuredSink,
  });
}

let sharedLogger: CailLogger | null = null;

/** The shared module-level logger. Construction is config-free, so one suffices. */
export function studioLogger(): CailLogger {
  if (!sharedLogger) {
    sharedLogger = createStudioLogger();
  }
  return sharedLogger;
}

export type BoundaryOutcome = 'ok' | 'client_error' | 'error' | 'denied';

/** Normalize an HTTP status into the fleet outcome vocabulary. */
export function outcomeForStatus(status: number): BoundaryOutcome {
  if (status === 401 || status === 403) return 'denied';
  if (status >= 500) return 'error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

export interface BoundaryEvent {
  correlation: CailCorrelation;
  /** HTTP method (or the method of the request that opened the op). */
  method: string;
  /**
   * The CLASSIFIED route label — a matched route pattern like
   * `/api/workspaces/:id` or a stable op label like `agent/chat`. Never a raw
   * URL (ids and querystrings are content, not metadata).
   */
  route: string;
  status: number;
  durationMs: number;
  /** The pseudonymous X-CAIL-Subject HMAC — never an email or session cookie. */
  subject?: string;
  /** Stable machine error code (slug), e.g. `quota_exceeded`. */
  errorCode?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Emit the ONE wide event for a completed unit of work at a request boundary.
 * `auth.denied` for 401/403; `request.completed` otherwise. Severity follows
 * the outcome so "show me failures" is `severity_number >= 17`.
 */
export function logBoundaryEvent(log: CailLogger, input: BoundaryEvent): void {
  const outcome = outcomeForStatus(input.status);
  const event = outcome === 'denied' ? CAIL_EVENTS.AUTH_DENIED : CAIL_EVENTS.REQUEST_COMPLETED;
  const level = outcome === 'error' ? 'error' : outcome === 'ok' ? 'info' : 'warn';
  const fields: CailLogFields = {
    ...input.correlation,
    app: LOG_SERVICE,
    http_method: input.method,
    route: input.route,
    status: input.status,
    outcome,
    duration_ms: input.durationMs,
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.inputTokens !== undefined ? { input_tokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { output_tokens: input.outputTokens } : {}),
  };
  log.log(level, event, fields);
}

const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Correlation for a unit of work that does not arrive over HTTP (a chat turn
 * or RPC op on the workspace DO's WebSocket). Everything is minted fresh,
 * except that a caller-supplied request id is adopted when it is shaped like
 * a fleet request id — so DO events line up with the AI SDK's per-turn
 * requestId and the DO's own observability trace.
 */
export function mintCorrelation(requestId?: string): CailCorrelation {
  const minted = correlationFromHeaders({ get: () => null });
  if (requestId && REQUEST_ID_SHAPE.test(requestId)) {
    return { ...minted, request_id: requestId };
  }
  return minted;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wrap a fetch-shaped function so every call carries the outbound correlation
 * headers (`traceparent` + `X-CAIL-Request-Id`), preserving all other init
 * headers. Used on the DO's model-proxy calls so the gateway/proxy logs join
 * to this Worker's events. Throws `TypeError` immediately on a malformed
 * correlation (never silently forks a trace).
 */
export function withOutboundCorrelation(fetcher: FetchLike, correlation: CailCorrelation): FetchLike {
  const correlationHeaders = outboundCorrelationHeaders(correlation);
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(correlationHeaders)) {
      headers.set(name, value);
    }
    return fetcher(input, { ...init, headers });
  };
}
