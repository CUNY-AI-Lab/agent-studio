import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorkersLogEvent } from '@cuny-ai-lab/cail-log';

import {
  CAIL_ANALYTICS_ENGINE_BLOBS,
  CAIL_ANALYTICS_ENGINE_DOUBLES,
  CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION,
  CAIL_EVENTS,
  CAIL_LOG_SCHEMA_VERSION,
  STUDIO_ACTION_ROUTES,
  LOG_PRODUCT,
  LOG_SUBJECT_VERSION,
  STUDIO_EVENTS,
  STUDIO_MAX_FLEET_POINTS_PER_INVOCATION,
  correlationFromHeaders,
  createStudioLogger,
  logBoundaryEvent,
  mintCorrelation,
  normalizeRouteTemplate,
  principalForSubject,
  resolveStudioLogConfig,
  terminalForRequest,
  traceFromCorrelation,
  withOutboundCorrelation,
} from '../src/lib/logging.ts';

const DURABLE_SUBJECT = 'cail-0123456789abcdef0123456789abcdef';
const LOG_SUBJECT = 'cail-v1-0123456789abcdef0123456789abcdef';
const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_ID = '22222222-2222-4222-8222-222222222222';
const CALL_ID = '33333333-3333-4333-8333-333333333333';
const TRACE = { trace_id: TRACE_ID, span_id: SPAN_ID, trace_flags: 1 };
const PRINCIPAL = { type: 'user', subject: LOG_SUBJECT };

function captureLogger() {
  const events = [];
  const diagnostics = [];
  const log = createStudioLogger({
    env: 'test',
    release: 'test-revision',
    sink: (event) => events.push(event),
  });
  return { log, events, diagnostics };
}

test('HTTP success maps to canonical request completion with fleet product identity', () => {
  const { log, events } = captureLogger();
  const correlation = correlationFromHeaders(new Request('https://studio.test/api/workspaces/secret', {
    headers: {
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      'x-cail-request-id': REQUEST_ID,
    },
  }));

  logBoundaryEvent(log, {
    correlation,
    method: 'POST',
    route: '/api/workspaces/:id',
    status: 201,
    durationMs: 42,
    subject: DURABLE_SUBJECT,
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event_name, CAIL_EVENTS.REQUEST_COMPLETED);
  assert.equal(event.resource['service.name'], 'agent-studio');
  assert.equal(event.resource['service.version'], 'test-revision');
  assert.equal(event.attributes['cail.product.id'], LOG_PRODUCT);
  assert.equal(event.attributes['enduser.pseudo.id'], LOG_SUBJECT);
  assert.equal(event.schema_version, CAIL_LOG_SCHEMA_VERSION);
  assert.equal(CAIL_LOG_SCHEMA_VERSION, 2);
  assert.equal(event.attributes['url.template'], '/api/workspaces/{id}');
  assert.equal(event.attributes['cail.outcome'], 'ok');
  assert.equal(event.trace_id, TRACE_ID);
  assert.notEqual(event.span_id, SPAN_ID);
  assert.equal('cail.kale.project.name' in event.attributes, false);
});

test('HTTP denial maps to canonical auth denial with an atomic anonymous principal', () => {
  const { log, events } = captureLogger();
  logBoundaryEvent(log, {
    correlation: mintCorrelation(),
    method: 'GET',
    route: '/api/workspaces',
    status: 403,
    durationMs: 3,
    errorType: 'csrf_invalid',
  });

  assert.equal(events[0].event_name, CAIL_EVENTS.AUTH_DENIED);
  assert.equal(events[0].attributes['cail.principal.type'], 'anonymous');
  assert.equal(events[0].attributes['cail.outcome'], 'denied');
  assert.equal(events[0].attributes['error.type'], 'csrf_invalid');
});

test('request terminal mapping keeps product outcome separate from HTTP status facts', () => {
  assert.deepEqual(terminalForRequest(200), { outcome: 'ok', reason: 'completed' });
  assert.deepEqual(terminalForRequest(400), { outcome: 'client_error', reason: 'client_error' });
  assert.deepEqual(terminalForRequest(403), { outcome: 'denied', reason: 'denied' });
  assert.deepEqual(terminalForRequest(429), { outcome: 'denied', reason: 'quota_blocked' });
  assert.deepEqual(terminalForRequest(500), { outcome: 'error', reason: 'application_failure' });
  assert.deepEqual(terminalForRequest(502, 'upstream_auth_failed'), {
    outcome: 'error', reason: 'upstream_failure',
  });
  assert.deepEqual(terminalForRequest(504), { outcome: 'timeout', reason: 'timeout' });
});

test('canonical action and per-step model-call mappings compile and emit at runtime', () => {
  const { log, events } = captureLogger();
  log.emit(CAIL_EVENTS.ACTION_ADMITTED, {
    action_id: ACTION_ID, request_id: REQUEST_ID, product_id: LOG_PRODUCT,
    principal: PRINCIPAL, trace: TRACE, route: STUDIO_ACTION_ROUTES.CHAT,
  });
  log.emit(CAIL_EVENTS.MODEL_CALL_ADMITTED, {
    call_id: CALL_ID, action_id: ACTION_ID, request_id: REQUEST_ID,
    product_id: LOG_PRODUCT, principal: PRINCIPAL, provider: 'cail',
    request_model: '@cf/zai-org/glm-5.2', trace: TRACE,
  });
  log.emit(CAIL_EVENTS.MODEL_CALL_TERMINAL, {
    call_id: CALL_ID, action_id: ACTION_ID, request_id: REQUEST_ID,
    product_id: LOG_PRODUCT, principal: PRINCIPAL, provider: 'cail',
    request_model: '@cf/zai-org/glm-5.2', trace: TRACE,
    terminal: { outcome: 'ok', reason: 'completed' }, duration_ms: 18,
  });
  log.emit(CAIL_EVENTS.ACTION_TERMINAL, {
    action_id: ACTION_ID, request_id: REQUEST_ID, product_id: LOG_PRODUCT,
    principal: PRINCIPAL, trace: TRACE,
    route: STUDIO_ACTION_ROUTES.CHAT,
    terminal: { outcome: 'ok', reason: 'completed' }, duration_ms: 25,
  });

  assert.deepEqual(events.map((event) => event.event_name), [
    CAIL_EVENTS.ACTION_ADMITTED,
    CAIL_EVENTS.MODEL_CALL_ADMITTED,
    CAIL_EVENTS.MODEL_CALL_TERMINAL,
    CAIL_EVENTS.ACTION_TERMINAL,
  ]);
  const modelTerminal = events[2].attributes;
  assert.equal(modelTerminal['gen_ai.provider.name'], 'cail');
  assert.equal(modelTerminal['gen_ai.request.model'], '@cf/zai-org/glm-5.2');
  for (const spendField of [
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'cail.gen_ai.cost.micro_usd',
    'cail.quota.used',
  ]) assert.equal(spendField in modelTerminal, false, `Studio claimed gateway-owned ${spendField}`);
  assert.equal(events[0].attributes['url.template'], '/agents/{agent}/{name}');
  assert.equal(events[3].attributes['url.template'], '/agents/{agent}/{name}');
});

test('runtime log identity uses the immutable Worker version and rejects unclassified telemetry', () => {
  const points = [];
  const dataset = { writeDataPoint: (point) => points.push(point) };
  assert.deepEqual(resolveStudioLogConfig({
    CAIL_LOG_ENV: 'production',
    CAIL_FLEET_EVENTS: dataset,
    CF_VERSION_METADATA: {
      id: '44444444-4444-4444-8444-444444444444',
      tag: 'release',
      timestamp: '2026-07-13T14:00:00Z',
    },
  }), {
    env: 'production',
    release: '44444444-4444-4444-8444-444444444444',
    dataset,
  });
  assert.equal(resolveStudioLogConfig({ CAIL_LOG_ENV: 'preview' }), null);
  assert.equal(resolveStudioLogConfig({ CAIL_LOG_ENV: 'test' }), null);
  assert.equal(resolveStudioLogConfig({
    CAIL_LOG_ENV: 'test',
    CF_VERSION_METADATA: { id: '44444444-4444-4444-8444-444444444444' },
  }), null);
});

test('trusted runtime fans accepted events into the exported fleet projection without user authority', (t) => {
  const points = [];
  const workersLogs = [];
  t.mock.method(console, 'log', (record) => workersLogs.push(record));
  const log = createStudioLogger({
    env: 'production',
    release: '44444444-4444-4444-8444-444444444444',
    dataset: { writeDataPoint: (point) => points.push(point) },
  });
  log.emit(CAIL_EVENTS.ACTION_TERMINAL, {
    action_id: ACTION_ID,
    product_id: LOG_PRODUCT,
    principal: PRINCIPAL,
    route: STUDIO_ACTION_ROUTES.CHAT,
    terminal: { outcome: 'ok', reason: 'completed' },
    duration_ms: 25,
  });

  assert.equal(workersLogs.length, 1);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].indexes, ['production:agent-studio']);
  assert.equal(points[0].blobs[CAIL_ANALYTICS_ENGINE_BLOBS.route - 1], STUDIO_ACTION_ROUTES.CHAT);
  assert.equal(points[0].blobs[CAIL_ANALYTICS_ENGINE_BLOBS.outcome - 1], 'ok');
  assert.equal(points[0].doubles[CAIL_ANALYTICS_ENGINE_DOUBLES.duration_ms - 1], 25);
  assert.equal(JSON.stringify(points[0]).includes(LOG_SUBJECT), false);
  assert.equal(STUDIO_MAX_FLEET_POINTS_PER_INVOCATION, 32);
  assert.ok(STUDIO_MAX_FLEET_POINTS_PER_INVOCATION < CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION);
});

test('every Studio-local catalog mapping emits its static, content-free structure', () => {
  const { log, events } = captureLogger();
  log.emit(STUDIO_EVENTS.STARTUP_CONFIG_INVALID, {
    product_id: LOG_PRODUCT,
    terminal: { outcome: 'denied', reason: 'denied' },
    error_type: 'session_secret_missing',
  });
  log.emit(STUDIO_EVENTS.ACCOUNT_IMPORT_TERMINAL, {
    product_id: LOG_PRODUCT, principal: PRINCIPAL,
    terminal: { outcome: 'ok', reason: 'completed' }, duration_ms: 12,
  });
  log.emit(STUDIO_EVENTS.LEGACY_HYDRATION_SKIPPED, {
    product_id: LOG_PRODUCT,
    terminal: { outcome: 'denied', reason: 'denied' },
    error_type: 'legacy_hydration_window_expired',
  });
  log.emit(STUDIO_EVENTS.DOWNLOAD_CORRUPT, {
    product_id: LOG_PRODUCT,
    terminal: { outcome: 'error', reason: 'application_failure' },
    error_type: 'corrupt_download_object',
  });
  log.emit(STUDIO_EVENTS.CREDENTIAL_REJECTED, {
    request_id: REQUEST_ID, product_id: LOG_PRODUCT, principal: PRINCIPAL, trace: TRACE,
    terminal: { outcome: 'denied', reason: 'denied' }, error_type: 'invalid_credential',
  });
  log.emit(STUDIO_EVENTS.CHAT_DENIED, {
    request_id: REQUEST_ID, product_id: LOG_PRODUCT, principal: PRINCIPAL, trace: TRACE,
    terminal: { outcome: 'denied', reason: 'denied' }, error_type: 'authentication_required',
  });
  log.emit(STUDIO_EVENTS.CODE_DENIED, {
    request_id: REQUEST_ID, product_id: LOG_PRODUCT, principal: PRINCIPAL, trace: TRACE,
    route: STUDIO_ACTION_ROUTES.CODE, http_method: 'POST',
    terminal: { outcome: 'denied', reason: 'rate_limited' }, error_type: 'rate_limited',
  });
  log.emit(STUDIO_EVENTS.MODEL_CATALOG_CONTRACT_DRIFT, {
    request_id: REQUEST_ID, product_id: LOG_PRODUCT, trace: TRACE,
    terminal: { outcome: 'error', reason: 'upstream_failure' },
    error_type: 'model_catalog_schema_invalid',
  });

  assert.deepEqual(events.map((event) => event.event_name), Object.values(STUDIO_EVENTS));
  for (const event of events) {
    assert.equal(event.attributes['cail.product.id'], LOG_PRODUCT);
    assert.equal(event.body, 'Service event recorded.');
  }
});

test('content, raw identities, and arbitrary attributes cannot enter an event', () => {
  const { log, events } = captureLogger();
  const canary = 'CANARY-PII-7f3a';
  log.emit(CAIL_EVENTS.ACTION_ADMITTED, {
    action_id: ACTION_ID,
    product_id: LOG_PRODUCT,
    principal: PRINCIPAL,
    prompt: canary,
    email: `${canary}@example.edu`,
    authorization: `Bearer ${canary}`,
    filePath: `/tmp/${canary}`,
  });

  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events[0]).includes(canary), false);
  assert.equal(events[0].attributes['enduser.pseudo.id'], LOG_SUBJECT);
});

test('principal and trace helpers preserve only approved atomic facts', () => {
  assert.deepEqual(principalForSubject(DURABLE_SUBJECT), PRINCIPAL);
  assert.deepEqual(principalForSubject('raw-idp-subject'), { type: 'anonymous' });
  assert.equal(LOG_SUBJECT_VERSION, 'v1');
  const correlation = { ...TRACE, request_id: REQUEST_ID };
  assert.deepEqual(traceFromCorrelation(correlation), TRACE);
});

test('schema-2 adapters accept only events produced by this logger instance', () => {
  const { log, events } = captureLogger();
  log.emit(CAIL_EVENTS.ACTION_ADMITTED, {
    action_id: ACTION_ID,
    product_id: LOG_PRODUCT,
    principal: PRINCIPAL,
  });

  assert.equal(toWorkersLogEvent(events[0])['cail.schema.version'], 2);
  assert.throws(
    () => toWorkersLogEvent({ ...events[0] }),
    /only events produced by createCailLogger/,
  );
});

test('route normalization uses bounded templates, never raw identifiers or filenames', () => {
  assert.equal(normalizeRouteTemplate('/api/workspaces/:id/files/*'), '/api/workspaces/{id}/files/{path}');
  assert.equal(normalizeRouteTemplate('unmatched'), '/unmatched');
  assert.equal(normalizeRouteTemplate('agents/ws-upgrade'), '/agents/ws-upgrade');
  assert.equal(normalizeRouteTemplate('/'), '/');
});

test('outbound model calls preserve trace/request ids and mint a child span per fetch', async () => {
  const seen = [];
  const fetcher = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response('ok');
  };
  const correlation = { ...TRACE, request_id: REQUEST_ID, tracestate: 'vendor=value' };
  const wrapped = withOutboundCorrelation(fetcher, correlation);

  await wrapped('https://proxy.example/v1/chat/completions', {
    headers: { 'x-provider-option': 'preserved' },
  });
  await wrapped('https://proxy.example/v1/chat/completions');

  const parents = seen.map((headers) => headers.get('traceparent'));
  for (const parent of parents) {
    assert.match(parent, new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    assert.notEqual(parent.split('-')[2], SPAN_ID);
  }
  assert.notEqual(parents[0], parents[1]);
  assert.equal(seen[0].get('x-cail-request-id'), REQUEST_ID);
  assert.equal(seen[0].get('tracestate'), 'vendor=value');
  assert.equal(seen[0].get('x-provider-option'), 'preserved');
});
