/** Privacy-constrained operational events for Agent Studio. */
import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createCailLogger,
  extendCailEventCatalog,
  outboundCorrelationHeaders,
  workersStructuredSink,
  type CailCorrelation,
  type CailHttpMethod,
  type CailLogEnvironment,
  type CailLogSink,
  type CailLogger,
  type CailPrincipalFields,
  type CailTerminalFields,
  type CailTraceFields,
} from '@cuny-ai-lab/cail-log';

export { CAIL_EVENTS, correlationFromHeaders, outboundCorrelationHeaders };
export type { CailCorrelation, CailPrincipalFields, CailTerminalFields, CailTraceFields };

export const LOG_SERVICE = 'agent-studio';
export const LOG_PRODUCT = 'agent-studio';
export const LOG_PROVIDER = 'cail';
const DEFAULT_RELEASE = '0.1.0';

export const STUDIO_EVENTS = Object.freeze({
  STARTUP_CONFIG_INVALID: 'agent_studio.startup.config_invalid',
  ACCOUNT_IMPORT_TERMINAL: 'agent_studio.account_import.terminal',
  LEGACY_HYDRATION_SKIPPED: 'agent_studio.legacy_hydration.skipped',
  DOWNLOAD_CORRUPT: 'agent_studio.download.corrupt',
  CREDENTIAL_REJECTED: 'agent_studio.credential.rejected',
  CHAT_DENIED: 'agent_studio.chat.denied',
} as const);

export const STUDIO_EVENT_CATALOG = extendCailEventCatalog({
  [STUDIO_EVENTS.STARTUP_CONFIG_INVALID]: {
    body: 'Agent Studio configuration was rejected.',
    source: 'platform',
    severity: 'outcome',
    required: ['product_id', 'terminal', 'error_type'],
    optional: [],
    outcomes: ['denied'],
    terminal_reasons: ['denied'],
  },
  [STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL]: {
    body: 'Legacy account import reached a terminal state.',
    source: 'platform',
    severity: 'outcome',
    required: ['product_id', 'principal', 'terminal', 'duration_ms'],
    optional: ['error_type'],
  },
  [STUDIO_EVENTS.LEGACY_HYDRATION_SKIPPED]: {
    body: 'Legacy workspace hydration was skipped.',
    source: 'platform',
    severity: 'outcome',
    required: ['product_id', 'terminal', 'error_type'],
    optional: [],
    outcomes: ['denied'],
    terminal_reasons: ['denied'],
  },
  [STUDIO_EVENTS.DOWNLOAD_CORRUPT]: {
    body: 'A corrupt queued download was detected.',
    source: 'platform',
    severity: 'outcome',
    required: ['product_id', 'terminal', 'error_type'],
    optional: [],
    outcomes: ['error'],
    terminal_reasons: ['application_failure'],
  },
  [STUDIO_EVENTS.CREDENTIAL_REJECTED]: {
    body: 'A workspace credential was rejected.',
    source: 'platform',
    severity: 'outcome',
    required: ['product_id', 'principal', 'terminal', 'error_type'],
    optional: ['request_id', 'trace'],
    outcomes: ['denied'],
    terminal_reasons: ['denied'],
  },
  [STUDIO_EVENTS.CHAT_DENIED]: {
    body: 'A Studio chat turn was denied before admission.',
    source: 'platform',
    severity: 'outcome',
    required: ['request_id', 'product_id', 'principal', 'trace', 'terminal', 'error_type'],
    optional: [],
    outcomes: ['denied'],
    terminal_reasons: ['denied'],
  },
} as const);

export type StudioLogger = CailLogger<typeof STUDIO_EVENT_CATALOG, 'platform'>;

export interface StudioLogRuntime {
  CAIL_LOG_RELEASE?: string;
  CAIL_LOG_ENV?: CailLogEnvironment;
}

export interface CreateStudioLoggerOptions {
  sink?: CailLogSink;
  release?: string;
  env?: CailLogEnvironment;
}

export function createStudioLogger(options: CreateStudioLoggerOptions = {}): StudioLogger {
  return createCailLogger({
    service: LOG_SERVICE,
    release: options.release ?? DEFAULT_RELEASE,
    env: options.env ?? 'test',
    sourceClass: 'platform',
    catalog: STUDIO_EVENT_CATALOG,
    sink: options.sink ?? workersStructuredSink,
  });
}

const runtimeLoggers = new WeakMap<object, StudioLogger>();
let developmentLogger: StudioLogger | undefined;

export function studioLogger(runtime?: StudioLogRuntime): StudioLogger {
  if (!runtime) {
    developmentLogger ??= createStudioLogger({ env: 'development' });
    return developmentLogger;
  }
  const key = runtime as object;
  let logger = runtimeLoggers.get(key);
  if (!logger) {
    logger = createStudioLogger({
      release: runtime.CAIL_LOG_RELEASE ?? DEFAULT_RELEASE,
      env: runtime.CAIL_LOG_ENV ?? 'development',
    });
    runtimeLoggers.set(key, logger);
  }
  return logger;
}

export function principalForSubject(subject?: string | null): CailPrincipalFields {
  return subject && /^cail-[0-9a-f]{32}$/.test(subject)
    ? { type: 'user', subject }
    : { type: 'anonymous' };
}

export function traceFromCorrelation(correlation: CailCorrelation): CailTraceFields {
  return {
    trace_id: correlation.trace_id,
    span_id: correlation.span_id,
    trace_flags: correlation.trace_flags,
  };
}

/** Non-HTTP work always mints a UUID request id; UI request labels are not trusted ids. */
export function mintCorrelation(): CailCorrelation {
  return correlationFromHeaders({ get: () => null });
}

export function normalizeRouteTemplate(route: string): string {
  if (route === 'unmatched') return '/unmatched';
  const normalized = route
    .replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')
    .replace(/\/$/, '')
    .replace(/\/\*$/, '/{path}') || '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function terminalForRequest(status: number, errorType?: string): CailTerminalFields {
  if (status === 408 || status === 504) return { outcome: 'timeout', reason: 'timeout' };
  if (status === 429 || errorType === 'quota_exceeded') {
    return { outcome: 'denied', reason: 'quota_blocked' };
  }
  if (status === 401 || status === 403) return { outcome: 'denied', reason: 'denied' };
  if (status >= 500) {
    return {
      outcome: 'error',
      reason: errorType?.startsWith('upstream_') ? 'upstream_failure' : 'application_failure',
    };
  }
  if (status >= 400) return { outcome: 'client_error', reason: 'client_error' };
  return { outcome: 'ok', reason: 'completed' };
}

function normalizeHttpMethod(method: string): CailHttpMethod {
  const upper = method.toUpperCase();
  return ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'].includes(upper)
    ? upper as CailHttpMethod
    : '_OTHER';
}

export interface BoundaryEvent {
  correlation: CailCorrelation;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  subject?: string;
  errorType?: string;
}

export function logBoundaryEvent(log: StudioLogger, input: BoundaryEvent): void {
  const principal = principalForSubject(input.subject);
  const trace = traceFromCorrelation(input.correlation);
  const route = normalizeRouteTemplate(input.route);
  const terminal = terminalForRequest(input.status, input.errorType);
  const http_method = normalizeHttpMethod(input.method);

  if (terminal.outcome === 'denied' && terminal.reason === 'denied') {
    log.emit(CAIL_EVENTS.AUTH_DENIED, {
      request_id: input.correlation.request_id,
      product_id: LOG_PRODUCT,
      principal,
      http_method,
      route,
      status: input.status,
      terminal,
      trace,
      ...(input.errorType ? { error_type: input.errorType } : {}),
    });
    return;
  }

  const fields = {
    request_id: input.correlation.request_id,
    product_id: LOG_PRODUCT,
    http_method,
    route,
    status: input.status,
    terminal,
    duration_ms: input.durationMs,
    trace,
    principal,
  };
  if (terminal.outcome === 'ok') {
    log.emit(CAIL_EVENTS.REQUEST_COMPLETED, { ...fields, terminal });
  } else {
    log.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
      ...fields,
      terminal,
      ...(input.errorType ? { error_type: input.errorType } : {}),
    });
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function withOutboundCorrelation(fetcher: FetchLike, correlation: CailCorrelation): FetchLike {
  return (input, init) => {
    // W3C Trace Context gives each outbound operation a new parent-id while
    // preserving the trace, flags, tracestate, and fleet request id.
    const parentHeaders = outboundCorrelationHeaders(correlation);
    const child = correlationFromHeaders({
      get(name: string) {
        const lower = name.toLowerCase();
        if (lower === 'traceparent') return parentHeaders.traceparent ?? null;
        if (lower === 'tracestate') return correlation.tracestate ?? null;
        if (lower === 'x-cail-request-id') return correlation.request_id;
        return null;
      },
    });
    const correlationHeaders = outboundCorrelationHeaders(child);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(correlationHeaders)) headers.set(name, value);
    return fetcher(input, { ...init, headers });
  };
}
