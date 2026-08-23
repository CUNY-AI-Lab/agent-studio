// Regression pins for the workspace write races (V2/V3, 2026-07-11).
//
// V2: three writers stored a workspace record captured EARLIER (turn start /
// request start) with a blind putWorkspace, silently reverting a concurrent
// PATCH (e.g. a model override) that the putWorkspaceIfMatch CAS loop (A12)
// exists to protect: the publish galleryId stamp, the gallery-delete record
// rewrite, and the ui_workspace chat tool.
//
// V3: applyLayoutPatch replaced the whole `connections`/`groups` arrays from a
// client snapshot, so a stale tab could resurrect a connection to a removed
// panel or clobber another tab's concurrent group edit. Groups/connections now
// merge per id like panels, with explicit removeGroups for deletion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getWorkspace, putWorkspace } from '../src/lib/workspaces.ts';
import { normalizePanelRelations } from '../src/lib/panel-connections.ts';
import { importServer, makeEnv, openSession, registerCloudflareStub } from './helpers/env.mjs';

const app = await importServer();
const deployedV1Fixture = JSON.parse(
  await readFile(new URL('./fixtures/deployed-v1-relationships.json', import.meta.url), 'utf8'),
);

function workspaceKey(sessionId, workspaceId) {
  return `agent-studio/sessions/${sessionId}/workspaces/${workspaceId}/workspace.json`;
}

async function createWorkspace(session, name) {
  const created = await session.request(app, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 201);
  return (await created.json()).workspace;
}

// ---------------------------------------------------------------------------
// V2 — publish galleryId stamp
// ---------------------------------------------------------------------------

test('publish stamps galleryId without reverting a PATCH that landed mid-publish', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'To publish');

  // Simulate a concurrent PATCH (model override) landing between the publish
  // route's request-start record capture and its galleryId stamp: fire it on
  // the first gallery-key write, which happens in that window.
  const originalPut = r2.put.bind(r2);
  let fired = false;
  r2.put = async (key, value, opts) => {
    if (!fired && key.includes('/gallery/')) {
      fired = true;
      const current = await getWorkspace(env, sessionId, workspace.id);
      await putWorkspace(env, sessionId, { ...current, model: '@cf/concurrent-override' });
    }
    return originalPut(key, value, opts);
  };

  const published = await session.request(app, `/api/workspaces/${workspace.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Published', description: 'desc' }),
  });
  assert.equal(published.status, 201);
  assert.equal(fired, true, 'test wiring: the concurrent PATCH must have fired mid-publish');
  const { item } = await published.json();

  const stored = await getWorkspace(env, sessionId, workspace.id);
  assert.equal(stored.galleryId, item.id, 'publish must stamp the galleryId');
  assert.equal(
    stored.model,
    '@cf/concurrent-override',
    'the concurrent model PATCH must survive the publish stamp'
  );
});

// ---------------------------------------------------------------------------
// V2 — gallery delete record rewrite
// ---------------------------------------------------------------------------

test('gallery delete clears galleryId without reverting a concurrent workspace update', async () => {
  const { env, r2 } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session, 'To unpublish');

  const published = await session.request(app, `/api/workspaces/${workspace.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Published', description: 'desc' }),
  });
  assert.equal(published.status, 201);
  const { item } = await published.json();

  // Simulate a concurrent update landing between the delete route's
  // listWorkspaces read and its record rewrite: apply it right after the
  // route's first read of this workspace record, which returns the stale copy.
  const key = workspaceKey(sessionId, workspace.id);
  const originalGet = r2.get.bind(r2);
  let fired = false;
  r2.get = async (getKey) => {
    const result = await originalGet(getKey);
    if (!fired && getKey === key && result) {
      fired = true;
      const current = await (await originalGet(getKey)).json();
      await putWorkspace(env, sessionId, { ...current, description: 'concurrent description' });
    }
    return result;
  };

  const deleted = await session.request(app, `/api/gallery/${item.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(fired, true, 'test wiring: the concurrent update must have fired mid-delete');

  const stored = await getWorkspace(env, sessionId, workspace.id);
  assert.equal(stored.galleryId, undefined, 'gallery delete must clear the galleryId');
  assert.equal(
    stored.description,
    'concurrent description',
    'the concurrent update must survive the galleryId rewrite'
  );
});

// ---------------------------------------------------------------------------
// V2 — ui_workspace chat tool
// ---------------------------------------------------------------------------

test('ui_workspace tool does not revert a PATCH that landed after turn start', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

  const { env } = makeEnv();
  const sessionId = 'a'.repeat(32);
  const turnStartRecord = {
    id: 'b'.repeat(32),
    name: 'Before',
    description: 'original',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await putWorkspace(env, sessionId, turnStartRecord);

  // Concurrent PATCH lands while the turn is streaming, after the tool
  // closures captured `turnStartRecord`.
  await putWorkspace(env, sessionId, { ...turnStartRecord, model: '@cf/concurrent-override' });

  const fakeAgent = {
    env,
    synced: null,
    assertNotFrozen() {},
    async withMutationFence(operation) { return operation(); },
    async syncWorkspace(nextWorkspace, syncSessionId) {
      this.synced = { workspace: nextWorkspace, sessionId: syncSessionId };
    },
  };
  const tools = WorkspaceAgent.prototype.buildHostTools.call(fakeAgent, turnStartRecord, sessionId);
  const result = await tools.ui_workspace.execute(
    { name: 'Renamed' },
    { toolCallId: 'tool-1', messages: [] },
  );

  const stored = await getWorkspace(env, sessionId, turnStartRecord.id);
  assert.equal(stored.name, 'Renamed', 'the rename must be applied');
  assert.equal(
    stored.model,
    '@cf/concurrent-override',
    'the concurrent model PATCH must survive the ui_workspace write'
  );
  assert.equal(result.name, 'Renamed');
  assert.equal(fakeAgent.synced?.workspace.model, '@cf/concurrent-override');
  assert.equal(fakeAgent.synced?.sessionId, sessionId);
});

test('structured UI tools persist explicit tile associations', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const source = panel('source');
  const fake = {
    state: {
      sessionId: 'session',
      workspace: null,
      panels: [source],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    setState(next) {
      this.state = next;
    },
    async withMutationFence(operation) {
      return operation();
    },
  };
  fake.upsertPanelWithAssociation = (nextPanel, sourcePanelId) =>
    WorkspaceAgent.prototype.upsertPanelWithAssociation.call(fake, nextPanel, sourcePanelId);

  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    fake,
    { id: 'workspace', name: 'Workspace', description: '', createdAt: '', updatedAt: '' },
    'session',
  );

  const tableResult = await tools.ui_table.execute({
    id: 'table',
    title: 'Table',
    columns: [{ key: 'name', label: 'Name' }],
    rows: [{ name: 'Ada' }],
    sourcePanelId: 'source',
  });
  assert.equal(tableResult.panelId, 'table');
  assert.deepEqual(fake.state.connections, [
    { id: 'connection-source-table', sourceId: 'source', targetId: 'table' },
  ]);

  const detailResult = await tools.ui_detail.execute({
    id: 'detail',
    title: 'Detail',
    linkedTo: 'table',
  });
  assert.equal(detailResult.panelId, 'detail');
  assert.deepEqual(
    fake.state.connections.map(({ sourceId, targetId }) => ({ sourceId, targetId })),
    [
      { sourceId: 'source', targetId: 'table' },
      { sourceId: 'detail', targetId: 'table' },
    ],
  );
  assert.equal(fake.state.panels.find((candidate) => candidate.id === 'table').sourcePanelId, 'source');
});

test('structured UI tools reject an association to a missing tile', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const fake = {
    state: {
      sessionId: 'session',
      workspace: null,
      panels: [panel('source')],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    setState(next) {
      this.state = next;
    },
    async withMutationFence(operation) {
      return operation();
    },
  };
  fake.upsertPanelWithAssociation = (nextPanel, sourcePanelId) =>
    WorkspaceAgent.prototype.upsertPanelWithAssociation.call(fake, nextPanel, sourcePanelId);
  const tools = WorkspaceAgent.prototype.buildHostTools.call(
    fake,
    { id: 'workspace', name: 'Workspace', description: '', createdAt: '', updatedAt: '' },
    'session',
  );

  await assert.rejects(
    tools.ui_markdown.execute({
      id: 'markdown',
      title: 'Markdown',
      content: 'content',
      sourcePanelId: 'missing',
    }),
    /Panel not found: missing/,
  );
  assert.deepEqual(fake.state.panels.map((candidate) => candidate.id), ['source']);
  assert.deepEqual(fake.state.connections, []);
});

test('addPanel persists a supplied sourcePanelId as an explicit association', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const fake = {
    state: {
      sessionId: 'session',
      workspace: null,
      panels: [panel('source')],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    setState(next) {
      this.state = next;
    },
  };
  fake.upsertPanelWithAssociation = (nextPanel, sourcePanelId) =>
    WorkspaceAgent.prototype.upsertPanelWithAssociation.call(fake, nextPanel, sourcePanelId);

  await WorkspaceAgent.prototype.addPanel.call(fake, {
    ...panel('child'),
    sourcePanelId: 'source',
  });

  assert.deepEqual(fake.state.connections, [
    { id: 'connection-child-source', sourceId: 'child', targetId: 'source' },
  ]);
});

test('reassociating a panel replaces its prior visible edge and provenance', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const fake = {
    state: {
      sessionId: 'session',
      workspace: null,
      panels: [panel('source-a'), panel('source-b'), { ...panel('child'), sourcePanelId: 'source-a' }],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [{ id: 'connection-child-source-a', sourceId: 'child', targetId: 'source-a' }],
    },
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    setState(next) {
      this.state = next;
    },
  };
  fake.upsertPanelWithAssociation = (nextPanel, sourcePanelId) =>
    WorkspaceAgent.prototype.upsertPanelWithAssociation.call(fake, nextPanel, sourcePanelId);

  await WorkspaceAgent.prototype.addPanel.call(fake, {
    ...panel('child'),
    sourcePanelId: 'source-b',
  });

  assert.equal(fake.state.panels.find((candidate) => candidate.id === 'child').sourcePanelId, 'source-b');
  assert.deepEqual(fake.state.connections, [
    { id: 'connection-child-source-b', sourceId: 'child', targetId: 'source-b' },
  ]);
});

test('disconnect and source removal clear detail linkage metadata', async () => {
  const detail = {
    id: 'detail',
    type: 'detail',
    title: 'Detail',
    sourcePanelId: 'source',
    linkedTo: 'source',
  };
  const state = {
    sessionId: null,
    workspace: null,
    panels: [panel('source'), detail],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [{ id: 'connection-detail-source', sourceId: 'detail', targetId: 'source' }],
  };
  const { fake, applyLayoutPatch, removePanel } = await makeLayoutAgent(state);

  await applyLayoutPatch({ removeConnections: ['connection-detail-source'] });
  const disconnected = fake.state.panels.find((candidate) => candidate.id === 'detail');
  assert.equal(disconnected.sourcePanelId, undefined);
  assert.equal(disconnected.linkedTo, undefined);

  // Recreate the persisted relationship, then remove its source tile as a
  // separate lifecycle action. Both paths must leave the same normalized state.
  fake.state = {
    ...fake.state,
    panels: [panel('source'), { ...detail }],
    connections: [{ id: 'connection-detail-source', sourceId: 'detail', targetId: 'source' }],
  };
  await removePanel('source');
  const removedSource = fake.state.panels.find((candidate) => candidate.id === 'detail');
  assert.equal(removedSource.sourcePanelId, undefined);
  assert.equal(removedSource.linkedTo, undefined);
  assert.deepEqual(fake.state.connections, []);
});

test('replaceWorkspaceState normalizes imported relationship fields independently before reload', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const fake = {
    state: { panels: [], connections: [] },
    setState(next) {
      this.state = next;
    },
  };
  const importedPanels = [
    panel('source'),
    {
      id: 'detail',
      type: 'detail',
      title: 'Detail',
      sourcePanelId: 'source',
      linkedTo: 'stale-source',
    },
  ];
  await WorkspaceAgent.prototype.replaceWorkspaceState.call(fake, {
    sessionId: 'old',
    workspace: null,
    panels: importedPanels,
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [{ id: 'connection-stale', sourceId: 'detail', targetId: 'stale-source' }],
  }, { id: 'workspace', name: 'Workspace', description: '', createdAt: '', updatedAt: '' }, 'session');

  const detail = fake.state.panels.find((candidate) => candidate.id === 'detail');
  assert.equal(detail.sourcePanelId, 'source');
  assert.equal(detail.linkedTo, undefined);
  assert.deepEqual(fake.state.connections, [
    { id: 'connection-detail-source', sourceId: 'detail', targetId: 'source' },
  ]);
});

test('deployed-v1 relations survive import/onStart and normalization is idempotent', async () => {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const imported = {
    state: { ...deployedV1Fixture.state, panels: deployedV1Fixture.state.panels.map((panel) => ({ ...panel })) },
    setState(next) {
      this.state = next;
    },
  };
  await WorkspaceAgent.prototype.replaceWorkspaceState.call(
    imported,
    deployedV1Fixture.state,
    deployedV1Fixture.workspace,
    'session',
  );

  const importedDetail = imported.state.panels.find((panel) => panel.id === 'source-detail');
  assert.equal(importedDetail.sourcePanelId, 'source-table');
  assert.equal(importedDetail.linkedTo, 'source-table');
  assert.deepEqual(imported.state.connections, [
    { id: 'connection-source-detail-source-table', sourceId: 'source-detail', targetId: 'source-table' },
  ]);
  assert.deepEqual(
    normalizePanelRelations(imported.state.panels, imported.state.connections),
    { panels: imported.state.panels, connections: imported.state.connections },
  );

  const onStart = {
    state: imported.state,
    cailIdentityJwt: 'already-verified-for-test',
    ctx: { storage: { get: async () => undefined } },
    setState(next) {
      this.state = next;
    },
  };
  await WorkspaceAgent.prototype.onStart.call(onStart);
  const startedDetail = onStart.state.panels.find((panel) => panel.id === 'source-detail');
  assert.equal(startedDetail.sourcePanelId, 'source-table');
  assert.equal(startedDetail.linkedTo, 'source-table');
  assert.deepEqual(onStart.state.connections, imported.state.connections);
});

test('normalization preserves independent sourcePanelId and linkedTo fields', () => {
  const panels = [
    panel('source-a'),
    panel('source-b'),
    { ...panel('equal-detail'), type: 'detail', sourcePanelId: 'source-a', linkedTo: 'source-a' },
    { ...panel('source-only'), type: 'detail', sourcePanelId: 'source-a' },
    { ...panel('linked-only'), type: 'detail', linkedTo: 'source-b' },
    { ...panel('split-detail'), type: 'detail', sourcePanelId: 'source-a', linkedTo: 'source-b' },
    { ...panel('dangling-detail'), type: 'detail', sourcePanelId: 'missing', linkedTo: 'source-b' },
  ];
  const normalized = normalizePanelRelations(panels, [
    { id: 'manual', sourceId: 'source-b', targetId: 'source-a' },
    { id: 'duplicate', sourceId: 'source-a', targetId: 'source-b' },
    { id: 'self', sourceId: 'source-a', targetId: 'source-a' },
    { id: 'dangling', sourceId: 'source-a', targetId: 'missing' },
  ]);

  const equalDetail = normalized.panels.find((candidate) => candidate.id === 'equal-detail');
  const sourceOnly = normalized.panels.find((candidate) => candidate.id === 'source-only');
  const linkedOnly = normalized.panels.find((candidate) => candidate.id === 'linked-only');
  const splitDetail = normalized.panels.find((candidate) => candidate.id === 'split-detail');
  const danglingDetail = normalized.panels.find((candidate) => candidate.id === 'dangling-detail');
  assert.deepEqual(
    {
      equalSource: equalDetail.sourcePanelId,
      equalLinked: equalDetail.linkedTo,
      sourceOnly: sourceOnly.sourcePanelId,
      sourceOnlyLinked: sourceOnly.linkedTo,
      linkedOnly: linkedOnly.sourcePanelId,
      linkedOnlyLinked: linkedOnly.linkedTo,
      splitSource: splitDetail.sourcePanelId,
      splitLinked: splitDetail.linkedTo,
      danglingSource: danglingDetail.sourcePanelId,
      danglingLinked: danglingDetail.linkedTo,
    },
    {
      equalSource: 'source-a',
      equalLinked: 'source-a',
      sourceOnly: 'source-a',
      sourceOnlyLinked: undefined,
      linkedOnly: undefined,
      linkedOnlyLinked: 'source-b',
      splitSource: 'source-a',
      splitLinked: 'source-b',
      danglingSource: undefined,
      danglingLinked: 'source-b',
    },
  );
  assert.deepEqual(normalized.connections.map(({ sourceId, targetId }) => [sourceId, targetId]), [
    ['source-b', 'source-a'],
    ['equal-detail', 'source-a'],
    ['source-a', 'source-only'],
    ['linked-only', 'source-b'],
    ['source-a', 'split-detail'],
    ['source-b', 'split-detail'],
    ['dangling-detail', 'source-b'],
  ]);
});

// ---------------------------------------------------------------------------
// V3 — applyLayoutPatch merges connections/groups per id
// ---------------------------------------------------------------------------

async function makeLayoutAgent(state) {
  registerCloudflareStub();
  const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');
  const fake = {
    state,
    assertNotFrozen() {},
    assertAuthorizedRpc() {},
    setState(next) {
      this.state = next;
    },
  };
  return {
    fake,
    applyLayoutPatch: (patch) => WorkspaceAgent.prototype.applyLayoutPatch.call(fake, patch),
    removePanel: (panelId) => WorkspaceAgent.prototype.removePanel.call(fake, panelId),
  };
}

function panel(id) {
  return { id, type: 'markdown', title: id, content: '' };
}

test('a stale client connections array cannot resurrect a removed-panel connection', async () => {
  const { fake, applyLayoutPatch, removePanel } = await makeLayoutAgent({
    sessionId: null,
    workspace: null,
    panels: [panel('a'), panel('b')],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [{ id: 'conn-a-b', sourceId: 'a', targetId: 'b' }],
  });

  // A stale tab captured the connections array before the server removed
  // panel b (which filters the connection out).
  const staleConnections = [...fake.state.connections];
  await removePanel('b');
  assert.deepEqual(fake.state.connections, []);

  await applyLayoutPatch({ connections: staleConnections });
  assert.deepEqual(
    fake.state.connections,
    [],
    'a connection to a removed panel must not be resurrected by a stale patch'
  );
});

test('a connection can be explicitly removed without replacing concurrent connections', async () => {
  const { fake, applyLayoutPatch } = await makeLayoutAgent({
    sessionId: null,
    workspace: null,
    panels: [panel('a'), panel('b'), panel('c')],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    connections: [
      { id: 'connection-a-b', sourceId: 'a', targetId: 'b' },
      { id: 'connection-b-c', sourceId: 'b', targetId: 'c' },
    ],
  });

  await applyLayoutPatch({ removeConnections: ['connection-a-b'] });

  assert.deepEqual(fake.state.connections, [
    { id: 'connection-b-c', sourceId: 'b', targetId: 'c' },
  ]);
});

test('concurrent group edits from two tabs both survive', async () => {
  const { fake, applyLayoutPatch } = await makeLayoutAgent({
    sessionId: null,
    workspace: null,
    panels: [panel('a'), panel('b'), panel('c'), panel('d')],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [
      { id: 'group-x', name: 'x', panelIds: ['a', 'b'] },
      { id: 'group-y', name: 'y', panelIds: ['c', 'd'] },
    ],
    connections: [],
  });

  // Tab A renames group-x; tab B (unaware of the rename) renames group-y.
  await applyLayoutPatch({ groups: [{ id: 'group-x', name: 'x-renamed', panelIds: ['a', 'b'] }] });
  await applyLayoutPatch({ groups: [{ id: 'group-y', name: 'y-renamed', panelIds: ['c', 'd'] }] });

  const byId = new Map(fake.state.groups.map((group) => [group.id, group]));
  assert.equal(byId.get('group-x')?.name, 'x-renamed', "tab A's rename must survive tab B's edit");
  assert.equal(byId.get('group-y')?.name, 'y-renamed', "tab B's rename must be applied");
  assert.equal(fake.state.groups.length, 2);
});

test('removeGroups deletes a group explicitly and stale group upserts cannot resurrect removed panels', async () => {
  const { fake, applyLayoutPatch, removePanel } = await makeLayoutAgent({
    sessionId: null,
    workspace: null,
    panels: [panel('a'), panel('b'), panel('c'), panel('d')],
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [
      { id: 'group-x', name: 'x', panelIds: ['a', 'b'] },
      { id: 'group-y', name: 'y', panelIds: ['c', 'd'] },
    ],
    connections: [],
  });

  await applyLayoutPatch({ removeGroups: ['group-y'] });
  assert.deepEqual(
    fake.state.groups.map((group) => group.id),
    ['group-x'],
    'removeGroups must delete exactly the named group'
  );

  // Server removes panel b, collapsing group-x below two members.
  await removePanel('b');
  assert.deepEqual(fake.state.groups, []);

  // A stale tab re-sends group-x still containing the removed panel.
  await applyLayoutPatch({ groups: [{ id: 'group-x', name: 'x', panelIds: ['a', 'b'] }] });
  assert.deepEqual(
    fake.state.groups,
    [],
    'a stale group upsert must not resurrect a removed panel membership'
  );
});
