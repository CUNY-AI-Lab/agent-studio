import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAIL_EVENTS,
  LOG_PRODUCT,
  STUDIO_EVENTS,
  correlationFromHeaders,
  createStudioLogger,
  logBoundaryEvent,
  mintCorrelation,
  normalizeRouteTemplate,
  principalForSubject,
  terminalForRequest,
  traceFromCorrelation,
  withOutboundCorrelation,
} from '../src/lib/logging.ts';

const SUBJECT = 'cail-0123456789abcdef0123456789abcdef';
const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_ID = '22222222-2222-4222-8222-222222222222';
const CALL_ID = '33333333-3333-4333-8333-333333333333';
const TRACE = { trace_id: TRACE_ID, span_id: SPAN_ID, trace_flags: 1 };
const PRINCIPAL = { type: 'user', subject: SUBJECT };

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
    subject: SUBJECT,
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event_name, CAIL_EVENTS.REQUEST_COMPLETED);
  assert.equal(event.resource['service.name'], 'agent-studio');
  assert.equal(event.resource['service.version'], 'test-revision');
  assert.equal(event.attributes['cail.product.id'], LOG_PRODUCT);
  assert.equal(event.attributes['enduser.pseudo.id'], SUBJECT);
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
    principal: PRINCIPAL, trace: TRACE,
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

  assert.deepEqual(events.map((event) => event.event_name), Object.values(STUDIO_EVENTS));
  for (const event of events) {
    assert.equal(event.attributes['cail.product.id'], LOG_PRODUCT);
    assert.match(event.body, /^[A-Z][^\r\n]{1,158}\.$/);
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
  assert.equal(events[0].attributes['enduser.pseudo.id'], SUBJECT);
});

test('principal and trace helpers preserve only approved atomic facts', () => {
  assert.deepEqual(principalForSubject(SUBJECT), PRINCIPAL);
  assert.deepEqual(principalForSubject('raw-idp-subject'), { type: 'anonymous' });
  const correlation = { ...TRACE, request_id: REQUEST_ID };
  assert.deepEqual(traceFromCorrelation(correlation), TRACE);
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
