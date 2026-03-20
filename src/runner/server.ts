import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createSandboxedStorage, Message, WorkspaceConfig } from '../lib/storage';
import { createInProcessWorkspaceRuntime } from '../lib/runtime/in-process';
import { startEgressProxy } from './egress-proxy';

const RUNNER_PORT = Number(process.env.WORKSPACE_RUNNER_PORT || 3200);
const RUNNER_HOST = process.env.WORKSPACE_RUNNER_HOST || '127.0.0.1';
const RUNNER_SECRET = process.env.WORKSPACE_RUNNER_SHARED_SECRET?.trim() || null;
const RUNNER_SECRET_HEADER = 'x-agent-studio-runner-secret';

interface RunnerQueryRequest {
  userId: string;
  config: WorkspaceConfig;
  prompt: string;
  conversationHistory?: Message[];
  includeWorkspaceState?: boolean;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendSseEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    throw new Error('Request body is required');
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
}

function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<WorkspaceConfig>;
  return typeof maybe.id === 'string'
    && typeof maybe.name === 'string'
    && typeof maybe.description === 'string'
    && typeof maybe.createdAt === 'string'
    && typeof maybe.updatedAt === 'string'
    && typeof maybe.systemPrompt === 'string'
    && Array.isArray(maybe.tools);
}

function isRunnerQueryRequest(value: unknown): value is RunnerQueryRequest {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<RunnerQueryRequest>;
  return typeof maybe.userId === 'string'
    && isWorkspaceConfig(maybe.config)
    && typeof maybe.prompt === 'string'
    && (maybe.conversationHistory === undefined || Array.isArray(maybe.conversationHistory))
    && (maybe.includeWorkspaceState === undefined || typeof maybe.includeWorkspaceState === 'boolean');
}

async function handleQuery(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (RUNNER_SECRET && request.headers[RUNNER_SECRET_HEADER] !== RUNNER_SECRET) {
    sendJson(response, 401, { error: 'Unauthorized runner request' });
    return;
  }

  let payload: RunnerQueryRequest;
  try {
    payload = await readJsonBody<RunnerQueryRequest>(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
    return;
  }

  if (!isRunnerQueryRequest(payload)) {
    sendJson(response, 400, { error: 'Invalid runner query payload' });
    return;
  }

  const storage = createSandboxedStorage(payload.userId);
  if (!egressProxyHandle) {
    sendJson(response, 503, { error: 'Runner egress proxy is not available' });
    return;
  }

  const runtime = createInProcessWorkspaceRuntime(payload.config, storage, {
    egressProxyPort: egressProxyHandle.port,
  });
  const abortController = new AbortController();

  request.on('aborted', () => abortController.abort());
  response.on('close', () => abortController.abort());

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  response.write(': ready\n\n');

  const keepaliveInterval = setInterval(() => {
    if (!response.writableEnded) {
      response.write(': keepalive\n\n');
    }
  }, 15000);

  try {
    for await (const event of runtime.query(payload.prompt, payload.conversationHistory, {
      abortController,
      includeWorkspaceState: payload.includeWorkspaceState,
    })) {
      if (abortController.signal.aborted) {
        break;
      }

      if (event.type === 'done') {
        continue;
      }

      sendSseEvent(response, event);
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      sendSseEvent(response, {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown runner error',
      });
    }
  } finally {
    clearInterval(keepaliveInterval);
    response.end();
  }
}

let egressProxyHandle: Awaited<ReturnType<typeof startEgressProxy>> | null = null;

async function main(): Promise<void> {
  egressProxyHandle = await startEgressProxy();

  const server = createServer((request, response) => {
    if (!request.url) {
      sendJson(response, 400, { error: 'Missing request URL' });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${RUNNER_HOST}:${RUNNER_PORT}`}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        egressProxyPort: egressProxyHandle?.port,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/query') {
      void handleQuery(request, response);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  });

  const shutdown = async () => {
    await Promise.allSettled([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      egressProxyHandle?.close() ?? Promise.resolve(),
    ]);
    process.exit(0);
  };

  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  server.listen(RUNNER_PORT, RUNNER_HOST, () => {
    console.log(`workspace-runner listening on http://${RUNNER_HOST}:${RUNNER_PORT}`);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
