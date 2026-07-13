// Tests for the first-login migration of anonymous-session data into the
// CAIL subject-keyed namespace: claim state machine, data copy (happy path,
// merge-without-overwrite, idempotency), claim-once semantics, concurrency,
// and the session-middleware trigger (anonymous flow untouched).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  CLAIM_STALE_MS,
  decideClaim,
  maybeMigrateAnonymousSession,
  migrateAnonymousSession,
} from '../src/lib/migration.ts';
import { getWorkspaceDownloads } from '../src/lib/downloads.ts';
import { galleryOwnerTag } from '../src/lib/gallery.ts';
import {
  CAIL_IDENTITY_AUDIENCE,
  CAIL_IDENTITY_HEADER,
} from '../src/lib/cail-identity.ts';
import { MockR2 } from './helpers/env.mjs';

const NOW = 1_800_000_000_000;
const SESSION_SECRET = 'ab'.repeat(32);

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

/** In-memory WorkspaceAgent double covering the MigratableAgent surface. */
class FakeAgent {
  constructor() {
    this.state = { panels: [], viewport: { x: 0, y: 0, zoom: 1 }, groups: [], connections: [] };
    this.messages = [];
    this.files = new Map(); // path -> { text, contentType }
    this.unreadablePaths = new Set();
    this.cleared = false;
    this.syncCount = 0;
    this.frozen = false;
  }

  async syncWorkspace(workspace, sessionId) {
    this.syncCount += 1;
    this.workspace = workspace;
    this.sessionId = sessionId;
  }

  async freezeForMigration() {
    this.frozen = true;
  }

  async getSnapshot() {
    return this.state;
  }

  async getMessages() {
    return this.messages;
  }

  async getWorkspaceFiles() {
    return [...this.files.keys()].map((path) => ({ path, isDirectory: false }));
  }

  async readWorkspaceFileContent(filePath) {
    if (this.unreadablePaths.has(filePath)) return null;
    const entry = this.files.get(filePath);
    if (!entry) return null;
    return {
      filePath,
      contentType: entry.contentType,
      data: new TextEncoder().encode(entry.text).buffer,
    };
  }

  async writeWorkspaceFileContent(filePath, data, contentType) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.files.set(filePath, { text, contentType: contentType || 'application/octet-stream' });
    return { ok: true, filePath };
  }

  async replaceWorkspaceState(state, workspace, sessionId) {
    this.state = { ...state, workspace, sessionId };
  }

  async persistMessages(messages) {
    this.messages = [...messages];
  }

  async clearWorkspaceFiles() {
    this.files.clear();
    this.cleared = true;
  }
}

/** Agent factory backed by a map, mirroring `${sessionId}-${workspaceId}` DO names. */
function makeAgentPool() {
  const agents = new Map();
  const getAgent = async (sessionId, workspaceId) => {
    const name = `${sessionId}-${workspaceId}`;
    if (!agents.has(name)) agents.set(name, new FakeAgent());
    return agents.get(name);
  };
  return { agents, getAgent };
}

/**
 * Registry double that runs the REAL decideClaim behind a serialized queue —
 * the same semantics the MigrationRegistry DO provides (one request at a
 * time per anonymous session id).
 */
class FakeRegistry {
  constructor() {
    this.record = undefined;
    this.queue = Promise.resolve();
    this.claimCalls = 0;
  }

  #serialize(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  claim(subjectSessionId) {
    this.claimCalls += 1;
    return this.#serialize(() => {
      const decision = decideClaim(this.record, subjectSessionId, Date.now());
      if (decision.record) this.record = decision.record;
      return decision.action;
    });
  }

  markDone(subjectSessionId) {
    return this.#serialize(() => {
      if (this.record?.subjectSessionId === subjectSessionId) {
        this.record = { ...this.record, status: 'done', completedAt: Date.now() };
      }
    });
  }

  markFailed(subjectSessionId) {
    return this.#serialize(() => {
      if (this.record?.subjectSessionId === subjectSessionId && this.record.status !== 'done') {
        this.record = { ...this.record, status: 'failed' };
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANON = 'a'.repeat(32);
const SUBJECT = 'b'.repeat(32);
const OTHER_SUBJECT = 'c'.repeat(32);

function wsKey(sessionId, workspaceId) {
  return `agent-studio/sessions/${sessionId}/workspaces/${workspaceId}/workspace.json`;
}

function record(id, name) {
  const now = new Date(NOW).toISOString();
  return { id, name, description: '', createdAt: now, updatedAt: now };
}

async function seedWorkspace(r2, pool, sessionId, workspaceId, name, files = {}, messages = []) {
  await r2.put(wsKey(sessionId, workspaceId), JSON.stringify(record(workspaceId, name)));
  const agent = await pool.getAgent(sessionId, workspaceId);
  for (const [path, text] of Object.entries(files)) {
    agent.files.set(path, { text, contentType: 'text/plain; charset=utf-8' });
  }
  agent.messages = messages;
  agent.state = { ...agent.state, panels: [{ id: 'chat', type: 'chat', title: name }] };
}

async function seedGalleryItem(r2, id, authorId) {
  const ownerTag = await galleryOwnerTag(authorId, SESSION_SECRET);
  await r2.put(
    `agent-studio/gallery/items/${id}/manifest.json`,
    JSON.stringify({ id, title: 't', description: 'd', authorId: ownerTag, publishedAt: new Date(NOW).toISOString(), artifactCount: 0 })
  );
  await r2.put(`agent-studio/gallery/items/${id}/state.json`, JSON.stringify({ panels: [] }));
}

function makeEnv(r2) {
  return { WORKSPACE_FILES: r2, SESSION_SECRET };
}

// ---------------------------------------------------------------------------
// Claim state machine
// ---------------------------------------------------------------------------

test('decideClaim: fresh namespace -> run and record in-progress', () => {
  const decision = decideClaim(undefined, SUBJECT, NOW);
  assert.equal(decision.action, 'run');
  assert.deepEqual(decision.record, { subjectSessionId: SUBJECT, status: 'in-progress', startedAt: NOW });
});

test('decideClaim: done claim by same subject -> already-done, no rewrite', () => {
  const existing = { subjectSessionId: SUBJECT, status: 'done', startedAt: NOW - 1000, completedAt: NOW - 500 };
  const decision = decideClaim(existing, SUBJECT, NOW);
  assert.equal(decision.action, 'already-done');
  assert.equal(decision.record, undefined);
});

test('decideClaim: claim held by another subject is sticky in every status', () => {
  for (const status of ['in-progress', 'done', 'failed']) {
    const existing = { subjectSessionId: SUBJECT, status, startedAt: NOW - 1000 };
    assert.equal(decideClaim(existing, OTHER_SUBJECT, NOW).action, 'claimed-by-other', `status=${status}`);
  }
});

test('decideClaim: fresh in-progress by self -> in-progress (no concurrent double-run)', () => {
  const existing = { subjectSessionId: SUBJECT, status: 'in-progress', startedAt: NOW - 1000 };
  assert.equal(decideClaim(existing, SUBJECT, NOW).action, 'in-progress');
});

test('decideClaim: stale in-progress and failed claims retry for the same subject', () => {
  const stale = { subjectSessionId: SUBJECT, status: 'in-progress', startedAt: NOW - CLAIM_STALE_MS };
  assert.equal(decideClaim(stale, SUBJECT, NOW).action, 'run');
  const failed = { subjectSessionId: SUBJECT, status: 'failed', startedAt: NOW - 1000 };
  assert.equal(decideClaim(failed, SUBJECT, NOW).action, 'run');
});

// ---------------------------------------------------------------------------
// Data copy
// ---------------------------------------------------------------------------

test('happy path: workspaces, files, messages, state, downloads, gallery all move', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);

  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' }, [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  ]);
  await seedWorkspace(r2, pool, ANON, 'ws2', 'Second', { 'data.csv': 'a,b' });
  await r2.put(
    `agent-studio/sessions/${ANON}/workspaces/ws1/downloads.json`,
    JSON.stringify([{ filename: 'x.txt', format: 'txt', data: 'x' }])
  );
  await seedGalleryItem(r2, 'gal1', ANON);
  await seedGalleryItem(r2, 'gal2', 'someone-else');

  const result = await migrateAnonymousSession(env, ANON, SUBJECT, pool.getAgent);

  assert.deepEqual(result.migratedWorkspaceIds.sort(), ['ws1', 'ws2']);
  assert.deepEqual(result.skippedWorkspaceIds, []);
  assert.equal(result.galleryItemsReassigned, 1);

  // Subject namespace has both workspace records.
  assert.ok(await r2.get(wsKey(SUBJECT, 'ws1')));
  assert.ok(await r2.get(wsKey(SUBJECT, 'ws2')));

  // DO content copied into the subject-named agents.
  const newAgent1 = await pool.getAgent(SUBJECT, 'ws1');
  assert.equal(newAgent1.files.get('notes.md').text, 'hello');
  assert.equal(newAgent1.messages.length, 1);
  assert.equal(newAgent1.state.sessionId, SUBJECT);
  assert.equal(newAgent1.state.panels[0].title, 'First');

  // Downloads carried over (read via the storage-agnostic public reader; the
  // seed used the legacy downloads.json blob, migration re-writes per-object).
  const downloads = await getWorkspaceDownloads(env, SUBJECT, 'ws1');
  assert.equal(downloads[0].filename, 'x.txt');

  // Gallery authorship follows the user; other authors untouched.
  const gal1 = await (await r2.get('agent-studio/gallery/items/gal1/manifest.json')).json();
  assert.equal(gal1.authorId, await galleryOwnerTag(SUBJECT, SESSION_SECRET));
  const gal2 = await (await r2.get('agent-studio/gallery/items/gal2/manifest.json')).json();
  assert.equal(gal2.authorId, await galleryOwnerTag('someone-else', SESSION_SECRET));

  // Anonymous namespace deleted; old agents cleared.
  assert.deepEqual(r2.keysWithPrefix(`agent-studio/sessions/${ANON}/`), []);
  assert.equal((await pool.getAgent(ANON, 'ws1')).cleared, true);
  assert.equal((await pool.getAgent(ANON, 'ws2')).cleared, true);
  assert.equal((await pool.getAgent(ANON, 'ws1')).frozen, true);
  assert.equal((await pool.getAgent(ANON, 'ws2')).frozen, true);
});

test('merge without overwrite: subject-owned workspace ids are never touched', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);

  // Subject already owns wsX with its own content.
  await seedWorkspace(r2, pool, SUBJECT, 'wsX', 'Subject version', { 'mine.md': 'subject data' });
  // Anonymous namespace claims the same id with different content, plus a new one.
  await seedWorkspace(r2, pool, ANON, 'wsX', 'Anon version', { 'mine.md': 'anon data' });
  await seedWorkspace(r2, pool, ANON, 'wsY', 'Anon only', { 'other.md': 'anon other' });

  const result = await migrateAnonymousSession(env, ANON, SUBJECT, pool.getAgent);

  assert.deepEqual(result.skippedWorkspaceIds, ['wsX']);
  assert.deepEqual(result.migratedWorkspaceIds, ['wsY']);

  // Subject's wsX record and agent content are exactly as they were.
  const kept = await (await r2.get(wsKey(SUBJECT, 'wsX'))).json();
  assert.equal(kept.name, 'Subject version');
  const keptAgent = await pool.getAgent(SUBJECT, 'wsX');
  assert.equal(keptAgent.files.get('mine.md').text, 'subject data');

  // The new workspace arrived.
  const arrived = await pool.getAgent(SUBJECT, 'wsY');
  assert.equal(arrived.files.get('other.md').text, 'anon other');
});

test('idempotency: a second full run is a no-op with identical final state', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);

  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' });
  await migrateAnonymousSession(env, ANON, SUBJECT, pool.getAgent);
  const snapshotKeys = [...r2.store.keys()].sort();

  const second = await migrateAnonymousSession(env, ANON, SUBJECT, pool.getAgent);
  assert.deepEqual(second.migratedWorkspaceIds, []);
  assert.deepEqual(second.skippedWorkspaceIds, []);
  assert.deepEqual([...r2.store.keys()].sort(), snapshotKeys);
  const agent = await pool.getAgent(SUBJECT, 'ws1');
  assert.equal(agent.files.get('notes.md').text, 'hello');
});

test('listed-but-unreadable files fail migration without deleting anonymous data or marking done', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', {
    'ok.txt': 'ok',
    'missing.txt': 'listed only',
  });
  const source = await pool.getAgent(ANON, 'ws1');
  source.unreadablePaths.add('missing.txt');
  const registry = new FakeRegistry();

  await assert.rejects(
    maybeMigrateAnonymousSession({
      env,
      anonSessionId: ANON,
      subjectSessionId: SUBJECT,
      registry,
      getAgent: pool.getAgent,
    }),
    /migration: listed file missing\.txt could not be read from workspace ws1/,
  );

  assert.equal(registry.record.status, 'failed');
  assert.ok(await r2.get(wsKey(ANON, 'ws1')));
  assert.equal(await r2.get(wsKey(SUBJECT, 'ws1')), null);
  assert.equal((await pool.getAgent(ANON, 'ws1')).cleared, false);
});

test('retry after a listed-file read failure succeeds and completes cleanup', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', {
    'ok.txt': 'ok',
    'missing.txt': 'readable later',
  });
  const source = await pool.getAgent(ANON, 'ws1');
  source.unreadablePaths.add('missing.txt');
  const registry = new FakeRegistry();

  await assert.rejects(
    maybeMigrateAnonymousSession({
      env,
      anonSessionId: ANON,
      subjectSessionId: SUBJECT,
      registry,
      getAgent: pool.getAgent,
    }),
    /missing\.txt/,
  );

  source.unreadablePaths.delete('missing.txt');
  const retry = await maybeMigrateAnonymousSession({
    env,
    anonSessionId: ANON,
    subjectSessionId: SUBJECT,
    registry,
    getAgent: pool.getAgent,
  });

  assert.equal(retry, 'migrated');
  assert.equal(registry.record.status, 'done');
  const target = await pool.getAgent(SUBJECT, 'ws1');
  assert.equal(target.files.get('ok.txt').text, 'ok');
  assert.equal(target.files.get('missing.txt').text, 'readable later');
  assert.deepEqual(r2.keysWithPrefix(`agent-studio/sessions/${ANON}/`), []);
});

test('retry cleans source runtime files for workspaces marked complete before failure', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'first.txt': 'first' });
  await seedWorkspace(r2, pool, ANON, 'ws2', 'Second', { 'second.txt': 'second' });
  const secondSource = await pool.getAgent(ANON, 'ws2');
  secondSource.unreadablePaths.add('second.txt');
  const registry = new FakeRegistry();

  await assert.rejects(
    maybeMigrateAnonymousSession({
      env,
      anonSessionId: ANON,
      subjectSessionId: SUBJECT,
      registry,
      getAgent: pool.getAgent,
    }),
    /second\.txt/,
  );

  // ws1's target record is the completion marker, but cleanup has not run yet.
  assert.ok(await r2.get(wsKey(SUBJECT, 'ws1')));
  assert.equal((await pool.getAgent(ANON, 'ws1')).cleared, false);

  // Simulate subject-owned work after the partial migration. The retry must
  // skip this target workspace and clean only its anonymous counterpart.
  const firstTarget = await pool.getAgent(SUBJECT, 'ws1');
  firstTarget.files.set('subject-only.txt', {
    text: 'keep me',
    contentType: 'text/plain; charset=utf-8',
  });

  secondSource.unreadablePaths.delete('second.txt');
  const retry = await maybeMigrateAnonymousSession({
    env,
    anonSessionId: ANON,
    subjectSessionId: SUBJECT,
    registry,
    getAgent: pool.getAgent,
  });

  assert.equal(retry, 'migrated');
  assert.equal(registry.record.status, 'done');
  assert.equal((await pool.getAgent(ANON, 'ws1')).cleared, true);
  assert.equal((await pool.getAgent(ANON, 'ws2')).cleared, true);
  assert.equal(firstTarget.files.get('subject-only.txt').text, 'keep me');
  assert.equal((await pool.getAgent(SUBJECT, 'ws2')).files.get('second.txt').text, 'second');
  assert.deepEqual(r2.keysWithPrefix(`agent-studio/sessions/${ANON}/`), []);
});

test('corrupt anon downloads blob fails migration loudly instead of silently dropping deliverables', async (t) => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' });
  const legacyKey = `agent-studio/sessions/${ANON}/workspaces/ws1/downloads.json`;
  await r2.put(legacyKey, '{corrupt, not json');
  const registry = new FakeRegistry();

  t.mock.method(console, 'error', () => {});
  // Old behavior: the corrupt blob was read as "no downloads", migration
  // "succeeded", and the anonymous namespace was deleted — the user's queued
  // deliverables vanished with no trace. Now the read fails loudly.
  await assert.rejects(
    maybeMigrateAnonymousSession({
      env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: pool.getAgent,
    }),
    /corrupt stored download object/,
  );

  // Claim marked failed for retry; nothing anonymous was deleted or marked done.
  assert.equal(registry.record.status, 'failed');
  assert.ok(await r2.get(wsKey(ANON, 'ws1')));
  assert.ok(await r2.get(legacyKey), 'corrupt blob preserved for repair, not dropped');
  assert.equal(await r2.get(wsKey(SUBJECT, 'ws1')), null);

  // Repairing the blob lets a retry complete and carry the download over.
  await r2.put(legacyKey, JSON.stringify([{ filename: 'x.txt', format: 'txt', data: 'x' }]));
  const retry = await maybeMigrateAnonymousSession({
    env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: pool.getAgent,
  });
  assert.equal(retry, 'migrated');
  assert.equal(registry.record.status, 'done');
  const downloads = await getWorkspaceDownloads(env, SUBJECT, 'ws1');
  assert.deepEqual(downloads.map((d) => d.filename), ['x.txt']);
});

// ---------------------------------------------------------------------------
// Claim-once + concurrency (orchestration)
// ---------------------------------------------------------------------------

test('claim-once: a namespace claimed by another subject is never copied', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' });

  const registry = new FakeRegistry();
  // First verified claim wins...
  const first = await maybeMigrateAnonymousSession({
    env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: pool.getAgent,
  });
  assert.equal(first, 'migrated');
  assert.equal(registry.record.subjectSessionId, SUBJECT);

  // ...and a different subject can never claim the same namespace.
  let otherAgentCalls = 0;
  const outcome = await maybeMigrateAnonymousSession({
    env,
    anonSessionId: ANON,
    subjectSessionId: OTHER_SUBJECT,
    registry,
    getAgent: async (...args) => {
      otherAgentCalls += 1;
      return pool.getAgent(...args);
    },
  });
  assert.equal(outcome, 'claimed-by-other');
  assert.equal(otherAgentCalls, 0);
  // Nothing was written into the other subject's namespace.
  assert.deepEqual(r2.keysWithPrefix(`agent-studio/sessions/${OTHER_SUBJECT}/`), []);
});

test('concurrency: parallel first-login requests migrate exactly once', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' });

  const registry = new FakeRegistry();
  let sourceReads = 0;
  const slowGetAgent = async (sessionId, workspaceId) => {
    // Yield so the second claim lands while the first run is mid-copy.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (sessionId === ANON) sourceReads += 1;
    return pool.getAgent(sessionId, workspaceId);
  };

  const [a, b] = await Promise.all([
    maybeMigrateAnonymousSession({
      env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: slowGetAgent,
    }),
    maybeMigrateAnonymousSession({
      env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: slowGetAgent,
    }),
  ]);

  assert.deepEqual([a, b].sort(), ['in-progress', 'migrated']);
  assert.equal(registry.record.status, 'done');
  // Single copy: the source was read by exactly one run (migrate touches the
  // anon agent twice — copy + cleanup), and the content arrived intact.
  assert.equal(sourceReads, 2);
  const agent = await pool.getAgent(SUBJECT, 'ws1');
  assert.equal(agent.files.get('notes.md').text, 'hello');
});

test('failure marks the claim failed and a later run retries and completes', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = makeEnv(r2);
  await seedWorkspace(r2, pool, ANON, 'ws1', 'First', { 'notes.md': 'hello' });

  const registry = new FakeRegistry();
  let shouldFail = true;
  const flakyGetAgent = async (sessionId, workspaceId) => {
    if (shouldFail) throw new Error('transient');
    return pool.getAgent(sessionId, workspaceId);
  };

  await assert.rejects(
    maybeMigrateAnonymousSession({
      env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: flakyGetAgent,
    }),
    /transient/,
  );
  assert.equal(registry.record.status, 'failed');

  shouldFail = false;
  const retry = await maybeMigrateAnonymousSession({
    env, anonSessionId: ANON, subjectSessionId: SUBJECT, registry, getAgent: flakyGetAgent,
  });
  assert.equal(retry, 'migrated');
  assert.equal((await pool.getAgent(SUBJECT, 'ws1')).files.get('notes.md').text, 'hello');
});

test('expired import window refuses migration before claiming or reading legacy data', async () => {
  const r2 = new MockR2();
  const pool = makeAgentPool();
  const env = {
    ...makeEnv(r2),
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_SSO_SWITCHED_AT: '2026-07-01T00:00:00Z',
    CAIL_ACCOUNT_IMPORT_UNTIL: '2026-07-02T00:00:00Z',
  };
  await seedWorkspace(r2, pool, ANON, 'ws1', 'Legacy', { 'notes.md': 'stay put' });
  const registry = new FakeRegistry();

  const outcome = await maybeMigrateAnonymousSession({
    env,
    anonSessionId: ANON,
    subjectSessionId: SUBJECT,
    registry,
    getAgent: pool.getAgent,
    now: Date.parse('2026-07-02T00:00:00.001Z'),
  });

  assert.equal(outcome, 'window-not-open');
  assert.equal(registry.claimCalls, 0);
  assert.ok(await r2.get(wsKey(ANON, 'ws1')));
  assert.equal(await r2.get(wsKey(SUBJECT, 'ws1')), null);
});

// ---------------------------------------------------------------------------
// Middleware trigger (Hono integration): anonymous flow untouched, first
// authenticated request with a legacy cookie migrates and drops the cookie.
// ---------------------------------------------------------------------------

const IDENTITY_KID = 'migration-middleware-key';
const identityKeyPair = await generateKeyPair('RS256', { extractable: true });
const identityPublicJwk = {
  ...(await exportJWK(identityKeyPair.publicKey)),
  kid: IDENTITY_KID,
  alg: 'RS256',
  use: 'sig',
};

async function mintJwt(sub) {
  return new SignJWT({
    sub,
    aud: CAIL_IDENTITY_AUDIENCE,
    iss: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
    .setProtectedHeader({ alg: 'RS256', kid: IDENTITY_KID, typ: 'JWT' })
    .sign(identityKeyPair.privateKey);
}

async function makeMiddlewareApp() {
  const { Hono } = await import('hono');
  const { sessionMiddleware } = await import('../src/lib/session.ts');

  const r2 = new MockR2();
  const registry = new FakeRegistry();
  const env = {
    SESSION_SECRET,
    CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [identityPublicJwk] }),
    WORKSPACE_FILES: r2,
    MIGRATION_REGISTRY: {
      idFromName: (name) => name,
      get: () => registry,
    },
  };

  const app = new Hono();
  app.use('/api/*', sessionMiddleware);
  app.get('/api/session', (c) => c.json({ sessionId: c.get('sessionId') }));

  return { app, env, r2, registry };
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/agent-studio-session=([^;]*)/);
  return match ? `agent-studio-session=${match[1]}` : null;
}

test('middleware: pure anonymous flow never touches migration', async () => {
  const { app, env, registry } = await makeMiddlewareApp();

  const first = await app.request('/api/session', {}, env);
  assert.equal(first.status, 200);
  const { sessionId } = await first.json();
  const cookie = cookieFrom(first);
  assert.ok(cookie);

  // Same cookie, still anonymous: same session, no claims, no writes.
  const second = await app.request('/api/session', { headers: { Cookie: cookie } }, env);
  assert.equal((await second.json()).sessionId, sessionId);
  assert.equal(registry.claimCalls, 0);
});

test('middleware: first authenticated request with legacy cookie migrates once and drops the cookie', async () => {
  const { app, env, r2, registry } = await makeMiddlewareApp();

  // Establish an anonymous session and give it a gallery item to own.
  const anonResponse = await app.request('/api/session', {}, env);
  const anonSessionId = (await anonResponse.json()).sessionId;
  const cookie = cookieFrom(anonResponse);
  await seedGalleryItem(r2, 'galM', anonSessionId);

  // Authenticate with the legacy cookie still present.
  const jwt = await mintJwt('cail-middleware-test');
  const authed = await app.request('/api/session', {
    headers: { Cookie: cookie, [CAIL_IDENTITY_HEADER]: jwt },
  }, env);
  assert.equal(authed.status, 200);
  const subjectSessionId = (await authed.json()).sessionId;
  assert.notEqual(subjectSessionId, anonSessionId);

  // Migration ran: gallery ownership moved, claim recorded done.
  const manifest = await (await r2.get('agent-studio/gallery/items/galM/manifest.json')).json();
  assert.equal(manifest.authorId, await galleryOwnerTag(subjectSessionId, SESSION_SECRET));
  assert.equal(registry.record.status, 'done');
  assert.equal(registry.record.subjectSessionId, subjectSessionId);

  // The legacy cookie is dropped (Max-Age=0 delete).
  const setCookie = authed.headers.get('set-cookie') || '';
  assert.match(setCookie, /agent-studio-session=;/);

  // A repeat request with the same (stale) cookie is a no-op.
  const claimCallsBefore = registry.claimCalls;
  const again = await app.request('/api/session', {
    headers: { Cookie: cookie, [CAIL_IDENTITY_HEADER]: jwt },
  }, env);
  assert.equal((await again.json()).sessionId, subjectSessionId);
  assert.equal(registry.claimCalls, claimCallsBefore + 1); // claim checked, returns already-done
  assert.equal(registry.record.status, 'done');
});

test('middleware: authenticated request after expiry refuses import and clears the legacy cookie', async (t) => {
  const { app, env, r2, registry } = await makeMiddlewareApp();
  const anonResponse = await app.request('/api/session', {}, env);
  const anonSessionId = (await anonResponse.json()).sessionId;
  const cookie = cookieFrom(anonResponse);
  await seedGalleryItem(r2, 'galExpired', anonSessionId);
  Object.assign(env, {
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_SSO_SWITCHED_AT: '2026-01-01T00:00:00Z',
    CAIL_ACCOUNT_IMPORT_UNTIL: '2026-01-02T00:00:00Z',
  });
  const jwt = await mintJwt('cail-expired-migration-test');

  const warnings = t.mock.method(console, 'warn', () => {});
  const authed = await app.request('/api/session', {
    headers: { Cookie: cookie, [CAIL_IDENTITY_HEADER]: jwt },
  }, env);

  assert.equal(authed.status, 200);
  assert.equal(registry.claimCalls, 0);
  assert.match(authed.headers.get('set-cookie') || '', /agent-studio-session=;/);
  const manifest = await (await r2.get('agent-studio/gallery/items/galExpired/manifest.json')).json();
  assert.equal(manifest.authorId, await galleryOwnerTag(anonSessionId, SESSION_SECRET));
  assert.equal(warnings.mock.callCount(), 1);
});
