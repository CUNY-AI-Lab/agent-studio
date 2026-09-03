import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  importServer,
  makeEnv,
  makeImportBundle,
  openSession,
} from './helpers/env.mjs';

const app = await importServer();
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

function jsonInit(method, body) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function createWorkspace(session) {
  const response = await session.request(app, '/api/workspaces', jsonInit('POST', {
    name: 'Storage race',
  }));
  assert.equal(response.status, 201);
  return (await response.json()).workspace;
}

test('workspace unpublish waits for an in-flight publish before deleting its gallery copy', async () => {
  const { env, r2 } = makeEnv();
  const { session } = await openSession(app, env);
  const workspace = await createWorkspace(session);

  const uploaded = await session.request(app, `/api/workspaces/${workspace.id}/files/keep.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: 'keep me',
  });
  assert.equal(uploaded.status, 200);

  const originalPut = r2.put.bind(r2);
  let entered = false;
  let releasePublish;
  const publishBlocked = new Promise((resolve) => {
    releasePublish = resolve;
  });
  let signalPublishWrite;
  const publishWriteStarted = new Promise((resolve) => {
    signalPublishWrite = resolve;
  });
  const originalGet = r2.get.bind(r2);
  let observedWorkspaceReads = 0;
  r2.get = async (key) => {
    const result = await originalGet(key);
    if (key.endsWith(`/workspaces/${workspace.id}/workspace.json`)
      && entered
      && observedWorkspaceReads++ === 0) {
      // This read occurs only after the queued publish has committed its
      // galleryId. The unpublish implementation must not use the request's
      // stale workspace snapshot from before that commit.
      assert.ok(result?.body, 'the queued unpublish must read current metadata');
    }
    return result;
  };
  r2.put = async (key, value, options = {}) => {
    if (!entered && /\/gallery\/items\/[^/]+\/files\/keep\.md$/.test(key)) {
      entered = true;
      signalPublishWrite();
      await publishBlocked;
    }
    return originalPut(key, value, options);
  };

  const operationId = crypto.randomUUID();
  const publishing = session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    jsonInit('POST', {
      title: 'Racing publish',
      description: 'Must be linearized',
      operationId,
    }),
  );
  await publishWriteStarted;

  // The second request starts while the first operation is still in its
  // gallery copy. Its DO operation must wait, then read the committed
  // galleryId from inside the queue rather than using this stale HTTP record.
  const unpublishing = session.request(
    app,
    `/api/workspaces/${workspace.id}/publish`,
    { method: 'DELETE' },
  );
  releasePublish();

  const [publishResponse, unpublishResponse] = await Promise.all([publishing, unpublishing]);
  assert.equal(publishResponse.status, 201);
  assert.equal(unpublishResponse.status, 200);

  const published = await publishResponse.json();
  const galleryRead = await session.request(app, `/api/gallery/${published.item.id}`);
  assert.equal(galleryRead.status, 404);
  const workspaceRead = await session.request(app, `/api/workspaces/${workspace.id}`);
  assert.equal((await workspaceRead.json()).workspace.galleryId, undefined);
});

test('a later upload cannot be overwritten by an earlier upload rollback', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  await agent.writeWorkspaceFileContent('existing.txt', 'original', 'text/plain');

  let concurrentUpload;
  let concurrentStarted = false;
  agent.afterUploadWrite = async (index) => {
    if (index !== 0 || concurrentStarted) return;
    concurrentStarted = true;
    const form = new FormData();
    form.append('files', new File(['winner'], 'existing.txt', { type: 'text/plain' }));
    concurrentUpload = session.request(app, `/api/workspaces/${workspace.id}/upload`, {
      method: 'POST',
      body: form,
    });
    // Let the second request reach the workspace operation boundary while the
    // first request is still between its writes and rollback.
    await Promise.resolve();
    await Promise.resolve();
  };
  agent.uploadWriteFailure = (_entry, index) => index === 1;

  const form = new FormData();
  form.append('files', new File(['loser'], 'existing.txt', { type: 'text/plain' }));
  form.append('files', new File(['trigger'], 'trigger.txt', { type: 'text/plain' }));
  const failed = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failed.status, 500);
  assert.ok(concurrentUpload, 'the concurrent upload must have started');

  const winner = await concurrentUpload;
  assert.equal(winner.status, 201);
  const existing = await agent.readWorkspaceFileContent('existing.txt');
  assert.equal(new TextDecoder().decode(existing.data), 'winner');
  assert.equal(await agent.readWorkspaceFileContent('trigger.txt'), null);
});

test('a direct file RPC waits behind an upload rollback before committing', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  await agent.writeWorkspaceFileContent('existing.txt', 'original', 'text/plain');

  let directWriteStarted;
  const directWriteEntered = new Promise((resolve) => {
    directWriteStarted = resolve;
  });
  const realWrite = agent.writeWorkspaceFileContent.bind(agent);
  agent.writeWorkspaceFileContent = async (...args) => {
    directWriteStarted();
    return realWrite(...args);
  };
  let directWrite;
  agent.afterUploadWrite = async (index) => {
    if (index !== 0) return;
    directWrite = session.request(app, `/api/workspaces/${workspace.id}/files/existing.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'winner',
    });
    await directWriteEntered;
  };
  agent.uploadWriteFailure = (_entry, index) => index === 1;

  const form = new FormData();
  form.append('files', new File(['loser'], 'existing.txt', { type: 'text/plain' }));
  form.append('files', new File(['trigger'], 'trigger.txt', { type: 'text/plain' }));
  const failed = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failed.status, 500);
  assert.ok(directWrite, 'the direct file RPC must have started');

  const winner = await directWrite;
  assert.equal(winner.status, 200);
  const existing = await agent.readWorkspaceFileContent('existing.txt');
  assert.equal(new TextDecoder().decode(existing.data), 'winner');
  assert.equal(await agent.readWorkspaceFileContent('trigger.txt'), null);
});

test('a native state write waits behind an upload rollback before committing', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  await agent.writeWorkspaceFileContent('existing.txt', 'original', 'text/plain');

  const stateProvider = agent.buildSerializedStateTools();
  let stateWrite;
  let stateStarted = false;
  agent.afterUploadWrite = async (index) => {
    if (index !== 0 || stateStarted) return;
    stateStarted = true;
    stateWrite = stateProvider.tools.writeFile.execute({
      path: '/existing.txt',
      content: 'state winner',
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  agent.uploadWriteFailure = (_entry, index) => index === 1;

  const form = new FormData();
  form.append('files', new File(['loser'], 'existing.txt', { type: 'text/plain' }));
  form.append('files', new File(['trigger'], 'trigger.txt', { type: 'text/plain' }));
  const failed = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failed.status, 500);
  assert.ok(stateWrite, 'the native state write must have started');
  await stateWrite;

  const existing = await agent.readWorkspaceFileContent('existing.txt');
  assert.equal(new TextDecoder().decode(existing.data), 'state winner');
  assert.equal(await agent.readWorkspaceFileContent('trigger.txt'), null);
});

test('a native Git write waits behind an upload rollback before committing', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const agent = agents.get(`${sessionId}-${workspace.id}`);

  const gitProvider = agent.buildSerializedGitTools();
  let gitWrite;
  let gitStarted = false;
  agent.afterUploadWrite = async (index) => {
    if (index !== 0 || gitStarted) return;
    gitStarted = true;
    gitWrite = gitProvider.tools.init.execute({ dir: '/' });
    await Promise.resolve();
    await Promise.resolve();
  };
  agent.uploadWriteFailure = (_entry, index) => index === 1;

  const form = new FormData();
  form.append('files', new File(['loser'], 'loser.txt', { type: 'text/plain' }));
  form.append('files', new File(['trigger'], 'trigger.txt', { type: 'text/plain' }));
  const failed = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failed.status, 500);
  assert.ok(gitWrite, 'the native Git write must have started');
  assert.deepEqual(await gitWrite, { initialized: '/' });
  assert.equal(await agent.readWorkspaceFileContent('trigger.txt'), null);
  assert.ok(await agent.readWorkspaceFileContent('.git/HEAD'));
});

test('a host write tool waits behind an upload rollback before committing', async () => {
  const { env, agents } = makeEnv();
  const { session, sessionId } = await openSession(app, env);
  const workspace = await createWorkspace(session);
  const agent = agents.get(`${sessionId}-${workspace.id}`);
  await agent.writeWorkspaceFileContent('existing.txt', 'original', 'text/plain');

  const hostTools = WorkspaceAgent.prototype.buildHostTools.call(agent, workspace, sessionId);
  let hostWrite;
  let hostStarted = false;
  agent.afterUploadWrite = async (index) => {
    if (index !== 0 || hostStarted) return;
    hostStarted = true;
    hostWrite = hostTools.write_file.execute({
      filePath: 'existing.txt',
      content: 'host winner',
      mode: 'replace',
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  agent.uploadWriteFailure = (_entry, index) => index === 1;

  const form = new FormData();
  form.append('files', new File(['loser'], 'existing.txt', { type: 'text/plain' }));
  form.append('files', new File(['trigger'], 'trigger.txt', { type: 'text/plain' }));
  const failed = await session.request(app, `/api/workspaces/${workspace.id}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failed.status, 500);
  assert.ok(hostWrite, 'the host write must have started');
  assert.deepEqual(await hostWrite, { ok: true, filePath: 'existing.txt' });

  const existing = await agent.readWorkspaceFileContent('existing.txt');
  assert.equal(new TextDecoder().decode(existing.data), 'host winner');
  assert.equal(await agent.readWorkspaceFileContent('trigger.txt'), null);
});

test('import reports an unknown outcome when rollback cleanup fails', async () => {
  const { env } = makeEnv();
  const { session } = await openSession(app, env);
  const realGet = env.WorkspaceAgent.get.bind(env.WorkspaceAgent);
  env.WorkspaceAgent.get = (id) => {
    const agent = realGet(id);
    agent.writeWorkspaceFileContent = async () => {
      throw new Error('injected import write failure');
    };
    return agent;
  };
  const realList = env.WORKSPACE_FILES.list.bind(env.WORKSPACE_FILES);
  env.WORKSPACE_FILES.list = async (options = {}) => {
    if (options.prefix?.startsWith('agent-studio/runtime/')) {
      throw new Error('injected runtime cleanup failure');
    }
    return realList(options);
  };

  const form = new FormData();
  form.append('bundle', new File([JSON.stringify(makeImportBundle())], 'import.json', {
    type: 'application/json',
  }));
  const response = await session.request(app, '/api/workspaces/import', {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.error.code, 'internal_error');
});
