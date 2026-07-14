import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  STUDIO_ACTION_GRACE_MS,
  STUDIO_MODEL_CALL_GRACE_MS,
  STUDIO_RELIABILITY_SCHEMA_VERSION,
  initializeStudioReliability,
  readStudioReliabilityAdmin,
  recordStudioActionAdmission,
  recordStudioActionTerminal,
  recordStudioModelCallAdmission,
  recordStudioModelCallTerminal,
} from '../src/lib/reliability.ts';
import { STUDIO_ACTION_ROUTES } from '../src/lib/logging.ts';

class NodeSqlStorage {
  constructor() {
    this.database = new DatabaseSync(':memory:');
  }

  exec(query, ...bindings) {
    const normalized = query.trim().toUpperCase();
    if (bindings.length === 0 && !normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      this.database.exec(query);
      return { toArray: () => [] };
    }
    const statement = this.database.prepare(query);
    if (normalized.startsWith('SELECT') || normalized.startsWith('WITH')) {
      const rows = statement.all(...bindings);
      return { toArray: () => rows };
    }
    statement.run(...bindings);
    return { toArray: () => [] };
  }
}

const ACTION_1 = '11111111-1111-4111-8111-111111111111';
const ACTION_2 = '22222222-2222-4222-8222-222222222222';
const ACTION_ORPHAN = '33333333-3333-4333-8333-333333333333';
const CALL_1 = '44444444-4444-4444-8444-444444444444';
const CALL_2 = '55555555-5555-4555-8555-555555555555';
const CALL_ORPHAN = '66666666-6666-4666-8666-666666666666';

test('durable admin read reports exact recognized action and call lifecycle evidence', () => {
  const sql = new NodeSqlStorage();
  initializeStudioReliability(sql);

  recordStudioActionAdmission(sql, { actionId: ACTION_1, route: STUDIO_ACTION_ROUTES.CHAT, atMs: 1_000 });
  recordStudioActionAdmission(sql, { actionId: ACTION_1, route: STUDIO_ACTION_ROUTES.CHAT, atMs: 1_001 });
  recordStudioActionTerminal(sql, {
    actionId: ACTION_1, route: STUDIO_ACTION_ROUTES.CHAT, atMs: 2_000, outcome: 'ok',
  });
  recordStudioActionTerminal(sql, {
    actionId: ACTION_1, route: STUDIO_ACTION_ROUTES.CHAT, atMs: 2_001, outcome: 'ok',
  });
  recordStudioActionAdmission(sql, { actionId: ACTION_2, route: STUDIO_ACTION_ROUTES.CODE, atMs: 3_000 });
  recordStudioActionTerminal(sql, {
    actionId: ACTION_2, route: STUDIO_ACTION_ROUTES.CODE, atMs: 4_000, outcome: 'error',
  });
  recordStudioActionTerminal(sql, {
    actionId: ACTION_ORPHAN, route: STUDIO_ACTION_ROUTES.CODE, atMs: 5_000, outcome: 'error',
  });

  recordStudioModelCallAdmission(sql, { callId: CALL_1, actionId: ACTION_1, atMs: 1_100 });
  recordStudioModelCallTerminal(sql, { callId: CALL_1, actionId: ACTION_1, atMs: 1_200, outcome: 'ok' });
  recordStudioModelCallAdmission(sql, { callId: CALL_2, actionId: ACTION_1, atMs: 1_300 });
  recordStudioModelCallTerminal(sql, {
    callId: CALL_ORPHAN, actionId: ACTION_1, atMs: 1_400, outcome: 'timeout',
  });

  const read = readStudioReliabilityAdmin(sql, { fromMs: 0, toMs: 24 * 60 * 60 * 1000 });
  assert.equal(read.schema_version, STUDIO_RELIABILITY_SCHEMA_VERSION);
  assert.equal(read.product_id, 'agent-studio');
  assert.equal(read.authority, 'durable_product_state');
  assert.deepEqual(read.routes.map((route) => route.route), Object.values(STUDIO_ACTION_ROUTES));
  assert.deepEqual(read.routes[0], {
    route: STUDIO_ACTION_ROUTES.CHAT,
    admitted: 1,
    terminal: 1,
    success: 1,
    failure: 0,
    excluded: 0,
    incomplete: 0,
    duplicate_admissions: 1,
    duplicate_terminals: 1,
    orphan_terminals: 0,
    route_mismatches: 0,
  });
  assert.equal(read.routes[1].failure, 1);
  assert.equal(read.routes[1].orphan_terminals, 1);
  assert.deepEqual(read.model_calls, {
    admitted: 2,
    terminal: 1,
    success: 1,
    failure: 0,
    excluded: 0,
    incomplete: 1,
    duplicate_admissions: 0,
    duplicate_terminals: 0,
    orphan_terminals: 1,
    action_mismatches: 0,
  });
  assert.equal(read.contains_user_identifiers, false);
  assert.equal(STUDIO_ACTION_GRACE_MS, 30 * 60 * 1000);
  assert.equal(STUDIO_MODEL_CALL_GRACE_MS, 10 * 60 * 1000);
});

test('durable lifecycle writers reject unrecognized routes, ids, outcomes, and windows', () => {
  const sql = new NodeSqlStorage();
  initializeStudioReliability(sql);
  assert.throws(() => recordStudioActionAdmission(sql, {
    actionId: 'not-a-uuid', route: STUDIO_ACTION_ROUTES.CHAT, atMs: 1,
  }), /action id/);
  assert.throws(() => recordStudioActionAdmission(sql, {
    actionId: ACTION_1, route: '/raw/user/path', atMs: 1,
  }), /route/);
  assert.throws(() => recordStudioActionTerminal(sql, {
    actionId: ACTION_1, route: STUDIO_ACTION_ROUTES.CHAT, atMs: 2, outcome: 'maybe',
  }), /outcome/);
  assert.throws(() => readStudioReliabilityAdmin(sql, { fromMs: 2, toMs: 1 }), /window/);
});
