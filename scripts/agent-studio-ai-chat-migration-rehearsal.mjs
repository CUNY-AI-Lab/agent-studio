import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionClient, connectAgent } from './smoke-common.mjs';

const BASELINE_REF = '8313c3aa7fac44a78ccc62a017331cf34e6f3d33';
const BASELINE_AI_CHAT = '0.9.3';
const BASELINE_AGENTS = '0.20.1';
const CURRENT_AI_CHAT = '0.12.1';
const CURRENT_AGENTS = '0.28.1';
const RPC_LIMIT_BYTES = 32 * 1024 * 1024;
const LARGE_MESSAGE_COUNT = 33;
const LARGE_MESSAGE_TEXT_BYTES = 1024 * 1024;
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const WORKER_START_TIMEOUT_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const DELETION_READBACK_TIMEOUT_MS = 30_000;
const SESSION_SECRET = 'ab'.repeat(32);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(message) {
  console.log(`[migration-rehearsal] ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function redact(value) {
  return String(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id redacted]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[id redacted]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt redacted]');
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= COMMAND_OUTPUT_LIMIT
    ? next
    : next.slice(next.length - COMMAND_OUTPUT_LIMIT);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_API_TOKEN: '',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = appendBounded(output, chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      output = appendBounded(output, chunk.toString());
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(
        `${command} failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}): ${redact(output)}`,
      ));
    });
  });
}

async function readPackageVersion(root, packagePath) {
  const packageJson = JSON.parse(await readFile(path.join(root, packagePath, 'package.json'), 'utf8'));
  return packageJson.version;
}

async function assertRuntimeVersions(root, expected) {
  const actualAiChat = await readPackageVersion(root, 'node_modules/@cloudflare/ai-chat');
  const actualAgents = await readPackageVersion(root, 'node_modules/agents');
  requireCondition(actualAiChat === expected.aiChat, 'AI Chat runtime version does not match the rehearsal phase');
  requireCondition(actualAgents === expected.agents, 'Agents runtime version does not match the rehearsal phase');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && value instanceof Object) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function messageDigest(messages) {
  const hash = createHash('sha256');
  for (const message of messages) hash.update(`${canonicalJson(message)}\n`);
  return hash.digest('hex');
}

function messageBytes(messages) {
  return messages.reduce(
    (total, message) => total + Buffer.byteLength(`${JSON.stringify(message)}\n`),
    0,
  );
}

function summaryDigest(summaries) {
  const hash = createHash('sha256');
  for (const summary of summaries) {
    hash.update(`${summary.id}\0${summary.role}\0${summary.bytes}\0${summary.digest}\n`);
  }
  return hash.digest('hex');
}

function summarizedMessageBytes(summaries) {
  return summaries.reduce((total, summary) => total + summary.bytes, 0);
}

function expectedMessageSummaries(messages) {
  return messages.map((message) => {
    const serialized = canonicalJson(message);
    return {
      id: message.id,
      role: message.role,
      bytes: Buffer.byteLength(serialized),
      digest: sha256(serialized),
    };
  });
}

function stateDigest(state) {
  return sha256(canonicalJson({
    panels: state.panels,
    viewport: state.viewport,
    groups: state.groups,
    connections: state.connections,
  }));
}

function makeLargeMessages() {
  return Array.from({ length: LARGE_MESSAGE_COUNT }, (_, index) => {
    const prefix = `message-${String(index).padStart(2, '0')}:`;
    return {
      id: `rehearsal-large-${String(index).padStart(2, '0')}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{
        type: 'text',
        text: prefix
          + String.fromCharCode(65 + (index % 26)).repeat(LARGE_MESSAGE_TEXT_BYTES - prefix.length),
      }],
    };
  });
}

function makeSmallMessages(label, count) {
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `rehearsal-${label}-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `${label} message ${index}` }],
  }));
  if (label === 'partial' && messages.length > 1) {
    messages[1] = {
      ...messages[1],
      metadata: { source: 'migration-rehearsal', settled: true },
      parts: [
        { type: 'reasoning', text: 'Inspect the migration fixture.', state: 'done' },
        {
          type: 'tool-inspect_fixture',
          toolCallId: 'rehearsal-tool-1',
          state: 'output-available',
          input: { workspace: 'partial' },
          output: { preserved: true },
        },
        { type: 'text', text: 'partial message 1', state: 'done' },
      ],
    };
  }
  return messages;
}

function makeState(workspace, label, index) {
  const noteId = `rehearsal-note-${label}`;
  return {
    sessionId: null,
    workspace,
    panels: [
      { id: 'chat', type: 'chat', title: 'Chat' },
      {
        id: noteId,
        type: 'markdown',
        title: `Rehearsal ${label}`,
        content: `state fixture ${label}`,
        layout: { x: 120 + index, y: -80 - index, width: 420, height: 260 },
      },
    ],
    viewport: { x: -50 - index, y: 75 + index, zoom: 0.8 + index / 10 },
    groups: [{ id: `rehearsal-group-${label}`, name: `Group ${label}`, panelIds: ['chat', noteId] }],
    connections: [{ id: `rehearsal-edge-${label}`, sourceId: 'chat', targetId: noteId }],
  };
}

function moduleSpecifier(entryDirectory, target) {
  const relative = path.relative(entryDirectory, target).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function oldCompatibilityHarnessSource(sourceRoot, entryDirectory) {
  const aiChatUrl = moduleSpecifier(
    entryDirectory,
    path.join(sourceRoot, 'node_modules/@cloudflare/ai-chat/dist/index.js'),
  );
  const idsUrl = moduleSpecifier(
    entryDirectory,
    path.join(sourceRoot, 'cloudflare/src/lib/ids.ts'),
  );

  return `
import { AIChatAgent } from ${JSON.stringify(aiChatUrl)};
import { DurableObject } from 'cloudflare:workers';
import { createWorkspaceAgentName } from ${JSON.stringify(idsUrl)};

const encoder = new TextEncoder();

function response(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

function rows(result) {
  return result.toArray();
}

function tableExists(agent, tableName) {
  return rows(agent.ctx.storage.sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  )).length > 0;
}

function tableCount(agent, tableName) {
  if (!tableExists(agent, tableName)) return 0;
  if (tableName === 'cf_ai_chat_agent_messages') {
    return Number(rows(agent.ctx.storage.sql.exec(
      'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
    ))[0]?.count ?? 0);
  }
  if (tableName === 'cf_agents_session_messages') {
    return Number(rows(agent.ctx.storage.sql.exec(
      'SELECT COUNT(*) AS count FROM cf_agents_session_messages',
    ))[0]?.count ?? 0);
  }
  if (tableName === 'cf_workspace_default') {
    return Number(rows(agent.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM cf_workspace_default WHERE type = 'file'",
    ))[0]?.count ?? 0);
  }
  throw new Error('unsupported rehearsal table');
}

export class WorkspaceAgent extends AIChatAgent {
  async getSnapshot() {
    return this.state;
  }

  async getWorkspaceFiles() {
    if (!tableExists(this, 'cf_workspace_default')) return [];
    return rows(this.ctx.storage.sql.exec(
      "SELECT path, name, type, size, modified_at FROM cf_workspace_default WHERE path <> '/' ORDER BY path",
    )).map((entry) => ({
      name: entry.name,
      path: String(entry.path).replace(/^\\/+/, ''),
      isDirectory: entry.type === 'directory',
      size: entry.type === 'file' ? Number(entry.size) : undefined,
      uploadedAt: new Date(Number(entry.modified_at) * 1000).toISOString(),
      modifiedAt: new Date(Number(entry.modified_at) * 1000).toISOString(),
    }));
  }

  async readWorkspaceFileContent(filePath) {
    if (!tableExists(this, 'cf_workspace_default')) return null;
    const normalized = '/' + String(filePath).replace(/^\\/+/, '');
    const entry = rows(this.ctx.storage.sql.exec(
      'SELECT type, mime_type, storage_backend, r2_key, content, content_encoding FROM cf_workspace_default WHERE path = ?',
      normalized,
    ))[0];
    if (!entry || entry.type !== 'file') return null;
    let data;
    if (entry.storage_backend === 'r2' && entry.r2_key) {
      const object = await this.env.WORKSPACE_FILES.get(entry.r2_key);
      if (!object) return null;
      data = await object.arrayBuffer();
    } else if (entry.content_encoding === 'base64') {
      const decoded = atob(entry.content ?? '');
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      data = bytes.buffer;
    } else {
      data = encoder.encode(entry.content ?? '').buffer;
    }
    return {
      filePath: String(filePath).replace(/^\\/+/, ''),
      contentType: entry.mime_type,
      data,
    };
  }

  async rehearsalStorageSummary() {
    return {
      legacyMessages: tableCount(this, 'cf_ai_chat_agent_messages'),
      sessionMessages: tableCount(this, 'cf_agents_session_messages'),
      workspaceFiles: tableCount(this, 'cf_workspace_default'),
    };
  }

  async rehearsalMessageSummaries() {
    const summaries = [];
    for (const message of this.messages) {
      const serialized = canonicalJson(message);
      summaries.push({
        id: message.id,
        role: message.role,
        bytes: encoder.encode(serialized).byteLength,
        digest: await digest(serialized),
      });
    }
    return summaries;
  }
}

export class MigrationRegistry extends DurableObject {}

function agentFor(request, env) {
  const sessionId = request.headers.get('x-rehearsal-session');
  const workspaceId = request.headers.get('x-rehearsal-workspace');
  if (!sessionId || !workspaceId) throw new Error('rehearsal object headers missing');
  const name = createWorkspaceAgentName(sessionId, workspaceId);
  return env.WorkspaceAgent.get(env.WorkspaceAgent.idFromName(name));
}

async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hashed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && value instanceof Object) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function inspect(request, env) {
  const agent = agentFor(request, env);
  const [state, files, messageSummaries] = await Promise.all([
    agent.getSnapshot(),
    agent.getWorkspaceFiles(),
    agent.rehearsalMessageSummaries(),
  ]);
  const fileSummaries = [];
  for (const file of files) {
    if (file.isDirectory) continue;
    const stored = await agent.readWorkspaceFileContent(file.path);
    if (!stored) throw new Error('listed rehearsal file is unreadable');
    fileSummaries.push({
      path: file.path,
      contentType: stored.contentType,
      bytes: stored.data.byteLength,
      digest: await digest(stored.data),
    });
  }
  return response({ state, messageSummaries, fileSummaries });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__rehearsal/health') {
      return response({ ok: true, mode: 'readonly', runtime: 'old-sdk-compatibility' });
    }
    if (request.method !== 'GET') {
      return response({ error: 'old SDK compatibility phase is read-only' }, 405);
    }
    if (url.pathname === '/__rehearsal/inspect') return inspect(request, env);
    if (url.pathname === '/__rehearsal/storage') {
      return response(await agentFor(request, env).rehearsalStorageSummary());
    }
    return response({ error: 'unknown old SDK compatibility route' }, 404);
  },
};
`;
}

function workerHarnessSource(sourceRoot, runtime, mode, entryDirectory) {
  if (runtime === 'old' && mode === 'readonly') {
    return oldCompatibilityHarnessSource(sourceRoot, entryDirectory);
  }
  const serverUrl = moduleSpecifier(
    entryDirectory,
    path.join(sourceRoot, 'cloudflare/src/server.ts'),
  );
  const idsUrl = moduleSpecifier(
    entryDirectory,
    path.join(sourceRoot, 'cloudflare/src/lib/ids.ts'),
  );
  const messageImport = runtime === 'new'
    ? `import { readMessageStream } from ${JSON.stringify(moduleSpecifier(entryDirectory, path.join(sourceRoot, 'cloudflare/src/lib/message-stream.ts')))};`
    : '';

  return `
import productionWorker, {
  MigrationRegistry,
  WorkspaceAgent as ProductionWorkspaceAgent,
} from ${JSON.stringify(serverUrl)};
import { createWorkspaceAgentName } from ${JSON.stringify(idsUrl)};
${messageImport}

const MODE = ${JSON.stringify(mode)};
const encoder = new TextEncoder();

function response(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

function agentForIds(env, sessionId, workspaceId) {
  if (!sessionId || !workspaceId) throw new Error('rehearsal object headers missing');
  const name = createWorkspaceAgentName(sessionId, workspaceId);
  return env.WorkspaceAgent.get(env.WorkspaceAgent.idFromName(name));
}

function agentFor(request, env) {
  return agentForIds(
    env,
    request.headers.get('x-rehearsal-session'),
    request.headers.get('x-rehearsal-workspace'),
  );
}

function rows(result) {
  return result.toArray();
}

function tableExists(agent, tableName) {
  return rows(agent.ctx.storage.sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  )).length > 0;
}

function tableCount(agent, tableName) {
  if (!tableExists(agent, tableName)) return 0;
  if (tableName === 'cf_ai_chat_agent_messages') {
    return Number(rows(agent.ctx.storage.sql.exec(
      'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
    ))[0]?.count ?? 0);
  }
  if (tableName === 'cf_agents_session_messages') {
    return Number(rows(agent.ctx.storage.sql.exec(
      'SELECT COUNT(*) AS count FROM cf_agents_session_messages',
    ))[0]?.count ?? 0);
  }
  if (tableName === 'cf_workspace_default') {
    return Number(rows(agent.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM cf_workspace_default WHERE type = 'file'",
    ))[0]?.count ?? 0);
  }
  throw new Error('unsupported rehearsal table');
}

export class WorkspaceAgent extends ProductionWorkspaceAgent {
  async rehearsalStorageSummary() {
    return {
      legacyMessages: tableCount(this, 'cf_ai_chat_agent_messages'),
      sessionMessages: tableCount(this, 'cf_agents_session_messages'),
      workspaceFiles: tableCount(this, 'cf_workspace_default'),
    };
  }

  async rehearsalMessageSummaries() {
    const summaries = [];
    const messages = ${runtime === 'new'
    ? 'readMessageStream(await this.streamMessages())'
    : 'await this.getMessages()'};
    for await (const message of messages) {
      const serialized = canonicalJson(message);
      summaries.push({
        id: message.id,
        role: message.role,
        bytes: encoder.encode(serialized).byteLength,
        digest: await digest(serialized),
      });
    }
    return summaries;
  }
}

export { MigrationRegistry };

async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hashed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && value instanceof Object) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function inspect(request, env) {
  const agent = agentFor(request, env);
  const includeMessages = request.headers.get('x-rehearsal-messages') !== 'false';
  const [state, files, messageSummaries] = await Promise.all([
    agent.getSnapshot(),
    agent.getWorkspaceFiles(),
    includeMessages ? agent.rehearsalMessageSummaries() : Promise.resolve([]),
  ]);
  const fileSummaries = [];
  for (const file of files) {
    if (file.isDirectory) continue;
    const stored = await agent.readWorkspaceFileContent(file.path);
    if (!stored) throw new Error('listed rehearsal file is unreadable');
    fileSummaries.push({
      path: file.path,
      contentType: stored.contentType,
      bytes: stored.data.byteLength,
      digest: await digest(stored.data),
    });
  }
  return response({ state, messageSummaries, fileSummaries });
}

async function seed(request, env, pathname) {
  if (MODE !== 'seed') return response({ error: 'rehearsal phase is read-only' }, 405);
  const agent = agentFor(request, env);
  const body = await request.json();
  if (pathname === '/__rehearsal/state') {
    await agent.syncWorkspace(body.workspace, body.sessionId);
    await agent.replaceWorkspaceState(body.state, body.workspace, body.sessionId);
  } else if (pathname === '/__rehearsal/messages') {
    await agent.persistMessages(body.messages);
  } else if (pathname === '/__rehearsal/file') {
    await agent.writeWorkspaceFileContent(body.path, body.content, body.contentType);
  } else {
    return response({ error: 'unknown rehearsal control' }, 404);
  }
  return response({ ok: true });
}

async function bridgeMessages(request, env) {
  if (MODE !== 'verify') return response({ error: 'message bridge unavailable' }, 405);
  const sessionId = request.headers.get('x-rehearsal-session');
  const workspaceId = request.headers.get('x-rehearsal-workspace');
  if (!sessionId || !workspaceId) throw new Error('rehearsal source headers missing');
  const body = await request.json();
  const source = agentForIds(env, sessionId, workspaceId);
  const target = agentForIds(env, body.targetSessionId, body.targetWorkspace.id);
  await target.syncWorkspace(body.targetWorkspace, body.targetSessionId);
  await target.replaceWorkspaceState(
    body.sourceState,
    body.targetWorkspace,
    body.targetSessionId,
  );
  await target.replaceMessagesFromStream(await source.streamMessages());
  return response({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__rehearsal/health') {
      return response({ ok: true, mode: MODE, runtime: ${JSON.stringify(runtime)} });
    }
    if (url.pathname === '/__rehearsal/inspect' && request.method === 'GET') {
      return inspect(request, env);
    }
    if (url.pathname === '/__rehearsal/storage' && request.method === 'GET') {
      return response(await agentFor(request, env).rehearsalStorageSummary());
    }
    if (url.pathname === '/__rehearsal/bridge-messages' && request.method === 'POST') {
      return bridgeMessages(request, env);
    }
    if (url.pathname.startsWith('/__rehearsal/') && request.method === 'POST') {
      return seed(request, env, url.pathname);
    }
    if (MODE === 'readonly' && request.method !== 'GET') {
      return response({ error: 'rehearsal phase is read-only' }, 405);
    }
    return productionWorker.fetch(request, env, ctx);
  },
};
`;
}

function workerConfig(entryFile, port) {
  return {
    $schema: path.join(REPO_ROOT, 'node_modules/wrangler/config-schema.json'),
    name: 'agent-studio-ai-chat-migration-rehearsal',
    main: entryFile,
    compatibility_date: '2026-03-25',
    compatibility_flags: [
      'nodejs_compat',
      'enable_request_signal',
      'request_signal_passthrough',
    ],
    worker_loaders: [{ binding: 'LOADER' }],
    durable_objects: {
      bindings: [
        { name: 'WorkspaceAgent', class_name: 'WorkspaceAgent' },
        { name: 'MIGRATION_REGISTRY', class_name: 'MigrationRegistry' },
      ],
    },
    exports: {
      WorkspaceAgent: { type: 'durable-object', storage: 'sqlite' },
      MigrationRegistry: { type: 'durable-object', storage: 'sqlite' },
    },
    r2_buckets: [{ binding: 'WORKSPACE_FILES', bucket_name: 'rehearsal-workspaces' }],
    vars: {
      SESSION_SECRET,
      CAIL_LOG_ENV: 'test',
      CAIL_REQUIRE_IDENTITY: 'false',
      CAIL_MODEL: 'deepseek-v4.1-flash-1017',
      CAIL_CANONICAL_ORIGIN: `http://127.0.0.1:${port}`,
    },
  };
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port ?? null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error('could not allocate a local rehearsal port'));
      });
    });
  });
}

async function waitForWorker(baseUrl, worker) {
  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (worker.exit) throw new Error(`local Worker exited before health (${redact(worker.output)})`);
    try {
      const remaining = deadline - Date.now();
      const response = await fetch(new URL('/__rehearsal/health', baseUrl), {
        signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, 1_000))),
      });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for local Worker (${redact(worker.output)})`);
}

async function startWorker({ sourceRoot, runtime, mode, tempRoot, persistRoot, port }) {
  const suffix = `${runtime}-${mode}`;
  const entryFile = path.join(tempRoot, `worker-${suffix}.ts`);
  const configFile = path.join(tempRoot, `wrangler-${suffix}.json`);
  await writeFile(
    entryFile,
    workerHarnessSource(sourceRoot, runtime, mode, path.dirname(entryFile)),
  );
  await writeFile(configFile, `${JSON.stringify(workerConfig(entryFile, port), null, 2)}\n`);
  const executable = path.join(sourceRoot, 'node_modules/.bin/wrangler');
  const child = spawn(executable, [
    'dev',
    '--config', configFile,
    '--persist-to', persistRoot,
    '--ip', '127.0.0.1',
    '--port', String(port),
    '--local',
    '--log-level', 'error',
    '--show-interactive-dev-session=false',
  ], {
    cwd: sourceRoot,
    detached: true,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_API_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const worker = {
    child,
    exit: null,
    output: '',
  };
  child.stdout.on('data', (chunk) => {
    worker.output = appendBounded(worker.output, chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    worker.output = appendBounded(worker.output, chunk.toString());
  });
  child.once('exit', (code, signal) => {
    worker.exit = { code, signal };
  });
  try {
    await waitForWorker(`http://127.0.0.1:${port}`, worker);
    return worker;
  } catch (error) {
    await stopWorker(worker);
    throw error;
  }
}

async function stopWorker(worker) {
  if (!worker?.child?.pid) return;
  try {
    process.kill(-worker.child.pid, 'SIGTERM');
  } catch {
    return;
  }
  if (worker.exit) return;
  const exited = await Promise.race([
    new Promise((resolve) => worker.child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited) {
    try {
      process.kill(-worker.child.pid, 'SIGKILL');
    } catch {}
    await new Promise((resolve) => worker.child.once('exit', resolve));
  }
}

function objectHeaders(fixture, includeMessages = true) {
  return {
    'x-rehearsal-session': fixture.sessionId,
    'x-rehearsal-workspace': fixture.workspace.id,
    'x-rehearsal-messages': String(includeMessages),
  };
}

async function control(baseUrl, pathname, fixture, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(objectHeaders(fixture, init.includeMessages))) {
    headers.set(name, value);
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  let response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`rehearsal control ${pathname} request failed: ${detail}`);
  }
  if (!response.ok) {
    const detail = redact((await response.text()).slice(0, 4_096));
    throw new Error(
      `rehearsal control ${pathname} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return response.json();
}

async function createFixture(session, sessionId, label, index, messages) {
  const created = await session.json('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Migration rehearsal ${label}` }),
  });
  const workspace = created.workspace;
  const state = makeState(workspace, label, index);
  const file = {
    path: `rehearsal-${label}.txt`,
    contentType: 'text/plain; charset=utf-8',
    content: `file fixture ${label}`,
  };
  return {
    label,
    sessionId,
    workspace,
    state,
    stateDigest: stateDigest(state),
    messages,
    messageSummaries: expectedMessageSummaries(messages),
    messageDigest: messageDigest(messages),
    file,
    fileDigest: sha256(file.content),
  };
}

async function seedFixture(baseUrl, fixture) {
  log(`baseline seed ${fixture.label}: state`);
  await control(baseUrl, '/__rehearsal/state', fixture, {
    method: 'POST',
    body: {
      sessionId: fixture.sessionId,
      workspace: fixture.workspace,
      state: fixture.state,
    },
  });
  log(`baseline seed ${fixture.label}: file`);
  await control(baseUrl, '/__rehearsal/file', fixture, {
    method: 'POST',
    body: fixture.file,
  });
  const batchCount = Math.ceil(fixture.messages.length / 2);
  for (let index = 0; index < fixture.messages.length; index += 2) {
    log(`baseline seed ${fixture.label}: history batch ${index / 2 + 1}/${batchCount}`);
    await control(baseUrl, '/__rehearsal/messages', fixture, {
      method: 'POST',
      body: { messages: fixture.messages.slice(index, index + 2) },
    });
  }
}

function requireMessageSummaries(actual, expected, label) {
  requireCondition(
    actual.length === expected.length,
    `${label} message count changed (expected ${expected.length}, got ${actual.length})`,
  );
  for (let index = 0; index < expected.length; index += 1) {
    const expectedMessage = expected[index];
    const actualMessage = actual[index];
    for (const field of ['id', 'role', 'bytes', 'digest']) {
      if (actualMessage[field] !== expectedMessage[field]) {
        throw new Error(
          `${label} first message mismatch at index ${index} (${field}; `
          + `expected_bytes=${expectedMessage.bytes}, actual_bytes=${actualMessage.bytes}, `
          + `expected_digest=${expectedMessage.digest.slice(0, 12)}, `
          + `actual_digest=${actualMessage.digest.slice(0, 12)})`,
        );
      }
    }
  }
  requireCondition(
    summaryDigest(actual) === summaryDigest(expected),
    `${label} combined message digest changed`,
  );
}

function verifyInspection(inspection, fixture, { expectMessages = true } = {}) {
  requireCondition(
    stateDigest(inspection.state) === fixture.stateDigest,
    `${fixture.label} workspace state/layout digest changed`,
  );
  requireCondition(
    inspection.fileSummaries.length === 1,
    `${fixture.label} workspace file count changed`,
  );
  const [file] = inspection.fileSummaries;
  requireCondition(file.path === fixture.file.path, `${fixture.label} workspace file path changed`);
  requireCondition(file.digest === fixture.fileDigest, `${fixture.label} workspace file digest changed`);
  if (expectMessages) {
    requireMessageSummaries(
      inspection.messageSummaries,
      fixture.messageSummaries,
      `${fixture.label} inspection`,
    );
  } else {
    requireCondition(inspection.messageSummaries.length === 0, 'legacy message table was not empty after upgrade');
  }
}

async function inspectFixture(baseUrl, fixture, includeMessages = true) {
  return control(baseUrl, '/__rehearsal/inspect', fixture, { includeMessages });
}

async function bridgeLargeHistory(baseUrl, sourceFixture, sourceInspection, targetFixture) {
  await control(baseUrl, '/__rehearsal/bridge-messages', sourceFixture, {
    method: 'POST',
    body: {
      targetSessionId: targetFixture.sessionId,
      targetWorkspace: targetFixture.workspace,
      sourceState: sourceFixture.state,
    },
  });
  const inspection = await inspectFixture(baseUrl, targetFixture);
  requireCondition(
    stateDigest(inspection.state) === sourceFixture.stateDigest,
    'Worker-to-DO bridge changed the target state/layout snapshot',
  );
  requireMessageSummaries(
    inspection.messageSummaries,
    sourceInspection.messageSummaries,
    'Worker-to-DO bridge target versus migrated source',
  );
  requireCondition(
    inspection.fileSummaries.length === 0,
    'message-only Worker-to-DO bridge unexpectedly copied workspace files',
  );
  const bytes = summarizedMessageBytes(inspection.messageSummaries);
  requireCondition(bytes > RPC_LIMIT_BYTES, 'stream bridge target history did not exceed 32 MiB');
  return bytes;
}

async function reconnect(session, fixture) {
  const client = await connectAgent(session, {
    agent: {
      className: 'WorkspaceAgent',
      name: `${fixture.sessionId}-${fixture.workspace.id}`,
    },
  });
  client.close();
}

async function exportFixture(session, fixture) {
  const response = await session.fetch(`/api/workspaces/${fixture.workspace.id}/export`);
  requireCondition(response.status === 200, 'workspace export route failed');
  const text = await response.text();
  const bundle = JSON.parse(text);
  requireCondition(bundle.version === 1, 'workspace export version changed');
  requireCondition(messageDigest(bundle.messages) === fixture.messageDigest, 'export message digest/order changed');
  requireCondition(stateDigest(bundle.state) === fixture.stateDigest, 'export state/layout digest changed');
  requireCondition(bundle.files.length === 1, 'export file count changed');
  requireCondition(bundle.files[0].path === fixture.file.path, 'export file path changed');
  requireCondition(sha256(bundle.files[0].content) === fixture.fileDigest, 'export file digest changed');
  const historyBytes = messageBytes(bundle.messages);
  requireCondition(historyBytes > RPC_LIMIT_BYTES, 'exported message history did not exceed 32 MiB');
  return { text, bundle, bytes: Buffer.byteLength(text), historyBytes };
}

async function importExport(session, exported, sourceFixture) {
  const form = new FormData();
  form.append('bundle', new File([exported.text], 'migration-rehearsal.agent-studio.json', {
    type: 'application/json',
  }));
  const response = await session.fetch('/api/workspaces/import', { method: 'POST', body: form });
  requireCondition(response.status === 201, 'workspace import route failed');
  const payload = await response.json();
  const imported = {
    ...sourceFixture,
    workspace: payload.workspace,
  };
  const inspection = await inspectFixture(session.baseUrl, imported);
  verifyInspection(inspection, imported);
  const historyBytes = summarizedMessageBytes(inspection.messageSummaries);
  requireCondition(historyBytes > RPC_LIMIT_BYTES, 'imported message history did not exceed 32 MiB');
  const reexported = await exportFixture(session, imported);
  requireCondition(reexported.bytes > RPC_LIMIT_BYTES, 're-exported history did not exceed 32 MiB');
  return { fixture: imported, historyBytes, reexportedBytes: reexported.bytes };
}

async function storageSummary(baseUrl, fixture) {
  return control(baseUrl, '/__rehearsal/storage', fixture);
}

async function waitForDurableTranscriptDeletion(baseUrl, fixture) {
  const deadline = Date.now() + DELETION_READBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const summary = await storageSummary(baseUrl, fixture);
    if (
      summary.legacyMessages === 0
      && summary.sessionMessages === 0
      && summary.workspaceFiles === 0
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('deleted workspace Durable Object retained transcript or file rows');
}

async function deleteFixture(session, fixture) {
  const before = await storageSummary(session.baseUrl, fixture);
  requireCondition(
    before.legacyMessages + before.sessionMessages > 0,
    'deletion readback fixture had no transcript rows before deletion',
  );
  const response = await session.fetch(`/api/workspaces/${fixture.workspace.id}`, { method: 'DELETE' });
  requireCondition(response.status === 200, 'workspace deletion failed');
  const missing = await session.fetch(`/api/workspaces/${fixture.workspace.id}`);
  requireCondition(missing.status === 404, 'deleted workspace remained readable');
  await waitForDurableTranscriptDeletion(session.baseUrl, fixture);
}

async function main() {
  const keepTemp = process.argv.includes('--keep-temp');
  const tempRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), 'agent-studio-ai-chat-migration-')),
  );
  const baselineRoot = path.join(tempRoot, 'baseline');
  const persistRoot = path.join(tempRoot, 'persist');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let worker;
  let baselineAttached = false;

  try {
    await assertRuntimeVersions(REPO_ROOT, { aiChat: CURRENT_AI_CHAT, agents: CURRENT_AGENTS });
    await runCommand('git', ['worktree', 'add', '--detach', baselineRoot, BASELINE_REF]);
    baselineAttached = true;
    await runCommand('bun', ['install', '--frozen-lockfile'], { cwd: baselineRoot });
    await assertRuntimeVersions(baselineRoot, { aiChat: BASELINE_AI_CHAT, agents: BASELINE_AGENTS });
    log('isolated baseline and current runtime versions verified');

    log('starting accepted-baseline seed Worker');
    worker = await startWorker({
      sourceRoot: baselineRoot,
      runtime: 'old',
      mode: 'seed',
      tempRoot,
      persistRoot,
      port,
    });
    log('accepted-baseline seed Worker is healthy');
    const session = new SessionClient(baseUrl);
    const sessionId = await session.ensureSession();
    const fixtures = [
      await createFixture(session, sessionId, 'migrated', 0, makeLargeMessages()),
      // `partial` means partial fleet coverage: this whole object is migrated
      // during the first current-runtime phase. Interrupted row-lift recovery
      // belongs to the focused SQLite regression test, not this Worker probe.
      await createFixture(session, sessionId, 'partial', 1, makeSmallMessages('partial', 4)),
      await createFixture(session, sessionId, 'untouched', 2, makeSmallMessages('untouched', 3)),
    ];
    for (const fixture of fixtures) await seedFixture(baseUrl, fixture);
    const baselineInspection = await inspectFixture(baseUrl, fixtures[0]);
    verifyInspection(baselineInspection, fixtures[0]);
    const baselineStoredBytes = summarizedMessageBytes(baselineInspection.messageSummaries);
    requireCondition(baselineStoredBytes > RPC_LIMIT_BYTES, 'accepted-baseline stored history did not exceed 32 MiB');
    log(`accepted baseline stored all 33 ordered messages with matching canonical field digests (${baselineStoredBytes} bytes)`);
    verifyInspection(await inspectFixture(baseUrl, fixtures[1]), fixtures[1]);
    verifyInspection(await inspectFixture(baseUrl, fixtures[2]), fixtures[2]);
    await reconnect(session, fixtures[0]);
    log('old runtime seeded three objects and completed its reconnect check');
    await stopWorker(worker);
    worker = null;

    log('starting current-runtime migration Worker');
    worker = await startWorker({
      sourceRoot: REPO_ROOT,
      runtime: 'new',
      mode: 'verify',
      tempRoot,
      persistRoot,
      port,
    });
    log('current-runtime migration Worker is healthy');
    const migratedSourceInspection = await inspectFixture(baseUrl, fixtures[0]);
    verifyInspection(migratedSourceInspection, fixtures[0]);
    const migratedSourceBytes = summarizedMessageBytes(migratedSourceInspection.messageSummaries);
    requireCondition(migratedSourceBytes > RPC_LIMIT_BYTES, 'post-migration source history did not exceed 32 MiB');
    log(`migrated source history matched the original canonical field digest and order (${migratedSourceBytes} bytes)`);
    const bridgeTarget = await createFixture(
      session,
      sessionId,
      'stream-bridge-target',
      3,
      fixtures[0].messages,
    );
    const bridgeTargetBytes = await bridgeLargeHistory(
      baseUrl,
      fixtures[0],
      migratedSourceInspection,
      bridgeTarget,
    );
    await deleteFixture(session, bridgeTarget);
    log(`current production WorkspaceAgent streamed source-to-target through the Worker bridge (${bridgeTargetBytes} target bytes) and durable deletion readback reached zero rows`);
    const exported = await exportFixture(session, fixtures[0]);
    requireCondition(exported.bytes > RPC_LIMIT_BYTES, 'actual Worker export did not exceed 32 MiB');
    await reconnect(session, fixtures[0]);
    verifyInspection(await inspectFixture(baseUrl, fixtures[1]), fixtures[1]);
    const imported = await importExport(session, exported, fixtures[0]);
    await deleteFixture(session, imported.fixture);
    log(`current runtime migrated two complete objects in a mixed fleet, streamed export/import (${exported.bytes} export bytes, ${imported.historyBytes} imported history bytes, ${imported.reexportedBytes} re-export bytes), reconnected, and durably deleted the imported copy`);
    await stopWorker(worker);
    worker = null;

    log('starting minimal old-SDK compatibility Worker');
    worker = await startWorker({
      sourceRoot: baselineRoot,
      runtime: 'old',
      mode: 'readonly',
      tempRoot,
      persistRoot,
      port,
    });
    log('minimal old-SDK compatibility Worker is healthy');
    verifyInspection(await inspectFixture(baseUrl, fixtures[0]), fixtures[0], { expectMessages: false });
    verifyInspection(await inspectFixture(baseUrl, fixtures[1]), fixtures[1], { expectMessages: false });
    verifyInspection(await inspectFixture(baseUrl, fixtures[2]), fixtures[2]);
    log('minimal read-only old SDK compatibility probe saw empty legacy tables for both migrated objects while preserving state/files and the untouched object');
    await stopWorker(worker);
    worker = null;

    log('starting current-runtime roll-forward Worker');
    worker = await startWorker({
      sourceRoot: REPO_ROOT,
      runtime: 'new',
      mode: 'verify',
      tempRoot,
      persistRoot,
      port,
    });
    log('current-runtime roll-forward Worker is healthy');
    verifyInspection(await inspectFixture(baseUrl, fixtures[0]), fixtures[0]);
    verifyInspection(await inspectFixture(baseUrl, fixtures[1]), fixtures[1]);
    verifyInspection(await inspectFixture(baseUrl, fixtures[2]), fixtures[2]);
    await reconnect(session, fixtures[0]);
    for (const fixture of fixtures) await deleteFixture(session, fixture);
    const remaining = await session.json('/api/workspaces');
    requireCondition(remaining.workspaces.length === 0, 'rehearsal workspaces remained after deletion');
    log('current roll-forward restored both migrated histories, migrated the untouched object, reconnected, and confirmed durable transcript/file deletion for every fixture');
    log(`passed: objects=3, baseline_history_bytes=${baselineStoredBytes}, migrated_source_bytes=${migratedSourceBytes}, bridge_target_bytes=${bridgeTargetBytes}, export_history_bytes=${exported.historyBytes}, export_bytes=${exported.bytes}, imported_history_bytes=${imported.historyBytes}, reexport_bytes=${imported.reexportedBytes}`);
  } finally {
    await stopWorker(worker);
    if (baselineAttached) {
      await runCommand('git', ['worktree', 'remove', baselineRoot]).catch((error) => {
        console.error(`[migration-rehearsal] baseline worktree cleanup failed: ${redact(error.message)}`);
      });
    }
    if (keepTemp) log(`temporary evidence retained at ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[migration-rehearsal] failed: ${redact(detail)}`);
  process.exitCode = 1;
});
