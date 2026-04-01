import {
  SessionClient,
  connectAgent,
  createWorkspace,
  fetchObservability,
  fetchWorkspace,
  parseArgs,
  sendChatTurn,
} from './_debug-common.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function log(step, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  console.log(`[smoke] ${step}${suffix}`);
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', baseUrl));
      if (response.ok) {
        const payload = await response.json();
        assert(payload?.ok === true, 'Health check did not return ok=true');
        return payload;
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for /health: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

function jsonRequest(body) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] || 'http://127.0.0.1:8787';
  const workspaceName = args.name || 'Smoke Test Workspace';
  const healthTimeoutMs = Number(args['health-timeout-ms'] || 30000);
  const withChat = args['with-chat'] === 'true';

  log('health', baseUrl);
  await waitForHealth(baseUrl, healthTimeoutMs);

  const session = new SessionClient(baseUrl, args.cookie || process.env.AGENT_STUDIO_COOKIE || '');
  const sessionId = await session.ensureSession();
  assert(Boolean(sessionId), 'Session middleware did not return a session id');
  log('session', sessionId);

  const before = await session.json('/api/workspaces');
  assert(Array.isArray(before.workspaces), 'Workspace list payload is invalid');
  log('workspaces-before', String(before.workspaces.length));

  let workspaceId = null;

  try {
    const workspace = await createWorkspace(session, workspaceName);
    workspaceId = workspace.id;
    assert(workspaceId, 'Workspace creation did not return an id');
    log('workspace-created', workspaceId);

    const created = await fetchWorkspace(session, workspaceId);
    assert(created.workspace.id === workspaceId, 'Workspace fetch returned the wrong id');
    assert(created.agent?.className === 'WorkspaceAgent', 'Workspace agent metadata is missing');
    assert(created.runtime?.provider === 'dynamic-workers', 'Runtime provider is not dynamic-workers');
    assert(created.state?.panels?.some((panel) => panel.id === 'chat'), 'Initial chat panel is missing');
    log('workspace-fetched', created.workspace.name);

    const patched = await session.json(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      ...jsonRequest({
        name: `${workspaceName} Updated`,
        description: 'Worker smoke test workspace',
      }),
    });
    assert(patched.workspace.name === `${workspaceName} Updated`, 'Workspace patch did not update the name');
    log('workspace-patched', patched.workspace.name);

    const html = '<!doctype html><html><body><h1>smoke ok</h1></body></html>';
    const putFileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/index.html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    });
    assert(putFileResponse.ok, `File write failed with ${putFileResponse.status}`);
    log('file-written', 'index.html');

    const filesPayload = await session.json(`/api/workspaces/${workspaceId}/files`);
    assert(
      Array.isArray(filesPayload.files) && filesPayload.files.some((file) => file.path === 'index.html'),
      'Workspace files listing does not include index.html'
    );
    log('files-listed', String(filesPayload.files.length));

    const fileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/index.html`);
    assert(fileResponse.ok, `File fetch failed with ${fileResponse.status}`);
    const fileText = await fileResponse.text();
    assert(fileText.includes('smoke ok'), 'Fetched file content is incorrect');
    assert((fileResponse.headers.get('content-type') || '').includes('text/html'), 'File content type is not text/html');
    assert(fileResponse.headers.get('cache-control') === 'no-store', 'Workspace file cache-control should be no-store');
    log('file-fetched', fileResponse.headers.get('content-type') || 'unknown');

    const panelPayload = await session.json(`/api/workspaces/${workspaceId}/panels`, {
      method: 'POST',
      ...jsonRequest({
        panel: {
          id: 'smoke-panel',
          type: 'markdown',
          title: 'Smoke Panel',
          content: 'smoke ok',
        },
      }),
    });
    assert(
      panelPayload.state?.panels?.some((panel) => panel.id === 'smoke-panel'),
      'Panel add did not return the new panel'
    );
    log('panel-added', 'smoke-panel');

    const layoutPayload = await session.json(`/api/workspaces/${workspaceId}/layout`, {
      method: 'PATCH',
      ...jsonRequest({
        panels: {
          'smoke-panel': {
            x: 180,
            y: 140,
            width: 420,
            height: 240,
          },
        },
        viewport: {
          x: -120,
          y: 80,
          zoom: 1.1,
        },
      }),
    });
    const smokePanel = layoutPayload.state?.panels?.find((panel) => panel.id === 'smoke-panel');
    assert(smokePanel?.layout?.x === 180 && smokePanel?.layout?.y === 140, 'Layout patch did not persist panel coordinates');
    assert(layoutPayload.state?.viewport?.zoom === 1.1, 'Layout patch did not persist viewport changes');
    log('layout-patched', 'smoke-panel');

    const runtimePayload = await session.json(`/api/workspaces/${workspaceId}/runtime/execute`, {
      method: 'POST',
      ...jsonRequest({
        code: 'async () => { const entries = await state.readdir("/"); return entries; }',
      }),
    });
    assert(runtimePayload.execution && !runtimePayload.execution.error, `Runtime execution failed: ${runtimePayload.execution?.error || 'unknown error'}`);
    log('runtime-executed', 'ok');

    if (withChat) {
      log('chat', 'starting');
      const workspacePayload = await fetchWorkspace(session, workspaceId);
      const client = await connectAgent(session, workspacePayload);
      try {
        const chatResult = await sendChatTurn({
          client,
          messages: workspacePayload.messages,
          prompt: 'Create a markdown tile titled "Smoke Chat" containing exactly the text "chat smoke ok".',
          idleTimeoutMs: Number(args['idle-timeout-ms'] || 60000),
          totalTimeoutMs: Number(args['total-timeout-ms'] || 180000),
          verbose: args.quiet !== 'true',
        });
        assert(chatResult.ok, `Chat request did not complete: ${chatResult.reason || 'unknown error'}`);

        const observability = await fetchObservability(session, workspaceId);
        const latestRequest = observability.requests[0];
        assert(latestRequest, 'Observability did not record the chat request');
        assert(latestRequest.status === 'finished', `Chat observability status is ${latestRequest.status}`);

        const postChat = await fetchWorkspace(session, workspaceId);
        assert(postChat.messages.some((message) => message.role === 'assistant'), 'Chat did not produce an assistant message');
        log('chat', 'finished');
      } finally {
        client.close();
      }
    }
  } finally {
    if (workspaceId) {
      const deleteResponse = await session.fetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' });
      assert(deleteResponse.ok, `Workspace delete failed with ${deleteResponse.status}`);
      const after = await session.json('/api/workspaces');
      assert(!after.workspaces.some((workspace) => workspace.id === workspaceId), 'Workspace still appears in the list after deletion');
      log('workspace-deleted', workspaceId);
    }
  }

  log('done', withChat ? 'api + chat smoke passed' : 'api smoke passed');
}

main().catch((error) => {
  console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
