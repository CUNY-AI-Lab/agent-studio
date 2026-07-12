import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createStudioLogger,
  logBoundaryEvent,
  mintCorrelation,
  outcomeForStatus,
  withOutboundCorrelation,
} from '../src/lib/logging.ts';

const CANARY = 'CANARY-PII-7f3a';
const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);

function captureLogger() {
  const events = [];
  const log = createStudioLogger({ sink: (event) => events.push(event) });
  return { log, events };
}

test('boundary event carries the wide-event shape with adopted correlation', () => {
  const { log, events } = captureLogger();
  const request = new Request('https://tools.example/api/workspaces/abc', {
    headers: {
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      'x-cail-request-id': 'req-from-gateway-1',
    },
  });
  const correlation = correlationFromHeaders(request);

  logBoundaryEvent(log, {
    correlation,
    method: 'POST',
    route: '/api/workspaces/:id',
    status: 200,
    durationMs: 42,
    subject: 'cail-0123abcd',
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event, CAIL_EVENTS.REQUEST_COMPLETED);
  assert.equal(event.service, 'agent-studio');
  assert.equal(event.app, 'agent-studio');
  assert.equal(event.severity_text, 'INFO');
  assert.equal(event.severity_number, 9);
  assert.equal(event.subject, 'cail-0123abcd');
  assert.equal(event.http_method, 'POST');
  assert.equal(event.route, '/api/workspaces/:id');
  assert.equal(event.status, 200);
  assert.equal(event.outcome, 'ok');
  assert.equal(event.duration_ms, 42);
  // L7 adopt-never-regenerate: gateway ids survive to the emitted event.
  assert.equal(event.trace_id, TRACE_ID);
  assert.equal(event.request_id, 'req-from-gateway-1');
  assert.match(event.span_id, /^[0-9a-f]{16}$/);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  // The message is library-derived, never caller input.
  assert.equal(event.message, 'Request completed.');
});

test('401/403 map to auth.denied at warn severity; 5xx to error severity', () => {
  const { log, events } = captureLogger();
  const correlation = mintCorrelation();

  logBoundaryEvent(log, {
    correlation,
    method: 'GET',
    route: '/api/workspaces',
    status: 401,
    durationMs: 3,
    errorCode: 'authentication_required',
  });
  logBoundaryEvent(log, {
    correlation,
    method: 'GET',
    route: '/api/workspaces',
    status: 500,
    durationMs: 5,
    errorCode: 'internal_error',
  });

  assert.equal(events[0].event, CAIL_EVENTS.AUTH_DENIED);
  assert.equal(events[0].outcome, 'denied');
  assert.equal(events[0].severity_text, 'WARN');
  assert.equal(events[0].error_code, 'authentication_required');
  assert.equal(events[1].event, CAIL_EVENTS.REQUEST_COMPLETED);
  assert.equal(events[1].outcome, 'error');
  assert.equal(events[1].severity_number, 17);
  assert.equal(events[1].error_code, 'internal_error');
});

test('outcomeForStatus covers the fleet vocabulary', () => {
  assert.equal(outcomeForStatus(200), 'ok');
  assert.equal(outcomeForStatus(304), 'ok');
  assert.equal(outcomeForStatus(400), 'client_error');
  assert.equal(outcomeForStatus(401), 'denied');
  assert.equal(outcomeForStatus(403), 'denied');
  assert.equal(outcomeForStatus(404), 'client_error');
  assert.equal(outcomeForStatus(429), 'client_error');
  assert.equal(outcomeForStatus(500), 'error');
  assert.equal(outcomeForStatus(502), 'error');
});

test('a boundary event emits ONLY allowlisted keys', () => {
  const { log, events } = captureLogger();
  logBoundaryEvent(log, {
    correlation: mintCorrelation(),
    method: 'GET',
    route: '/api/models',
    status: 200,
    durationMs: 1,
    subject: 'cail-ff00',
    model: '@cf/zai-org/glm-5.2',
    inputTokens: 10,
    outputTokens: 20,
  });

  const allowed = new Set([
    'timestamp', 'severity_text', 'severity_number', 'event', 'message',
    'service', 'release', 'env', 'subject', 'request_id', 'trace_id',
    'span_id', 'principal_type', 'key_id', 'app', 'http_method', 'route',
    'model', 'status', 'outcome', 'duration_ms', 'upstream_ms', 'error_code',
    'retry_count', 'req_bytes', 'resp_bytes', 'input_tokens', 'output_tokens',
    'quota',
  ]);
  for (const key of Object.keys(events[0])) {
    assert.ok(allowed.has(key), `unexpected key on emitted event: ${key}`);
  }
  assert.equal(events[0].input_tokens, 10);
  assert.equal(events[0].output_tokens, 20);
});

test('content/PII pushed at the logger never reaches an emitted byte', () => {
  const { log, events } = captureLogger();
  // Simulate a drifted call site smuggling content past the types (plain JS,
  // so nothing stops the keys at compile time — the runtime allowlist must).
  log.info(CAIL_EVENTS.REQUEST_COMPLETED, {
    subject: 'cail-safe',
    prompt: CANARY,
    messages: [CANARY],
    email: `${CANARY}@example.edu`,
    given_name: CANARY,
    authorization: `Bearer ${CANARY}`,
    'x-cail-identity-jwt': CANARY,
    body: { nested: CANARY },
    route: { smuggled: CANARY },
    filePath: `/tmp/${CANARY}.txt`,
  });

  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.ok(!serialized.includes(CANARY), `canary leaked: ${serialized}`);
  assert.equal(events[0].subject, 'cail-safe');
  // Through the typed API, denylisted/unknown keys never even get BUILT onto
  // the event (the allowlist table is iterated, not the argument's keys), and
  // an allowlisted key carrying the wrong shape (route as an object) is
  // dropped, never forwarded.
  for (const key of ['prompt', 'messages', 'email', 'given_name', 'authorization', 'x-cail-identity-jwt', 'body', 'filePath', 'route']) {
    assert.equal(key in events[0], false, `content key survived: ${key}`);
  }
});

test('mintCorrelation adopts a well-shaped request id and mints the rest', () => {
  const adopted = mintCorrelation('chat-turn_42.a');
  assert.equal(adopted.request_id, 'chat-turn_42.a');
  assert.match(adopted.trace_id, /^[0-9a-f]{32}$/);
  assert.match(adopted.span_id, /^[0-9a-f]{16}$/);

  const rejected = mintCorrelation(`bad id with spaces ${CANARY}`);
  assert.notEqual(rejected.request_id, `bad id with spaces ${CANARY}`);
  assert.match(rejected.request_id, /^[A-Za-z0-9._-]{1,128}$/);

  const minted = mintCorrelation();
  assert.match(minted.trace_id, /^[0-9a-f]{32}$/);
});

test('withOutboundCorrelation attaches traceparent + request id, preserving other headers', async () => {
  const seen = [];
  const fetcher = async (input, init) => {
    seen.push({ input, headers: new Headers(init?.headers), body: init?.body });
    return new Response('ok');
  };
  const correlation = { trace_id: TRACE_ID, span_id: SPAN_ID, request_id: 'req-77' };
  const wrapped = withOutboundCorrelation(fetcher, correlation);

  await wrapped('https://proxy.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"m"}',
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get('traceparent'), `00-${TRACE_ID}-${SPAN_ID}-01`);
  assert.equal(seen[0].headers.get('x-cail-request-id'), 'req-77');
  assert.equal(seen[0].headers.get('content-type'), 'application/json');
  assert.equal(seen[0].body, '{"model":"m"}');
});

test('withOutboundCorrelation fails loud on a malformed correlation', () => {
  assert.throws(
    () => withOutboundCorrelation(async () => new Response('ok'), {
      trace_id: 'not-hex',
      span_id: SPAN_ID,
      request_id: 'req-1',
    }),
    TypeError,
  );
});
