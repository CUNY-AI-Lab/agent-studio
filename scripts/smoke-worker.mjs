import {
  assertIdentityCredentials,
  SessionClient,
  connectAgent,
  createWorkspace,
  fetchObservability,
  fetchWorkspace,
  identityCredentialsFromEnv,
  parseArgs,
  redactSensitiveText,
  sendChatTurn,
} from './_debug-common.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function log(step, detail = '', { redacted = false } = {}) {
  if (redacted) {
    console.log(`[smoke] ${step}: true`);
    return;
  }
  const suffix = detail ? `: ${detail}` : '';
  console.log(`[smoke] ${step}${suffix}`);
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('health', `${baseUrl.replace(/\/+$/, '')}/`));
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
  const redacted = args.quiet === 'true' || args.redacted === 'true';
  const identity = assertIdentityCredentials(identityCredentialsFromEnv(), { withChat });

  log('health', baseUrl, { redacted });
  await waitForHealth(baseUrl, healthTimeoutMs);

  const session = new SessionClient(
    baseUrl,
    args.cookie || process.env.AGENT_STUDIO_COOKIE || '',
    identity,
  );
  const sessionId = await session.ensureSession();
  assert(Boolean(sessionId), 'Session middleware did not return a session id');
  log('session', sessionId, { redacted });

  const before = await session.json('/api/workspaces');
  assert(Array.isArray(before.workspaces), 'Workspace list payload is invalid');
  log('workspaces-before', String(before.workspaces.length), { redacted });

  let workspaceId = null;

  try {
    const workspace = await createWorkspace(session, workspaceName);
    workspaceId = workspace.id;
    assert(workspaceId, 'Workspace creation did not return an id');
    log('workspace-created', workspaceId, { redacted });

    const created = await fetchWorkspace(session, workspaceId, { includeGateway: true });
    assert(created.workspace.id === workspaceId, 'Workspace fetch returned the wrong id');
    assert(created.agent?.className === 'WorkspaceAgent', 'Workspace agent metadata is missing');
    assert(created.runtime?.provider === 'dynamic-workers', 'Runtime provider is not dynamic-workers');
    assert(created.state?.panels?.some((panel) => panel.id === 'chat'), 'Initial chat panel is missing');
    log('workspace-fetched', created.workspace.name, { redacted });

    const liveAgent = await connectAgent(session, created);
    liveAgent.close();
    log('agent-websocket', 'connected', { redacted });

    const patched = await session.json(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      ...jsonRequest({
        name: `${workspaceName} Updated`,
        description: 'Worker smoke test workspace',
      }),
    });
    assert(patched.workspace.name === `${workspaceName} Updated`, 'Workspace patch did not update the name');
    log('workspace-patched', patched.workspace.name, { redacted });

    // AS-0-1: active-type uploads (e.g. text/html) are now rejected at the PUT door.
    const evilHtmlResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/index.html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><script>alert(1)</script>',
    });
    assert(evilHtmlResponse.status === 400, `Active-type PUT should be rejected, got ${evilHtmlResponse.status}`);
    log('active-put-rejected', String(evilHtmlResponse.status), { redacted });

    const markdown = '# smoke ok';
    const putFileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/notes.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: markdown,
    });
    assert(putFileResponse.ok, `File write failed with ${putFileResponse.status}`);
    log('file-written', 'notes.md', { redacted });

    const filesPayload = await session.json(`/api/workspaces/${workspaceId}/files`);
    assert(
      Array.isArray(filesPayload.files) && filesPayload.files.some((file) => file.path === 'notes.md'),
      'Workspace files listing does not include notes.md'
    );
    log('files-listed', String(filesPayload.files.length), { redacted });

    const fileResponse = await session.fetch(`/api/workspaces/${workspaceId}/files/notes.md`);
    assert(fileResponse.ok, `File fetch failed with ${fileResponse.status}`);
    const fileText = await fileResponse.text();
    assert(fileText.includes('smoke ok'), 'Fetched file content is incorrect');
    assert((fileResponse.headers.get('content-type') || '').includes('text/markdown'), 'File content type is not text/markdown');
    assert(fileResponse.headers.get('cache-control') === 'no-store', 'Workspace file cache-control should be no-store');
    // AS-0-1: every served file must carry the sandbox CSP + nosniff. Markdown is
    // a safe inline type, so it must NOT be forced to download.
    assert(fileResponse.headers.get('x-content-type-options') === 'nosniff', 'Served file missing nosniff');
    assert(
      fileResponse.headers.get('content-security-policy') === "default-src 'none'; sandbox",
      'Served file missing sandbox CSP'
    );
    assert(fileResponse.headers.get('content-disposition') === null, 'Safe inline type should not be attachment');
    log('file-fetched', fileResponse.headers.get('content-type') || 'unknown', { redacted });

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
    log('panel-added', 'smoke-panel', { redacted });

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
    log('layout-patched', 'smoke-panel', { redacted });

    // The Worker Loader occasionally throws an opaque "internal error" on the
    // FIRST Dynamic Worker execution after a fresh wrangler boot (cold start).
    // Retry once with a short delay so that flake doesn't fail local dev or CI;
    // a persistent failure still does.
    let runtimePayload;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        runtimePayload = await session.json(`/api/workspaces/${workspaceId}/runtime/execute`, {
          method: 'POST',
          ...jsonRequest({
            code: 'async () => { const entries = await state.readdir("/"); return entries; }',
          }),
        });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        log(
          'runtime-executed',
          redacted ? 'cold-start retry' : `cold-start retry after: ${error.message}`,
          { redacted },
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    assert(runtimePayload.execution && !runtimePayload.execution.error, `Runtime execution failed: ${runtimePayload.execution?.error || 'unknown error'}`);
    log('runtime-executed', 'ok', { redacted });

    if (withChat) {
      log('chat', 'starting', { redacted });
      const workspacePayload = await fetchWorkspace(session, workspaceId, { includeGateway: true });
      const client = await connectAgent(session, workspacePayload);
      try {
        const chatResult = await sendChatTurn({
          client,
          messages: workspacePayload.messages,
          prompt: 'Create a markdown tile titled "Smoke Chat" containing exactly the text "chat smoke ok".',
          idleTimeoutMs: Number(args['idle-timeout-ms'] || 60000),
          totalTimeoutMs: Number(args['total-timeout-ms'] || 180000),
          verbose: !redacted,
        });
        assert(chatResult.ok, `Chat request did not complete: ${chatResult.reason || 'unknown error'}`);

        const observability = await fetchObservability(session, workspaceId);
        const latestRequest = observability.requests[0];
        assert(latestRequest, 'Observability did not record the chat request');
        assert(latestRequest.status === 'finished', `Chat observability status is ${latestRequest.status}`);

        const postChat = await fetchWorkspace(session, workspaceId);
        assert(postChat.messages.some((message) => message.role === 'assistant'), 'Chat did not produce an assistant message');
        log('chat', 'finished', { redacted });
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
      log('workspace-deleted', workspaceId, { redacted });
    }
  }

  log('done', withChat ? 'api + chat smoke passed' : 'api smoke passed', { redacted });
}

const initialArgs = parseArgs(process.argv.slice(2));
const redacted = initialArgs.quiet === 'true' || initialArgs.redacted === 'true';
main().catch((error) => {
  if (redacted) {
    console.error('[smoke] failed: false');
    process.exitCode = 1;
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[smoke] failed: ${redactSensitiveText(detail, identityCredentialsFromEnv())}`);
  process.exitCode = 1;
});
