import { REQUEST_ID_RE, type CailOutcome } from '@cuny-ai-lab/cail-log';
import { LOG_PRODUCT, STUDIO_ACTION_ROUTES } from './logging';

export const STUDIO_RELIABILITY_SCHEMA_VERSION = 1 as const;
export const STUDIO_RELIABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STUDIO_ACTION_GRACE_MS = 30 * 60 * 1000;
export const STUDIO_MODEL_CALL_GRACE_MS = 10 * 60 * 1000;

export type StudioActionRoute = (typeof STUDIO_ACTION_ROUTES)[keyof typeof STUDIO_ACTION_ROUTES];

export interface StudioSqlCursor {
  toArray(): Record<string, unknown>[];
}

export interface StudioSqlStorage {
  exec(query: string, ...bindings: unknown[]): StudioSqlCursor;
}

export interface StudioReliabilityMetrics {
  admitted: number;
  terminal: number;
  success: number;
  failure: number;
  excluded: number;
  incomplete: number;
  duplicate_admissions: number;
  duplicate_terminals: number;
  orphan_terminals: number;
}

export interface StudioRouteReliabilityMetrics extends StudioReliabilityMetrics {
  route: StudioActionRoute;
  route_mismatches: number;
}

export interface StudioModelCallReliabilityMetrics extends StudioReliabilityMetrics {
  action_mismatches: number;
}

export interface StudioReliabilityAdminRead {
  schema_version: typeof STUDIO_RELIABILITY_SCHEMA_VERSION;
  product_id: typeof LOG_PRODUCT;
  authority: 'durable_product_state';
  scope: 'workspace_agent';
  window: { from_ms: number; to_ms: number; duration_ms: typeof STUDIO_RELIABILITY_WINDOW_MS };
  routes: StudioRouteReliabilityMetrics[];
  model_calls: StudioModelCallReliabilityMetrics;
  contains_user_identifiers: false;
}

const OUTCOMES = new Set<CailOutcome>([
  'ok',
  'client_error',
  'error',
  'denied',
  'cancelled',
  'timeout',
  'outcome_unknown',
]);
const FAILURE_OUTCOMES = new Set<CailOutcome>(['error', 'timeout', 'outcome_unknown']);
const EXCLUDED_OUTCOMES = new Set<CailOutcome>(['client_error', 'denied', 'cancelled']);
const ROUTES = new Set<string>(Object.values(STUDIO_ACTION_ROUTES));

export function initializeStudioReliability(sql: StudioSqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS studio_action_lifecycle_events_v1 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('admitted', 'terminal')),
      route TEXT NOT NULL CHECK (route IN ('/agents/{agent}/{name}', '/api/workspaces/{id}/runtime/execute')),
      event_at_ms INTEGER NOT NULL CHECK (event_at_ms >= 0),
      outcome TEXT CHECK (outcome IN ('ok', 'client_error', 'error', 'denied', 'cancelled', 'timeout', 'outcome_unknown')),
      CHECK ((phase = 'admitted' AND outcome IS NULL) OR (phase = 'terminal' AND outcome IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS studio_action_lifecycle_id_v1
      ON studio_action_lifecycle_events_v1(action_id, event_at_ms);
    CREATE INDEX IF NOT EXISTS studio_action_lifecycle_time_v1
      ON studio_action_lifecycle_events_v1(event_at_ms);

    CREATE TABLE IF NOT EXISTS studio_model_call_lifecycle_events_v1 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('admitted', 'terminal')),
      event_at_ms INTEGER NOT NULL CHECK (event_at_ms >= 0),
      outcome TEXT CHECK (outcome IN ('ok', 'client_error', 'error', 'denied', 'cancelled', 'timeout', 'outcome_unknown')),
      CHECK ((phase = 'admitted' AND outcome IS NULL) OR (phase = 'terminal' AND outcome IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS studio_model_call_lifecycle_id_v1
      ON studio_model_call_lifecycle_events_v1(call_id, event_at_ms);
    CREATE INDEX IF NOT EXISTS studio_model_call_lifecycle_time_v1
      ON studio_model_call_lifecycle_events_v1(event_at_ms);
  `);
}

function assertId(value: string, label: string): void {
  if (!REQUEST_ID_RE.test(value)) throw new TypeError(`Studio reliability ${label} must be a UUID v4`);
}

function assertRoute(value: string): asserts value is StudioActionRoute {
  if (!ROUTES.has(value)) throw new TypeError('Studio reliability route is not recognized');
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Studio reliability timestamp must be a nonnegative safe integer');
  }
}

function assertOutcome(value: string): asserts value is CailOutcome {
  if (!OUTCOMES.has(value as CailOutcome)) throw new TypeError('Studio reliability outcome is not recognized');
}

export function recordStudioActionAdmission(
  sql: StudioSqlStorage,
  input: { actionId: string; route: string; atMs: number },
): void {
  assertId(input.actionId, 'action id');
  assertRoute(input.route);
  assertTimestamp(input.atMs);
  sql.exec(
    `INSERT INTO studio_action_lifecycle_events_v1
      (action_id, phase, route, event_at_ms, outcome) VALUES (?, 'admitted', ?, ?, NULL)`,
    input.actionId,
    input.route,
    input.atMs,
  );
}

export function recordStudioActionTerminal(
  sql: StudioSqlStorage,
  input: { actionId: string; route: string; atMs: number; outcome: string },
): void {
  assertId(input.actionId, 'action id');
  assertRoute(input.route);
  assertTimestamp(input.atMs);
  assertOutcome(input.outcome);
  sql.exec(
    `INSERT INTO studio_action_lifecycle_events_v1
      (action_id, phase, route, event_at_ms, outcome) VALUES (?, 'terminal', ?, ?, ?)`,
    input.actionId,
    input.route,
    input.atMs,
    input.outcome,
  );
}

export function recordStudioModelCallAdmission(
  sql: StudioSqlStorage,
  input: { callId: string; actionId: string; atMs: number },
): void {
  assertId(input.callId, 'call id');
  assertId(input.actionId, 'action id');
  assertTimestamp(input.atMs);
  sql.exec(
    `INSERT INTO studio_model_call_lifecycle_events_v1
      (call_id, action_id, phase, event_at_ms, outcome) VALUES (?, ?, 'admitted', ?, NULL)`,
    input.callId,
    input.actionId,
    input.atMs,
  );
}

export function recordStudioModelCallTerminal(
  sql: StudioSqlStorage,
  input: { callId: string; actionId: string; atMs: number; outcome: string },
): void {
  assertId(input.callId, 'call id');
  assertId(input.actionId, 'action id');
  assertTimestamp(input.atMs);
  assertOutcome(input.outcome);
  sql.exec(
    `INSERT INTO studio_model_call_lifecycle_events_v1
      (call_id, action_id, phase, event_at_ms, outcome) VALUES (?, ?, 'terminal', ?, ?)`,
    input.callId,
    input.actionId,
    input.atMs,
    input.outcome,
  );
}

interface ActionGroupRow {
  route: string;
  route_count: number;
  admissions: number;
  terminals: number;
  admitted_at_ms: number | null;
  terminal_at_ms: number | null;
  outcome: string | null;
}

interface ModelCallGroupRow {
  action_count: number;
  admissions: number;
  terminals: number;
  admitted_at_ms: number | null;
  terminal_at_ms: number | null;
  outcome: string | null;
}

function emptyMetrics(): StudioReliabilityMetrics {
  return {
    admitted: 0,
    terminal: 0,
    success: 0,
    failure: 0,
    excluded: 0,
    incomplete: 0,
    duplicate_admissions: 0,
    duplicate_terminals: 0,
    orphan_terminals: 0,
  };
}

function applyGroup(
  metrics: StudioReliabilityMetrics,
  row: { admissions: number; terminals: number; outcome: string | null },
): void {
  if (row.admissions === 0) {
    metrics.orphan_terminals += row.terminals;
    return;
  }
  metrics.admitted += 1;
  metrics.duplicate_admissions += Math.max(row.admissions - 1, 0);
  metrics.duplicate_terminals += Math.max(row.terminals - 1, 0);
  if (row.terminals === 0) {
    metrics.incomplete += 1;
    return;
  }
  metrics.terminal += 1;
  if (row.outcome === 'ok') metrics.success += 1;
  else if (FAILURE_OUTCOMES.has(row.outcome as CailOutcome)) metrics.failure += 1;
  else if (EXCLUDED_OUTCOMES.has(row.outcome as CailOutcome)) metrics.excluded += 1;
}

function assertWindow(fromMs: number, toMs: number): void {
  assertTimestamp(fromMs);
  assertTimestamp(toMs);
  if (toMs - fromMs !== STUDIO_RELIABILITY_WINDOW_MS) {
    throw new TypeError('Studio reliability window must be exactly 24 hours');
  }
}

export function readStudioReliabilityAdmin(
  sql: StudioSqlStorage,
  window: { fromMs: number; toMs: number },
): StudioReliabilityAdminRead {
  assertWindow(window.fromMs, window.toMs);
  const actionCutoff = window.toMs - STUDIO_ACTION_GRACE_MS;
  const modelCallCutoff = window.toMs - STUDIO_MODEL_CALL_GRACE_MS;

  const actionRows = sql.exec(`
    WITH grouped AS (
      SELECT
        MIN(route) AS route,
        COUNT(DISTINCT route) AS route_count,
        SUM(CASE WHEN phase = 'admitted' THEN 1 ELSE 0 END) AS admissions,
        SUM(CASE WHEN phase = 'terminal' THEN 1 ELSE 0 END) AS terminals,
        MIN(CASE WHEN phase = 'admitted' THEN event_at_ms END) AS admitted_at_ms,
        MIN(CASE WHEN phase = 'terminal' THEN event_at_ms END) AS terminal_at_ms,
        MIN(CASE WHEN phase = 'terminal' THEN outcome END) AS outcome
      FROM studio_action_lifecycle_events_v1
      WHERE event_at_ms <= ?
      GROUP BY action_id
    )
    SELECT route, route_count, admissions, terminals, admitted_at_ms, terminal_at_ms, outcome
    FROM grouped
    WHERE (admitted_at_ms BETWEEN ? AND ?)
       OR (admissions = 0 AND terminal_at_ms BETWEEN ? AND ?)
  `, window.toMs, window.fromMs, actionCutoff, window.fromMs, window.toMs)
    .toArray() as unknown as ActionGroupRow[];

  const routes = Object.values(STUDIO_ACTION_ROUTES).map((route) => ({
    route,
    ...emptyMetrics(),
    route_mismatches: 0,
  }));
  const routeMetrics = new Map(routes.map((metrics) => [metrics.route, metrics]));
  for (const row of actionRows) {
    assertRoute(row.route);
    const metrics = routeMetrics.get(row.route)!;
    applyGroup(metrics, row);
    metrics.route_mismatches += Math.max(Number(row.route_count) - 1, 0);
  }

  const modelRows = sql.exec(`
    WITH grouped AS (
      SELECT
        COUNT(DISTINCT action_id) AS action_count,
        SUM(CASE WHEN phase = 'admitted' THEN 1 ELSE 0 END) AS admissions,
        SUM(CASE WHEN phase = 'terminal' THEN 1 ELSE 0 END) AS terminals,
        MIN(CASE WHEN phase = 'admitted' THEN event_at_ms END) AS admitted_at_ms,
        MIN(CASE WHEN phase = 'terminal' THEN event_at_ms END) AS terminal_at_ms,
        MIN(CASE WHEN phase = 'terminal' THEN outcome END) AS outcome
      FROM studio_model_call_lifecycle_events_v1
      WHERE event_at_ms <= ?
      GROUP BY call_id
    )
    SELECT action_count, admissions, terminals, admitted_at_ms, terminal_at_ms, outcome
    FROM grouped
    WHERE (admitted_at_ms BETWEEN ? AND ?)
       OR (admissions = 0 AND terminal_at_ms BETWEEN ? AND ?)
  `, window.toMs, window.fromMs, modelCallCutoff, window.fromMs, window.toMs)
    .toArray() as unknown as ModelCallGroupRow[];
  const model_calls: StudioModelCallReliabilityMetrics = {
    ...emptyMetrics(),
    action_mismatches: 0,
  };
  for (const row of modelRows) {
    applyGroup(model_calls, row);
    model_calls.action_mismatches += Math.max(Number(row.action_count) - 1, 0);
  }

  return {
    schema_version: STUDIO_RELIABILITY_SCHEMA_VERSION,
    product_id: LOG_PRODUCT,
    authority: 'durable_product_state',
    scope: 'workspace_agent',
    window: {
      from_ms: window.fromMs,
      to_ms: window.toMs,
      duration_ms: STUDIO_RELIABILITY_WINDOW_MS,
    },
    routes,
    model_calls,
    contains_user_identifiers: false,
  };
}
