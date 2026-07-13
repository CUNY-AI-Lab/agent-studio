import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ACTION_ROUTES } from '../src/lib/logging.ts';

const CONTRACT_URL = new URL('../../contracts/observability/agent-studio.v1.json', import.meta.url);

async function readWrangler() {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

async function readContract() {
  return JSON.parse(await readFile(CONTRACT_URL, 'utf8'));
}

test('Wrangler source defaults suppress content-bearing invocation logs and bind version metadata', async () => {
  const wrangler = await readWrangler();
  assert.equal(wrangler.observability.enabled, true);
  assert.deepEqual(wrangler.observability.logs, {
    enabled: true,
    head_sampling_rate: 1,
    invocation_logs: false,
    persist: true,
    destinations: [],
  });
  assert.deepEqual(wrangler.observability.traces, {
    enabled: false,
    head_sampling_rate: 0,
    persist: false,
    destinations: [],
  });
  assert.equal(wrangler.logpush, false);
  assert.deepEqual(wrangler.tail_consumers, []);
  assert.deepEqual(wrangler.streaming_tail_consumers, []);
  assert.deepEqual(wrangler.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.equal(wrangler.vars.CAIL_LOG_ENV, 'production');
});

test('the versioned product reliability contract fixes access, windows, and collection scope', async () => {
  const contract = await readContract();
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract_id, 'agent-studio.observability');
  assert.equal(contract.contract_version, 1);
  assert.equal(contract.product_id, 'agent-studio');
  assert.equal(contract.access.dashboard_role, 'kale_admin');
  assert.equal(contract.windows.reliability, 'rolling_24h');
  assert.equal(contract.windows.spend, 'calendar_month_to_date');
  assert.equal(contract.windows.timezone, 'America/New_York');
  assert.equal(contract.collection.backend, 'cloudflare_workers_logs');
  assert.equal(contract.collection.custom_lifecycle_sample_rate, 1);
  assert.equal(contract.collection.invocation_logs, false);
  assert.equal(contract.collection.automatic_traces, false);
  assert.deepEqual(contract.collection.external_exporters, []);
});

test('action and call denominators are versioned, bounded, and suppress incomplete evidence', async () => {
  const contract = await readContract();
  for (const definition of [contract.denominators.actions, contract.denominators.model_calls]) {
    assert.equal(definition.version, 1);
    assert.equal(definition.rollup, 'micro');
    assert.deepEqual(definition.success_outcomes, ['ok']);
    assert.deepEqual(definition.failure_outcomes, ['error', 'timeout', 'outcome_unknown']);
    assert.deepEqual(definition.excluded_outcomes, ['client_error', 'denied', 'cancelled']);
    assert.equal(definition.empty_denominator, 'unavailable');
    assert.equal(definition.denominator_population, 'distinct_eligible_terminal_ids');
    assert.equal(definition.success_numerator, 'distinct_success_terminal_ids');
  }
  assert.deepEqual(contract.denominators.actions.routes, [
    '/agents/{agent}/{name}',
    '/api/workspaces/{id}/runtime/execute',
  ]);
  assert.deepEqual(contract.denominators.actions.routes, Object.values(STUDIO_ACTION_ROUTES));
  assert.equal(contract.coverage.target, 1);
  assert.equal(contract.coverage.minimum_publishable, 0.95);
  assert.equal(contract.coverage.freshness_deadline_seconds, 300);
  assert.equal(contract.coverage.on_failure, 'suppress_reliability');
  assert.equal(contract.coverage.orphan_terminals_allowed, 0);
  assert.equal(contract.coverage.duplicate_ids_allowed, 0);
  assert.equal(contract.coverage.numerator_population, 'distinct_admission_ids_with_exactly_one_terminal');
  assert.equal(contract.coverage.denominator_population, 'distinct_admission_ids_older_than_grace');
  assert.equal(contract.coverage.admission_terminal_pairing.actions.grace_seconds, 1800);
  assert.equal(contract.coverage.admission_terminal_pairing.model_calls.grace_seconds, 600);
  assert.equal(contract.coverage.admission_terminal_pairing.actions.id_field, 'cail.action.id');
  assert.equal(contract.coverage.admission_terminal_pairing.model_calls.id_field, 'cail.call.id');
});

test('the initial SLO and alert recipe is complete but leaves recipients external', async () => {
  const contract = await readContract();
  assert.equal(contract.slo.window, 'rolling_24h');
  assert.equal(contract.slo.target, 0.99);
  assert.equal(contract.slo.minimum_eligible_terminals, 20);
  assert.deepEqual(contract.slo.indicators, ['actions', 'model_calls']);
  assert.deepEqual(contract.slo.availability_gate, {
    minimum_lifecycle_coverage: 0.95,
    maximum_telemetry_age_seconds: 300,
  });
  assert.equal(contract.alerts.evaluation_interval_seconds, 300);
  assert.equal('recipients' in contract.alerts, false);
  assert.deepEqual(contract.alerts.rules.map((rule) => rule.id), [
    'agent-studio.health.failed',
    'agent-studio.telemetry.stale',
    'agent-studio.lifecycle.contract_violation',
    'agent-studio.lifecycle.coverage_below_minimum',
    'agent-studio.action.slo_breach',
    'agent-studio.model_call.slo_breach',
  ]);
  for (const rule of contract.alerts.rules) {
    assert.ok(['critical', 'high', 'medium'].includes(rule.severity));
    assert.ok(Number.isInteger(rule.consecutive_evaluations) && rule.consecutive_evaluations > 0);
    assert.ok(Number.isInteger(rule.recovery_consecutive_evaluations));
    assert.equal(typeof rule.condition, 'object');
    assert.equal(typeof rule.condition.type, 'string');
  }
  assert.deepEqual(contract.alerts.rules.slice(-2).map((rule) => rule.condition.indicator), [
    'actions',
    'model_calls',
  ]);
});
