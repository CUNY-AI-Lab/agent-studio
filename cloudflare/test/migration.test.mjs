import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_SUBJECTS, createTestIdentityIssuer } from './helpers/identity.mjs';

import {
  addWorkspaceDownload,
  clearWorkspaceDownloads,
  getWorkspaceDownloads,
} from '../src/lib/downloads.ts';
import { galleryOwnerTag } from '../src/lib/gallery.ts';
import { migrateAnonymousSession } from '../src/lib/migration.ts';
import {
  CAIL_IDENTITY_AUDIENCE,
  CAIL_IDENTITY_HEADER,
  sessionIdForSubject,
} from '../src/lib/cail-identity.ts';
import { signValue } from '../src/lib/session.ts';
import {
  makeMigrationRegistryNamespace,
  makeWorkspaceAgentNamespace,
  MockR2,
  registerCloudflareStub,
} from './helpers/env.mjs';

registerCloudflareStub();

const SESSION_SECRET = 'ab'.repeat(32);
const SOURCE_SESSION = 'a'.repeat(32);
const TARGET_SESSION = 'b'.repeat(32);
const WORKSPACE_ONE = '1'.repeat(32);
const WORKSPACE_TWO = '2'.repeat(32);
const MARKER = `agent-studio/account-import/v1/${TARGET_SESSION}.json`;

function createR2() {
  const r2 = new MockR2();
  r2.head = async (key) => r2.store.has(key) ? { key } : null;
  return r2;
}

function workspaceRecord(id, name) {
  return {
    id,
    name,
    description: `${name} description`,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

function workspaceKey(sessionId, workspaceId) {
  return `agent-studio/sessions/${sessionId}/workspaces/${workspaceId}/workspace.json`;
}

function legacyFileKey(sessionId, workspaceId, filePath) {
  return `agent-studio/sessions/${sessionId}/workspaces/${workspaceId}/files/${filePath}`;
}

class FakeAgent {
  constructor() {
    this.state = {
      panels: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    };
    this.messages = [];
    this.files = new Map();
    this.frozen = false;
    this.freezeCount = 0;
    this.unfreezeCount = 0;
    this.failWriteOnce = null;
  }

  async syncWorkspace(workspace, sessionId) {
    if (this.frozen) throw new Error('source is frozen');
    this.workspace = workspace;
    this.sessionId = sessionId;
  }

  async freezeForMigration() {
    this.frozen = true;
    this.freezeCount += 1;
  }

  async unfreezeAfterMigration() {
    this.frozen = false;
    this.unfreezeCount += 1;
  }

  async getSnapshot() { return this.state; }
  async getMessages() { return this.messages; }

  async getWorkspaceFiles() {
    return [...this.files.keys()].map((path) => ({ path, isDirectory: false }));
  }

  async readWorkspaceFileContent(filePath) {
    const entry = this.files.get(filePath);
    if (!entry) return null;
    return {
      filePath,
      contentType: entry.contentType,
      data: new TextEncoder().encode(entry.text).buffer,
    };
  }

  async writeWorkspaceFileContent(filePath, data, contentType) {
    if (this.failWriteOnce === filePath) {
      this.failWriteOnce = null;
      throw new Error('simulated target write failure');
    }
    const text = data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : ArrayBuffer.isView(data)
        ? new TextDecoder().decode(data)
        : data;
    this.files.set(filePath, { text, contentType });
    return { ok: true, filePath };
  }

  async clearWorkspaceFiles() {
    this.files.clear();
  }

  async replaceWorkspaceState(state, workspace, sessionId) {
    this.state = { ...state, workspace, sessionId };
  }

  async persistMessages(messages, _excludeBroadcastIds, options) {
    const serverIds = new Set(this.messages.map((message) => message.id));
    if (options?._deleteStaleRows && messages.every((message) => serverIds.has(message.id))) {
      this.messages = structuredClone(messages);
      return;
    }
    const byId = new Map(this.messages.map((message) => [message.id, message]));
    for (const message of messages) byId.set(message.id, structuredClone(message));
    this.messages = [...byId.values()];
  }
}

function createAgentPool() {
  const agents = new Map();
  const getAgent = async (sessionId, workspaceId) => {
    const key = `${sessionId}-${workspaceId}`;
    if (!agents.has(key)) agents.set(key, new FakeAgent());
    return agents.get(key);
  };
  return { agents, getAgent };
}

async function seedWorkspace(r2, pool, sessionId, id, name) {
  const record = workspaceRecord(id, name);
  await r2.put(workspaceKey(sessionId, id), JSON.stringify(record));
  const agent = await pool.getAgent(sessionId, id);
  await agent.syncWorkspace(record, sessionId);
  return agent;
}

async function seedGallery(r2, galleryId, ownerSessionId) {
  await r2.put(
    `agent-studio/gallery/items/${galleryId}/manifest.json`,
    JSON.stringify({
      id: galleryId,
      title: 'Published workspace',
      description: 'Description',
      authorId: await galleryOwnerTag(ownerSessionId, SESSION_SECRET),
      publishedAt: '2026-08-01T00:00:00.000Z',
      artifactCount: 1,
    }),
  );
  await r2.put(
    `agent-studio/gallery/items/${galleryId}/state.json`,
    JSON.stringify({ panels: [] }),
  );
}

function env(r2) {
  return { WORKSPACE_FILES: r2, SESSION_SECRET };
}

test('first login copies every current relationship and writes the marker last', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.state = {
    panels: [
      { id: 'chat', type: 'chat', title: 'Chat' },
      { id: 'notes', type: 'markdown', title: 'Notes', content: 'Preserved' },
    ],
    viewport: { x: 12, y: 20, zoom: 0.8 },
    groups: [{ id: 'group', panelIds: ['chat', 'notes'] }],
    connections: [{ id: 'edge', sourceId: 'chat', targetId: 'notes' }],
  };
  source.messages = [{ id: 'message', role: 'user', parts: [{ type: 'text', text: 'Question' }] }];
  source.files.set('runtime.md', { text: 'runtime', contentType: 'text/markdown' });
  await r2.put(legacyFileKey(SOURCE_SESSION, WORKSPACE_ONE, 'legacy.txt'), 'legacy', {
    httpMetadata: { contentType: 'text/plain' },
  });
  await addWorkspaceDownload(
    env(r2),
    SOURCE_SESSION,
    WORKSPACE_ONE,
    { filename: 'current.txt', format: 'txt', data: 'current' },
  );
  await r2.put(
    `agent-studio/sessions/${SOURCE_SESSION}/workspaces/${WORKSPACE_ONE}/downloads.json`,
    JSON.stringify([{ filename: 'earlier.csv', format: 'csv', data: 'a,b' }]),
  );
  const galleryId = 'c'.repeat(24);
  await seedGallery(r2, galleryId, SOURCE_SESSION);

  const markerWrites = [];
  const originalPut = r2.put.bind(r2);
  r2.put = async (key, value, options) => {
    if (key === MARKER) markerWrites.push([...r2.store.keys()]);
    return originalPut(key, value, options);
  };

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);

  const target = await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE);
  assert.equal(target.files.get('runtime.md').text, 'runtime');
  assert.equal(target.files.get('legacy.txt').text, 'legacy');
  assert.deepEqual(target.messages, source.messages);
  assert.equal(target.state.sessionId, TARGET_SESSION);
  assert.deepEqual(target.state.groups, source.state.groups);
  assert.deepEqual(target.state.connections, source.state.connections);
  assert.deepEqual(
    (await getWorkspaceDownloads(env(r2), TARGET_SESSION, WORKSPACE_ONE))
      .map((download) => download.filename),
    ['current.txt', 'earlier.csv'],
  );
  assert.ok(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)));
  assert.equal(await (await r2.get(MARKER)).text(), '1');
  assert.equal(markerWrites.length, 1);
  assert.equal(
    markerWrites[0].includes(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)),
    true,
    'workspace visibility record exists before the account marker',
  );
  const manifest = await (
    await r2.get(`agent-studio/gallery/items/${galleryId}/manifest.json`)
  ).json();
  const owner = await (
    await r2.get(`agent-studio/gallery/items/${galleryId}/owner.json`)
  ).json();
  assert.equal(manifest.authorId, undefined);
  assert.equal(owner.tag, await galleryOwnerTag(TARGET_SESSION, SESSION_SECRET));
  assert.equal(source.frozen, true);
  assert.ok(await r2.get(workspaceKey(SOURCE_SESSION, WORKSPACE_ONE)), 'source retained as an inaccessible backup');
});

test('repeat login is a marker-only no-op', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.files.set('notes.md', { text: 'original', contentType: 'text/markdown' });
  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  const target = await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE);
  const keys = [...r2.store.keys()].sort();
  const freezeCount = source.freezeCount;
  target.files.set('new-store-only.md', { text: 'authoritative', contentType: 'text/markdown' });

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);

  assert.deepEqual([...r2.store.keys()].sort(), keys);
  assert.equal(source.freezeCount, freezeCount);
  assert.equal(target.files.get('new-store-only.md').text, 'authoritative');
});

test('partial target failure leaves no marker or visible workspace and retries without duplicates', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.files.set('a.txt', { text: 'a', contentType: 'text/plain' });
  source.files.set('b.txt', { text: 'b', contentType: 'text/plain' });
  const target = await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE);
  target.failWriteOnce = 'b.txt';

  await assert.rejects(
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    /simulated target write failure/,
  );
  assert.equal(await r2.get(MARKER), null);
  assert.equal(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)), null);
  assert.equal(source.frozen, false);
  assert.ok(await r2.get(workspaceKey(SOURCE_SESSION, WORKSPACE_ONE)));

  // The retry must mirror the current source, not expose a stale file written
  // by the failed attempt or lose a file added before the later login.
  source.files.delete('a.txt');
  source.files.set('c.txt', { text: 'c', contentType: 'text/plain' });
  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  assert.deepEqual([...target.files.keys()].sort(), ['b.txt', 'c.txt']);
  assert.ok(await r2.get(MARKER));
  assert.equal(source.frozen, true);
});

test('marker failure after a committed workspace retries without overwriting new-store content', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.files.set('source.txt', { text: 'source', contentType: 'text/plain' });
  const originalPut = r2.put.bind(r2);
  let failMarker = true;
  r2.put = async (key, value, options) => {
    if (key === MARKER && failMarker) {
      failMarker = false;
      throw new Error('simulated marker failure');
    }
    return originalPut(key, value, options);
  };

  await assert.rejects(
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    /simulated marker failure/,
  );
  assert.ok(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)));
  assert.equal(await r2.get(MARKER), null);
  assert.equal(source.frozen, true);
  const target = await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE);
  target.files.set('new-store-only.txt', { text: 'keep', contentType: 'text/plain' });

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  assert.equal(target.files.get('new-store-only.txt').text, 'keep');
  assert.equal(target.files.get('source.txt').text, 'source');
  assert.ok(await r2.get(MARKER));
  assert.equal(source.frozen, true);
});

test('retry replaces partial target downloads when the legacy queue shrinks', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.messages = [
    { id: 'stale-message', role: 'user', parts: [{ type: 'text', text: 'stale' }] },
    { id: 'current-message', role: 'assistant', parts: [{ type: 'text', text: 'current' }] },
  ];
  await addWorkspaceDownload(env(r2), SOURCE_SESSION, WORKSPACE_ONE, {
    filename: 'stale.txt', format: 'txt', data: 'stale',
  });
  await addWorkspaceDownload(env(r2), SOURCE_SESSION, WORKSPACE_ONE, {
    filename: 'keep.txt', format: 'txt', data: 'keep',
  });
  const targetKey = workspaceKey(TARGET_SESSION, WORKSPACE_ONE);
  const originalPut = r2.put.bind(r2);
  let failCommit = true;
  r2.put = async (key, value, options) => {
    if (key === targetKey && failCommit) {
      failCommit = false;
      throw new Error('simulated target record failure');
    }
    return originalPut(key, value, options);
  };

  await assert.rejects(
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    /simulated target record failure/,
  );
  source.messages = [
    { id: 'replacement-message', role: 'user', parts: [{ type: 'text', text: 'replacement' }] },
  ];
  await clearWorkspaceDownloads(env(r2), SOURCE_SESSION, WORKSPACE_ONE);
  await addWorkspaceDownload(env(r2), SOURCE_SESSION, WORKSPACE_ONE, {
    filename: 'current.txt', format: 'txt', data: 'current',
  });

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  assert.deepEqual(
    (await getWorkspaceDownloads(env(r2), TARGET_SESSION, WORKSPACE_ONE))
      .map((download) => download.filename),
    ['current.txt'],
  );
  assert.deepEqual(
    (await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE)).messages.map((message) => message.id),
    ['replacement-message'],
  );
});

test('failure after an earlier workspace commit keeps committed sources frozen and retry completes', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const first = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'First');
  first.files.set('first.txt', { text: 'first', contentType: 'text/plain' });
  const second = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_TWO, 'Second');
  second.files.set('second.txt', { text: 'second', contentType: 'text/plain' });
  (await pool.getAgent(TARGET_SESSION, WORKSPACE_TWO)).failWriteOnce = 'second.txt';

  await assert.rejects(
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    /simulated target write failure/,
  );
  assert.ok(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)));
  assert.equal(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_TWO)), null);
  assert.equal(first.frozen, true);
  assert.equal(second.frozen, false);
  assert.equal(await r2.get(MARKER), null);

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  assert.ok(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_TWO)));
  assert.ok(await r2.get(MARKER));
  assert.equal(first.frozen, true);
  assert.equal(second.frozen, true);
});

test('corrupt current or earlier downloads remain retryable and are never silently dropped', async () => {
  for (const storage of ['current', 'earlier']) {
    const r2 = createR2();
    const pool = createAgentPool();
    const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
    source.files.set('notes.md', { text: 'notes', contentType: 'text/plain' });
    const corruptKey = storage === 'current'
      ? `agent-studio/sessions/${SOURCE_SESSION}/workspaces/${WORKSPACE_ONE}/downloads/corrupt.json`
      : `agent-studio/sessions/${SOURCE_SESSION}/workspaces/${WORKSPACE_ONE}/downloads.json`;
    await r2.put(corruptKey, '{not json');

    await assert.rejects(
      migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    );
    assert.equal(await r2.get(MARKER), null);
    assert.equal(await r2.get(workspaceKey(TARGET_SESSION, WORKSPACE_ONE)), null);
    assert.ok(await r2.get(corruptKey));
    assert.equal(source.frozen, false);

    if (storage === 'current') {
      await r2.put(corruptKey, JSON.stringify({
        seq: 0,
        createdAt: '1970-01-01T00:00:00.000Z',
        download: { filename: 'recovered.txt', format: 'txt', data: 'recovered' },
      }));
    } else {
      await r2.put(corruptKey, JSON.stringify([
        { filename: 'recovered.txt', format: 'txt', data: 'recovered' },
      ]));
    }
    await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
    assert.deepEqual(
      (await getWorkspaceDownloads(env(r2), TARGET_SESSION, WORKSPACE_ONE))
        .map((download) => download.filename),
      ['recovered.txt'],
    );
  }
});

test('parallel attempts converge on one deterministic target without duplicated downloads', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const source = await seedWorkspace(r2, pool, SOURCE_SESSION, WORKSPACE_ONE, 'Research');
  source.files.set('notes.md', { text: 'notes', contentType: 'text/plain' });
  await r2.put(
    `agent-studio/sessions/${SOURCE_SESSION}/workspaces/${WORKSPACE_ONE}/downloads.json`,
    JSON.stringify([{ filename: 'one.txt', format: 'txt', data: 'one' }]),
  );

  const outcomes = await Promise.allSettled([
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
  ]);

  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  assert.ok(await r2.get(MARKER));
  assert.deepEqual(
    (await getWorkspaceDownloads(env(r2), TARGET_SESSION, WORKSPACE_ONE))
      .map((download) => download.filename),
    ['one.txt'],
  );
  const target = await pool.getAgent(TARGET_SESSION, WORKSPACE_ONE);
  assert.deepEqual([...target.files.keys()], ['notes.md']);
});

test('gallery ownership reassignment repairs a failed manifest write on retry', async () => {
  const r2 = createR2();
  const pool = createAgentPool();
  const galleryId = 'f'.repeat(24);
  await seedGallery(r2, galleryId, SOURCE_SESSION);
  const manifestKey = `agent-studio/gallery/items/${galleryId}/manifest.json`;
  const ownerKey = `agent-studio/gallery/items/${galleryId}/owner.json`;
  const originalPut = r2.put.bind(r2);
  let failManifest = true;
  r2.put = async (key, value, options) => {
    if (key === manifestKey && failManifest) {
      failManifest = false;
      throw new Error('simulated gallery manifest failure');
    }
    return originalPut(key, value, options);
  };

  await assert.rejects(
    migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent),
    /simulated gallery manifest failure/,
  );
  assert.equal(await r2.get(MARKER), null);
  assert.equal(
    (await (await r2.get(ownerKey)).json()).tag,
    await galleryOwnerTag(TARGET_SESSION, SESSION_SECRET),
  );
  assert.ok((await (await r2.get(manifestKey)).json()).authorId);

  await migrateAnonymousSession(env(r2), SOURCE_SESSION, TARGET_SESSION, pool.getAgent);
  assert.equal('authorId' in await (await r2.get(manifestKey)).json(), false);
  assert.ok(await r2.get(MARKER));
});

const identityIssuer = await createTestIdentityIssuer({ kid: 'login-import-key' });

async function createMiddlewareFixture() {
  const { Hono } = await import('hono');
  const { sessionMiddleware } = await import('../src/lib/session.ts');
  const r2 = createR2();
  const registry = makeMigrationRegistryNamespace();
  const workspaceAgents = makeWorkspaceAgentNamespace();
  const app = new Hono();
  app.use('/api/*', sessionMiddleware);
  app.get('/api/session', (c) => c.json({ sessionId: c.get('sessionId') }));
  const fixtureEnv = {
    SESSION_SECRET,
    CAIL_REQUIRE_IDENTITY: 'true',
    CAIL_IDENTITY_JWKS: identityIssuer.jwksJson,
    CAIL_IDENTITY_ISSUER: identityIssuer.issuer,
    WORKSPACE_FILES: r2,
    WorkspaceAgent: workspaceAgents.namespace,
    MIGRATION_REGISTRY: registry.namespace,
  };
  const identityJwt = await identityIssuer.mintIdentityJwt({
    audience: CAIL_IDENTITY_AUDIENCE,
    subject: TEST_SUBJECTS.alice,
  });
  return { app, env: fixtureEnv, r2, registry, workspaceAgents, identityJwt };
}

test('an admitted anonymous create fences first login until the new workspace can be imported', async () => {
  const fixture = await createMiddlewareFixture();
  fixture.env.CAIL_REQUIRE_IDENTITY = 'false';
  let entered;
  let release;
  const requestEntered = new Promise((resolve) => { entered = resolve; });
  const releaseRequest = new Promise((resolve) => { release = resolve; });
  fixture.app.post('/api/create-during-cutover', async (c) => {
    const sourceSession = c.get('sessionId');
    entered();
    await releaseRequest;
    const workspace = workspaceRecord(WORKSPACE_ONE, 'Created during cutover');
    await fixture.workspaceAgents.ensure(`${sourceSession}-${WORKSPACE_ONE}`)
      .syncWorkspace(workspace, sourceSession);
    await fixture.r2.put(workspaceKey(sourceSession, WORKSPACE_ONE), JSON.stringify(workspace));
    return c.json({ ok: true }, 201);
  });

  const signed = await signValue(SOURCE_SESSION, SESSION_SECRET);
  const cookie = `agent-studio-session=${signed}`;
  const anonymousCreate = fixture.app.request('/api/create-during-cutover', {
    method: 'POST',
    headers: { Cookie: cookie },
  }, fixture.env);
  await requestEntered;

  const blockedLogin = await fixture.app.request('/api/session', {
    headers: {
      Cookie: cookie,
      [CAIL_IDENTITY_HEADER]: fixture.identityJwt,
    },
  }, fixture.env);
  assert.equal(blockedLogin.status, 503);
  assert.equal((await blockedLogin.json()).error.code, 'account_import_failed');

  release();
  assert.equal((await anonymousCreate).status, 201);

  const retried = await fixture.app.request('/api/session', {
    headers: {
      Cookie: cookie,
      [CAIL_IDENTITY_HEADER]: fixture.identityJwt,
    },
  }, fixture.env);
  assert.equal(retried.status, 200);
  const targetSession = await sessionIdForSubject(TEST_SUBJECTS.alice);
  assert.ok(await fixture.r2.get(workspaceKey(targetSession, WORKSPACE_ONE)));
});

test('verified first login imports the signed cookie namespace and clears the cookie', async () => {
  const fixture = await createMiddlewareFixture();
  const galleryId = 'd'.repeat(24);
  await seedGallery(fixture.r2, galleryId, SOURCE_SESSION);
  const signed = await signValue(SOURCE_SESSION, SESSION_SECRET);
  const response = await fixture.app.request('/api/session', {
    headers: {
      Cookie: `agent-studio-session=${signed}`,
      [CAIL_IDENTITY_HEADER]: fixture.identityJwt,
    },
  }, fixture.env);

  assert.equal(response.status, 200);
  const targetSession = await sessionIdForSubject(TEST_SUBJECTS.alice);
  assert.equal((await response.json()).sessionId, targetSession);
  assert.match(response.headers.get('set-cookie') ?? '', /agent-studio-session=;/);
  assert.ok(await fixture.r2.get(`agent-studio/account-import/v1/${targetSession}.json`));
  const owner = await (
    await fixture.r2.get(`agent-studio/gallery/items/${galleryId}/owner.json`)
  ).json();
  assert.equal(owner.tag, await galleryOwnerTag(targetSession, SESSION_SECRET));
});

test('invalid legacy cookies and caller-supplied identity headers cannot select import data', async () => {
  const fixture = await createMiddlewareFixture();
  const galleryId = 'e'.repeat(24);
  await seedGallery(fixture.r2, galleryId, SOURCE_SESSION);

  const callerOnly = await fixture.app.request('/api/session', {
    headers: {
      Cookie: `agent-studio-session=${await signValue(SOURCE_SESSION, SESSION_SECRET)}`,
      'x-cail-subject': 'caller-selected',
    },
  }, fixture.env);
  assert.equal(callerOnly.status, 401);

  const invalidCookie = await fixture.app.request('/api/session', {
    headers: {
      Cookie: `agent-studio-session=${SOURCE_SESSION}.${'0'.repeat(64)}`,
      [CAIL_IDENTITY_HEADER]: fixture.identityJwt,
    },
  }, fixture.env);
  assert.equal(invalidCookie.status, 200);
  assert.match(invalidCookie.headers.get('set-cookie') ?? '', /agent-studio-session=;/);
  const manifest = await (
    await fixture.r2.get(`agent-studio/gallery/items/${galleryId}/manifest.json`)
  ).json();
  assert.ok(manifest.authorId, 'invalid cookie did not select the source namespace');
});

test('login import failure returns a private retryable error and does not mark complete', async () => {
  const fixture = await createMiddlewareFixture();
  const signed = await signValue(SOURCE_SESSION, SESSION_SECRET);
  const originalPut = fixture.r2.put.bind(fixture.r2);
  let failMarker = true;
  fixture.r2.put = async (key, value, options) => {
    if (key.startsWith('agent-studio/account-import/v1/') && failMarker) {
      failMarker = false;
      throw new Error('private storage detail');
    }
    return originalPut(key, value, options);
  };
  const headers = {
    Cookie: `agent-studio-session=${signed}`,
    [CAIL_IDENTITY_HEADER]: fixture.identityJwt,
  };

  const failed = await fixture.app.request('/api/session', { headers }, fixture.env);
  assert.equal(failed.status, 503);
  const payload = await failed.json();
  assert.equal(payload.error.code, 'account_import_failed');
  assert.equal(payload.error.cail.retryable, true);
  const encoded = JSON.stringify(payload);
  assert.equal(encoded.includes(SOURCE_SESSION), false);
  assert.equal(encoded.includes(TEST_SUBJECTS.alice), false);
  assert.equal(encoded.includes('private storage detail'), false);
  assert.equal(failed.headers.get('set-cookie'), null, 'cookie remains for retry');

  const retried = await fixture.app.request('/api/session', { headers }, fixture.env);
  assert.equal(retried.status, 200);
  assert.match(retried.headers.get('set-cookie') ?? '', /agent-studio-session=;/);
  const targetSession = await sessionIdForSubject(TEST_SUBJECTS.alice);
  assert.ok(await fixture.r2.get(`agent-studio/account-import/v1/${targetSession}.json`));
});
