import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAIL_ANALYTICS_ENGINE_DATASET, STUDIO_ACTION_ROUTES } from '../src/lib/logging.ts';

const CONTRACT_URL = new URL('../../contracts/observability/agent-studio.v1.json', import.meta.url);

async function readWrangler() {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

async function readContract() {
  return JSON.parse(await readFile(CONTRACT_URL, 'utf8'));
}

async function readPackage() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

async function readWorkspaceAgentSource() {
  return readFile(new URL('../src/agent/workspace-agent.ts', import.meta.url), 'utf8');
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
  assert.equal(
    wrangler.vars.CAIL_IDENTITY_ISSUER,
    'https://tools.ailab.gc.cuny.edu/cail-sso',
  );
  assert.deepEqual(wrangler.analytics_engine_datasets, [{
    binding: 'CAIL_FLEET_EVENTS',
    dataset: CAIL_ANALYTICS_ENGINE_DATASET,
  }]);
});

test('the versioned product reliability contract fixes access, windows, and collection scope', async () => {
  const contract = await readContract();
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract_id, 'agent-studio.observability');
  assert.equal(contract.contract_version, 2);
  assert.equal(contract.product_id, 'agent-studio');
  assert.equal(contract.access.dashboard_role, 'kale_admin');
  assert.equal(contract.windows.reliability, 'rolling_24h');
  assert.equal(contract.windows.spend, 'calendar_month_to_date');
  assert.equal(contract.windows.timezone, 'America/New_York');
  assert.equal(contract.collection.backend, 'cloudflare_workers_logs');
  assert.deepEqual(contract.collection.portable_log, {
    schema_version: 2,
    subject_version: 'v1',
    event_provenance: 'same_package_logger_instance',
  });
  assert.equal(contract.collection.custom_lifecycle_sample_rate, 1);
  assert.equal(contract.collection.invocation_logs, false);
  assert.equal(contract.collection.automatic_traces, false);
  assert.deepEqual(contract.collection.external_exporters, []);
  assert.deepEqual(contract.collection.fleet_projection, {
    backend: 'cloudflare_analytics_engine',
    dataset_contract: 'cail_fleet_events_v1',
    binding: 'CAIL_FLEET_EVENTS',
    binding_declared_in_source: true,
    projection_owner: '@cuny-ai-lab/cail-log',
    sampling_index: 'deployment_environment_plus_product_id',
    query_weight: '_sample_interval',
    evidence: 'weighted_cohort_diagnostic',
    exact_lifecycle_authority: false,
    maximum_points_per_invocation: 32,
    platform_ceiling: 250,
  });
  assert.equal(contract.collection.fleet_projection.dataset_contract, CAIL_ANALYTICS_ENGINE_DATASET);
  const pkg = await readPackage();
  assert.equal(pkg.dependencies['@cuny-ai-lab/cail-log'], '^0.4.0');
  assert.equal(pkg.dependencies['@cuny-ai-lab/cail-identity'], '^4.1.0');
  assert.equal(pkg.dependencies['@cuny-ai-lab/cail-client'], '^1.2.0');
  assert.equal(pkg.dependencies['@cuny-ai-lab/cail-sandbox-client'], undefined);
});

test('action and call denominators are versioned, bounded, and suppress incomplete evidence', async () => {
  const contract = await readContract();
  for (const definition of [contract.denominators.actions, contract.denominators.model_calls]) {
    assert.equal(definition.version, 2);
    assert.equal(definition.authority, 'workspace_agent_durable_state');
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
  assert.equal(contract.coverage.authority, 'workspace_agent_durable_state');
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

test('the exact reliability read remains internal Durable Object RPC', async () => {
  const source = await readWorkspaceAgentSource();
  assert.match(source, /async getProductReliabilityAdminRead\(/);
  assert.doesNotMatch(
    source,
    /@callable\(\)\s+async getProductReliabilityAdminRead\(/,
    'the Kale-admin collector read must not be browser-callable',
  );
});

test('the initial SLO and alert recipe is complete but leaves recipients external', async () => {
  const contract = await readContract();
  assert.equal(contract.slo.window, 'rolling_24h');
  assert.equal(contract.slo.authority, 'workspace_agent_durable_state');
  assert.equal(contract.slo.target, 0.99);
  assert.equal(contract.slo.minimum_eligible_terminals, 20);
  assert.deepEqual(contract.slo.indicators, ['actions', 'model_calls']);
  assert.deepEqual(contract.slo.availability_gate, {
    minimum_lifecycle_coverage: 0.95,
    maximum_telemetry_age_seconds: 300,
  });
  assert.deepEqual(contract.accounting, {
    model: {
      authority: 'gateway_key_service_accounting',
      native_limit_usd: 10,
      agent_studio_emits_cost_or_quota: false,
    },
    sandbox: {
      authority: 'sandbox_accounting',
      agent_studio_emits_settlement_or_cost: false,
    },
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
