import assert from 'node:assert/strict';
import test from 'node:test';
import { modelErrorSignal } from '../src/lib/model-error.ts';

test('model errors do not expose raw provider exceptions or unrecognized envelopes', () => {
  assert.equal(modelErrorSignal(new Error('private upstream diagnostic')), null);
  assert.equal(modelErrorSignal(new Error('wrapper', { cause: {
    error: { code: 'unexpected_provider_code', message: 'private diagnostic', cail: {} },
  } })), null);
  assert.equal(modelErrorSignal(new Error('wrapper', { cause: {
    error: { code: 'upstream_error', message: 'unmarked provider response' },
  } })), null);
});

test('an uncertain model outcome cannot become automatically retryable', () => {
  const signal = modelErrorSignal(new Error('wrapper', { cause: {
    error: { code: 'outcome_unknown', message: 'Completion was not confirmed.', cail: { retryable: true } },
  } }));
  assert.equal(JSON.parse(signal).error.cail.retryable, false);
});
