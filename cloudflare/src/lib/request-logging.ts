import type { Context } from 'hono';
import { matchedRoutes } from 'hono/route';
import {
  CAIL_EVENT_CATALOG,
  CAIL_EVENTS,
  CAIL_REQUEST_ID_HEADER,
  correlationFromHeaders,
  createCailLogger,
  workersStructuredSink,
  type CailCorrelation,
  type CailHttpMethod,
  type CailLogEnvironment,
  type CailLogger,
  type CailTerminalFields,
} from '@cuny-ai-lab/cail-log';
import type { Env } from '../env';

const PRODUCT_ID = 'agent-studio';
const SOURCE_SUBJECT_VERSION = 'v1';
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AgentStudioLogger = CailLogger<typeof CAIL_EVENT_CATALOG, 'platform'>;

/** Per-invocation state passed explicitly through Hono's bindings. */
export interface RequestLoggingContext {
  readonly correlation: CailCorrelation;
  logger?: AgentStudioLogger;
  readonly method: CailHttpMethod;
  readonly startedAt: number;
  route?: string;
  received: boolean;
}

export interface RequestLoggingBindings {
  requestLogging?: RequestLoggingContext;
}

type CompletionKind = 'response' | 'cancelled';

/** cail-log accepts only this closed environment vocabulary. */
export function parseLoggingEnvironment(value: string | undefined): CailLogEnvironment | undefined {
  switch (value) {
    case 'production':
    case 'staging':
    case 'development':
    case 'test':
      return value;
    default:
      return undefined;
  }
}

function releaseFor(env: Env): string {
  const candidate = env.CF_VERSION_METADATA?.id;
  return candidate && RELEASE_PATTERN.test(candidate) ? candidate : 'source';
}

export function createAgentStudioLogger(
  env: Env,
  environment: CailLogEnvironment,
): AgentStudioLogger {
  return createCailLogger({
    service: PRODUCT_ID,
    release: releaseFor(env),
    env: environment,
    sourceClass: 'platform',
    subjectVersion: SOURCE_SUBJECT_VERSION,
    catalog: CAIL_EVENT_CATALOG,
    sink: workersStructuredSink,
  });
}

function traceFor(correlation: CailCorrelation) {
  return {
    trace_id: correlation.trace_id,
    span_id: correlation.span_id,
    trace_flags: correlation.trace_flags,
  } as const;
}

/** Convert a request method into cail-log's closed HTTP vocabulary. */
export function httpMethod(method: string): CailHttpMethod {
  switch (method.toUpperCase()) {
    case 'CONNECT': return 'CONNECT';
    case 'DELETE': return 'DELETE';
    case 'GET': return 'GET';
    case 'HEAD': return 'HEAD';
    case 'OPTIONS': return 'OPTIONS';
    case 'PATCH': return 'PATCH';
    case 'POST': return 'POST';
    case 'PUT': return 'PUT';
    case 'QUERY': return 'QUERY';
    case 'TRACE': return 'TRACE';
    default: return '_OTHER';
  }
}

/**
 * Convert Hono's matched route to a bounded template. This deliberately uses
 * the router's own route table instead of maintaining a second route list.
 */
export function routeTemplateForContext(c: Context): string {
  const routes = matchedRoutes(c);
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const path = routes[index]?.path;
    if (!path || path === '*' || path === '/*') continue;
    const template = path
      .replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')
      .replace(/\*/g, '{path}');
    return template.length <= 160 ? template : '/unclassified';
  }
  return '/unclassified';
}

/** Route classes for Worker branches that do not enter Hono. */
export function routeTemplateForPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return '/';
  if (path === '/health') return '/health';
  if (path === '/api') return '/api';
  if (path.startsWith('/api/')) return '/api/{path}';
  if (path === '/agents') return '/agents';
  if (path.startsWith('/agents/')) return '/agents/{path}';
  if (path === '/assets' || path.startsWith('/assets/')) return '/assets/{path}';
  return '/unclassified';
}

export function createRequestLoggingContext(
  request: Request,
  correlation = correlationFromHeaders(request),
): RequestLoggingContext {
  return {
    correlation,
    method: httpMethod(request.method),
    startedAt: performance.now(),
    received: false,
  };
}

export function emitRequestReceived(
  context: RequestLoggingContext,
  route: string,
): void {
  if (context.received) return;
  context.route = route;
  context.received = true;
  if (!context.logger) return;
  context.logger.emit(CAIL_EVENTS.REQUEST_RECEIVED, {
    request_id: context.correlation.request_id,
    product_id: PRODUCT_ID,
    http_method: context.method,
    route,
    trace: traceFor(context.correlation),
  });
}

export function terminalForStatus(
  status: number,
  kind: CompletionKind = 'response',
): CailTerminalFields {
  if (kind === 'cancelled' || status === 499) return { outcome: 'cancelled', reason: 'cancelled' };
  if (status === 408 || status === 504) return { outcome: 'timeout', reason: 'timeout' };
  if (status === 429) return { outcome: 'denied', reason: 'rate_limited' };
  if (status === 401 || status === 403) return { outcome: 'denied', reason: 'denied' };
  if (status >= 500) return { outcome: 'error', reason: 'application_failure' };
  if (status >= 400) return { outcome: 'client_error', reason: 'client_error' };
  return { outcome: 'ok', reason: 'completed' };
}

export function completeRequestLogging(
  context: RequestLoggingContext,
  status: number,
  kind: CompletionKind = 'response',
): void {
  if (!context.received) emitRequestReceived(context, context.route ?? '/unclassified');
  if (!context.logger) return;
  const terminal = terminalForStatus(status, kind);
  const fields = {
    request_id: context.correlation.request_id,
    product_id: PRODUCT_ID,
    http_method: context.method,
    route: context.route ?? '/unclassified',
    status,
    duration_ms: Math.max(0, performance.now() - context.startedAt),
    trace: traceFor(context.correlation),
  };
  if (terminal.outcome === 'ok') {
    context.logger.emit(CAIL_EVENTS.REQUEST_COMPLETED, { ...fields, terminal });
  } else {
    context.logger.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
      ...fields,
      terminal,
      error_type: kind === 'cancelled' ? 'request_cancelled' : terminal.reason,
    });
  }
}

/**
 * Add the canonical correlation response header without reading or replacing
 * the body. A native 101 upgrade is returned unchanged because reconstructing
 * it would lose runtime-specific WebSocket state.
 */
export function withResponseCorrelation(
  response: Response,
  correlation: CailCorrelation,
): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set(CAIL_REQUEST_ID_HEADER, correlation.request_id);
  try {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export function requestIdForError(
  bindings: RequestLoggingBindings,
): string | undefined {
  return bindings.requestLogging?.correlation.request_id;
}

/** Emit only a fixed diagnostic when structured logging cannot be configured. */
export function reportLoggingConfigurationInvalid(): void {
  try {
    console.error('logging_configuration_invalid');
  } catch {
    // Diagnostics must never change the application response.
  }
}
