import {
  assertIdentityCredentials,
  SessionClient,
  connectAgent,
  createWorkspace,
  fetchWorkspace,
  identityCredentialsFromEnv,
  parseArgs,
  redactSensitiveText,
  sendChatTurn,
} from './smoke-common.mjs';

const HEALTH_TIMEOUT_MS = 30000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function log(step) {
  console.log(`[smoke] ${step}`);
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('health', `${baseUrl.replace(/\/+$/, '')}/`));
      if (response.ok) {
        const payload = await response.json();
        assert(payload?.ok === true, 'Health check did not return ok=true');
        return payload;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for /health');
}

function jsonRequest(body) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] || process.env.AGENT_STUDIO_STAGING_URL || 'http://127.0.0.1:8787';
  const workspaceName = args.name || 'Agent Studio smoke workspace';
  const withChat = args['with-chat'] === 'true';
  const identity = assertIdentityCredentials(identityCredentialsFromEnv(), { withChat });

  await waitForHealth(baseUrl);
  log('health ready');

  const session = new SessionClient(
    baseUrl,
    args.cookie || process.env.AGENT_STUDIO_COOKIE || '',
    identity,
  );
  const sessionId = await session.ensureSession();
  assert(Boolean(sessionId), 'Session middleware did not return a session id');
  log('session established');

  const before = await session.json('/api/workspaces');
  assert(Array.isArray(before.workspaces), 'Workspace list payload is invalid');
  log('workspace listing readable');

  let workspaceId = null;

  try {
    const workspace = await createWorkspace(session, workspaceName);
    workspaceId = workspace.id;
    assert(workspaceId, 'Workspace creation did not return an id');
    log('workspace created');

    const created = await fetchWorkspace(session, workspaceId, { includeGateway: true });
    assert(created.workspace.id === workspaceId, 'Workspace fetch returned the wrong id');
    assert(created.agent?.className === 'WorkspaceAgent', 'Workspace agent metadata is missing');
    assert(created.runtime?.provider === 'dynamic-workers', 'Runtime provider is not dynamic-workers');
    assert(created.state?.panels?.some((panel) => panel.id === 'chat'), 'Initial chat panel is missing');
    log('workspace state readable');

    const liveAgent = await connectAgent(session, created);
    liveAgent.close();
    log('protected WebSocket connected');

    const patched = await session.json(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      ...jsonRequest({
        name: `${workspaceName} Updated`,
        description: 'Worker smoke test workspace',
      }),
    });
    assert(patched.workspace.name === `${workspaceName} Updated`, 'Workspace patch did not update the name');
    log('workspace update persisted');

    // Active document types are rejected at the upload boundary.
    const evilHtmlResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/index.html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><script>alert(1)</script>',
    });
    assert(evilHtmlResponse.status === 400, `Active-type PUT should be rejected, got ${evilHtmlResponse.status}`);
    log('unsafe file rejected');

    const markdown = '# smoke ok';
    const putFileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/notes.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: markdown,
    });
    assert(putFileResponse.ok, `File write failed with ${putFileResponse.status}`);
    log('file write persisted');

    const filesPayload = await session.json(`/api/workspaces/${workspaceId}/files`);
    assert(
      Array.isArray(filesPayload.files) && filesPayload.files.some((file) => file.path === 'notes.md'),
      'Workspace files listing does not include notes.md'
    );
    log('file listing readable');

    const fileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/notes.md`);
    assert(fileResponse.ok, `File fetch failed with ${fileResponse.status}`);
    const fileText = await fileResponse.text();
    assert(fileText.includes('smoke ok'), 'Fetched file content is incorrect');
    assert((fileResponse.headers.get('content-type') || '').includes('text/markdown'), 'File content type is not text/markdown');
    assert(fileResponse.headers.get('cache-control') === 'no-store', 'Workspace file cache-control should be no-store');
    // Every served file carries the sandbox CSP and nosniff. Markdown is a safe
    // inline type, so it must not be forced to download.
    assert(fileResponse.headers.get('x-content-type-options') === 'nosniff', 'Served file missing nosniff');
    assert(
      fileResponse.headers.get('content-security-policy') === "default-src 'none'; sandbox",
      'Served file missing sandbox CSP'
    );
    assert(fileResponse.headers.get('content-disposition') === null, 'Safe inline type should not be attachment');
    log('file response protected');

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
    log('panel state persisted');

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
    log('layout state persisted');

    const runtimePayload = await session.json(`/api/workspaces/${workspaceId}/runtime/execute`, {
      method: 'POST',
      ...jsonRequest({
        code: 'async () => { const entries = await state.readdir("/"); return entries; }',
      }),
    });
    assert(runtimePayload.execution && !runtimePayload.execution.error, `Runtime execution failed: ${runtimePayload.execution?.error || 'unknown error'}`);
    log('isolated runtime executed');

    if (withChat) {
      log('authenticated chat started');
      const workspacePayload = await fetchWorkspace(session, workspaceId, { includeGateway: true });
      const client = await connectAgent(session, workspacePayload);
      try {
        const chatResult = await sendChatTurn({
          client,
          messages: workspacePayload.messages,
          prompt: 'Create a markdown tile titled "Smoke Chat" containing exactly the text "chat smoke ok".',
        });
        assert(chatResult.ok, 'Chat request did not complete');

        const postChat = await fetchWorkspace(session, workspaceId);
        const assistantMessage = postChat.messages.find(
          (message) => message.role === 'assistant' && Array.isArray(message.parts) && message.parts.length > 0,
        );
        assert(assistantMessage, 'Chat did not persist an assistant message');
        log('authenticated chat state persisted');
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
      log('synthetic workspace deleted');
    }
  }

  log(withChat ? 'staging API and chat smoke passed' : 'staging API smoke passed');
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[smoke] validation failed: ${redactSensitiveText(detail)}`);
  process.exitCode = 1;
});
