// Shared route-test scaffolding for the Hono app in `src/server.ts`.
//
// server.ts pulls a large transitive graph (agents / @cloudflare/*) that
// imports the `cloudflare:workers` and `cloudflare:email` runtime builtins at
// module-evaluation time. The plain `node --import tsx` test loader can't
// resolve those specifiers, so `registerCloudflareStub()` installs a resolve/
// load hook that maps `cloudflare:*` to a tiny in-memory stub. It MUST run
// before the first `import('../../src/server.ts')`.
//
// Everything else here is faithful in-memory doubles: a MockR2 matching the
// prefix/delimiter semantics lib/files.ts relies on, and a WorkspaceAgent
// namespace double whose resolved stub implements the @callable surface the
// routes invoke (getAgentByName -> idFromName/get/stub.fetch).

import { register } from 'node:module';

// Mirror the DO's own path sanitization so the fake agent rejects traversal the
// same way `writeWorkspaceFileContent`/`sanitizeRelativePath` do in production.
// Kept in lockstep with lib/files.ts normalizeRelativePath.
function sanitizeRelativePath(inputPath) {
  const normalized = String(inputPath).replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid file path');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// cloudflare:* stub loader
// ---------------------------------------------------------------------------

const CF_STUB_SOURCE = `
  export class DurableObject { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }
  export class RpcTarget {}
  export class EmailMessage {}
  export class WorkerEntrypoint {}
  export class WorkflowEntrypoint {}
  export const exports = {};
  export const env = {};
  export default {};
`;

// module.register serializes hooks to a worker thread, so the hook bodies
// below can't close over CF_STUB_SOURCE — inline the source instead.
const HOOKS_MODULE = `data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('cloudflare:')) {
      return { url: 'cf-stub:' + specifier.slice('cloudflare:'.length), shortCircuit: true };
    }
    return next(specifier, context);
  }
  export async function load(url, context, next) {
    if (url.startsWith('cf-stub:')) {
      return { format: 'module', shortCircuit: true, source: ${JSON.stringify(CF_STUB_SOURCE)} };
    }
    return next(url, context);
  }
`)}`;

let registered = false;

/** Install the cloudflare:* stub loader once. Idempotent. */
export function registerCloudflareStub() {
  if (registered) return;
  register(HOOKS_MODULE, import.meta.url);
  registered = true;
}

/**
 * Import the real Hono app default export from src/server.ts with the stub
 * loader active. Returns `{ fetch }` (the module default).
 */
export async function importServer() {
  registerCloudflareStub();
  const mod = await import('../../src/server.ts');
  return mod.default;
}

// ---------------------------------------------------------------------------
// In-memory R2 double (get/put/list/delete with prefix + delimiter semantics)
// ---------------------------------------------------------------------------

export class MockR2 {
  constructor() {
    this.store = new Map();
    this.etagCounter = 0;
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const bytes = entry.value; // always a Uint8Array
    return {
      key,
      size: bytes.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      body: bytes,
      json: async (/* generic */) => JSON.parse(new TextDecoder().decode(bytes)),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async put(key, value, opts = {}) {
    const expectedEtag = opts.onlyIf?.etagMatches;
    if (expectedEtag !== undefined && this.store.get(key)?.etag !== expectedEtag) {
      return null;
    }

    let bytes;
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    } else {
      bytes = new TextEncoder().encode(String(value));
    }
    const etag = String(this.etagCounter += 1);
    const uploaded = new Date(0);
    this.store.set(key, {
      value: bytes,
      etag,
      uploaded,
      httpMetadata: opts.httpMetadata,
      customMetadata: opts.customMetadata,
    });
    return { key, size: bytes.byteLength, etag, uploaded };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.store.delete(key);
    }
  }

  async list({ prefix = '', delimiter, cursor } = {}) {
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const toObject = (key) => {
      const entry = this.store.get(key);
      return {
        key,
        size: entry ? entry.value.byteLength : 0,
        etag: entry?.etag || '',
        uploaded: entry?.uploaded || new Date(0),
      };
    };
    if (!delimiter) {
      return { objects: keys.map(toObject), delimitedPrefixes: [], truncated: false, cursor: undefined };
    }
    const objects = [];
    const delimited = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index >= 0) {
        delimited.add(prefix + rest.slice(0, index + 1));
      } else {
        objects.push(toObject(key));
      }
    }
    return { objects, delimitedPrefixes: [...delimited], truncated: false, cursor: undefined };
  }

  keysWithPrefix(prefix) {
    return [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

// ---------------------------------------------------------------------------
// WorkspaceAgent double
// ---------------------------------------------------------------------------

const DEFAULT_STATE = () => ({
  sessionId: null,
  workspace: null,
  panels: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  groups: [],
  connections: [],
});

/**
 * Faithful in-memory stand-in for a single WorkspaceAgent DO instance.
 * Implements the @callable methods the routes invoke; a `fetch()` satisfies
 * the partyserver `set-name` handshake performed by getAgentByName().
 */
export class FakeWorkspaceAgent {
  constructor(name) {
    this.name = name;
    this.state = DEFAULT_STATE();
    this.messages = [];
    this.files = new Map(); // path -> { bytes: Uint8Array, contentType }
    this.credential = null;
    this.syncCount = 0;
    this.frozen = false;
    this.destroyed = false;
  }

  async fetch() {
    // partyserver's getServerByName handshake: it awaits `.text()`.
    return new Response('ok');
  }

  async setCailCredential(jwt) {
    this.credential = jwt;
  }

  async syncWorkspace(workspace, sessionId) {
    this.syncCount += 1;
    this.state = {
      ...this.state,
      sessionId,
      workspace,
      panels: this.state.panels,
    };
  }

  async freezeForMigration() {
    this.frozen = true;
  }

  async unfreezeAfterMigration() {
    this.frozen = false;
  }

  async destroyWorkspaceState() {
    this.files.clear();
    this.messages = [];
    this.credential = null;
    this.state = DEFAULT_STATE();
    this.destroyed = true;
  }

  async replaceWorkspaceState(state, workspace, sessionId) {
    this.state = {
      ...DEFAULT_STATE(),
      ...state,
      sessionId,
      workspace,
    };
  }

  async persistMessages(messages) {
    this.messages = [...messages];
  }

  async getSnapshot() {
    return this.state;
  }

  async getMessages() {
    return this.messages;
  }

  async getObservability() {
    return { requests: [], events: [] };
  }

  async getRuntimeInfo() {
    return { provider: 'dynamic-workers', codemode: true, git: true, timeoutMs: 30000, outbound: 'tool-only' };
  }

  async executeCode(code) {
    return { ok: true, stdout: `ran:${code}`, stderr: '', logs: [] };
  }

  async getWorkspaceFiles() {
    return [...this.files.keys()].sort().map((filePath) => ({
      name: filePath.split('/').pop() || filePath,
      path: filePath,
      isDirectory: false,
      size: this.files.get(filePath).bytes.byteLength,
    }));
  }

  async readWorkspaceFileContent(filePath) {
    const key = sanitizeRelativePath(filePath);
    const entry = this.files.get(key);
    if (!entry) return null;
    const { bytes } = entry;
    return {
      filePath: key,
      contentType: entry.contentType,
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async writeWorkspaceFileContent(filePath, data, contentType) {
    const key = sanitizeRelativePath(filePath);
    let bytes;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else {
      bytes = new TextEncoder().encode(String(data));
    }
    this.files.set(key, { bytes, contentType: contentType || 'application/octet-stream' });
    return { ok: true, filePath: key };
  }

  async deleteWorkspaceFileContent(filePath) {
    const key = sanitizeRelativePath(filePath);
    this.files.delete(key);
    return { ok: true, filePath: key };
  }

  async clearWorkspaceFiles() {
    this.files.clear();
  }

  async addPanel(panel) {
    const existing = this.state.panels.findIndex((candidate) => candidate.id === panel.id);
    const panels = [...this.state.panels];
    if (existing >= 0) panels[existing] = panel;
    else panels.push(panel);
    this.state = { ...this.state, panels };
    return this.state;
  }

  async removePanel(panelId) {
    // Mirrors the real DO: removing a panel also drops its connections and
    // filters it out of groups (collapsing groups below two members).
    this.state = {
      ...this.state,
      panels: this.state.panels.filter((panel) => panel.id !== panelId),
      groups: this.state.groups
        .map((group) => ({ ...group, panelIds: group.panelIds.filter((id) => id !== panelId) }))
        .filter((group) => group.panelIds.length >= 2),
      connections: this.state.connections.filter(
        (connection) => connection.sourceId !== panelId && connection.targetId !== panelId,
      ),
    };
    return this.state;
  }

  async applyLayoutPatch(patch) {
    const panels = this.state.panels.map((panel) => {
      const next = patch.panels?.[panel.id];
      if (!next) return panel;
      return { ...panel, layout: { ...panel.layout, ...next } };
    });

    // Mirrors the real DO (V3): groups/connections are per-id upserts, group
    // removal is explicit, and entries referencing missing panels are dropped.
    const panelIds = new Set(panels.map((panel) => panel.id));
    const connectionsById = new Map(this.state.connections.map((connection) => [connection.id, connection]));
    for (const connection of patch.connections ?? []) connectionsById.set(connection.id, connection);
    const connections = [...connectionsById.values()].filter(
      (connection) => panelIds.has(connection.sourceId) && panelIds.has(connection.targetId),
    );
    const groupsById = new Map(this.state.groups.map((group) => [group.id, group]));
    for (const group of patch.groups ?? []) groupsById.set(group.id, group);
    for (const groupId of patch.removeGroups ?? []) groupsById.delete(groupId);
    const groups = [...groupsById.values()]
      .map((group) => ({ ...group, panelIds: group.panelIds.filter((panelId) => panelIds.has(panelId)) }))
      .filter((group) => group.panelIds.length >= 2);

    this.state = {
      ...this.state,
      panels,
      groups,
      connections,
      ...(patch.viewport ? { viewport: patch.viewport } : {}),
    };
    return this.state;
  }
}

/**
 * WorkspaceAgent DurableObject-namespace double. getAgentByName() calls
 * idFromName(name) then get(id); we key our agent pool by the resolved name
 * (`${sessionId}-${workspaceId}`) so seeded and route-created agents line up.
 */
export function makeWorkspaceAgentNamespace() {
  const agents = new Map();
  const ensure = (name) => {
    if (!agents.has(name)) agents.set(name, new FakeWorkspaceAgent(name));
    return agents.get(name);
  };
  return {
    agents,
    ensure,
    namespace: {
      idFromName: (name) => ({ name, toString: () => name }),
      get: (id) => ensure(id.name),
    },
  };
}

// ---------------------------------------------------------------------------
// Env double + session cookie helper
// ---------------------------------------------------------------------------

/**
 * Build an anonymous-mode env (CAIL_* unset). Returns the env plus the R2 and
 * agent-namespace doubles so tests can seed and assert against storage.
 */
export function makeEnv() {
  const r2 = new MockR2();
  const workspaceAgent = makeWorkspaceAgentNamespace();
  const migrationRegistry = {
    idFromName: (name) => name,
    get: () => ({
      claim: async () => 'run',
      markDone: async () => undefined,
      markFailed: async () => undefined,
    }),
  };
  const env = {
    ASSETS: {
      fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`),
    },
    SESSION_SECRET: 'ab'.repeat(32), // 64 hex chars
    CAIL_IDENTITY_ISSUER: 'https://tools.ailab.gc.cuny.edu/cail-sso',
    CAIL_LOG_ENV: 'test',
    CAIL_FLEET_EVENTS: { writeDataPoint() {} },
    CF_VERSION_METADATA: {
      id: '11111111-1111-4111-8111-111111111111',
      tag: '',
      timestamp: '2026-07-13T14:00:00Z',
    },
    WORKSPACE_FILES: r2,
    WorkspaceAgent: workspaceAgent.namespace,
    MIGRATION_REGISTRY: migrationRegistry,
  };
  return { env, r2, agents: workspaceAgent.agents, ensureAgent: workspaceAgent.ensure };
}

/** Extract the session cookie from a Set-Cookie header, ready to re-send. */
export function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/agent-studio-session=([^;]*)/);
  return match ? `agent-studio-session=${match[1]}` : null;
}

export const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';

/**
 * Extract the CSRF token from the Set-Cookie header (fleet contract §3¾ rule 3
 * delivery amendment, 2026-07-05). This is how a browser page — and this test
 * harness — receives it; the token is never in the response body. Prefers
 * getSetCookie() (undici returns each Set-Cookie unmerged) and falls back to the
 * comma-joined .get('set-cookie').
 */
export function csrfCookieFrom(response) {
  const headers =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''];
  for (const header of headers) {
    const match = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,\\s]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

const CSRF_HEADER = 'X-CAIL-CSRF';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A session bound to one signed cookie. `request(app, path, init)` issues the
 * cookie on the first call and carries it on every subsequent call, so a
 * Session instance behaves like one browser.
 *
 * It also mirrors a first-party page's CSRF behavior (fleet contract §3¾): it
 * captures the per-session token from the /api/session bootstrap's Set-Cookie
 * header (the delivery channel; never the body) and attaches it as X-CAIL-CSRF
 * on every state-changing request and GET/HEAD read. With neither Sec-Fetch-Site
 * nor Origin set, the worker falls back to that token — so ordinary route tests
 * pass through the enforced path rather than around it. A test exercising the
 * negative cases passes `init.csrfToken` (see below) to override.
 *
 * `init.csrfToken` sets an explicit token (or '' to send none); `init.origin`
 * and `init.secFetchSite` set those headers. Omit all three for the default
 * "authenticated first-party page" behavior.
 */
export class Session {
  constructor(env) {
    this.env = env;
    this.cookie = null;
    this.csrfToken = null;
  }

  async request(app, appPath, init = {}) {
    const { csrfToken, origin, secFetchSite, ...fetchInit } = init;
    const headers = new Headers(fetchInit.headers || {});
    if (this.cookie) headers.set('Cookie', this.cookie);

    const method = (fetchInit.method || 'GET').toUpperCase();
    const token = csrfToken !== undefined ? csrfToken : this.csrfToken;
    if (method === 'GET' || method === 'HEAD' || !SAFE_METHODS.has(method)) {
      // Explicit token overrides win (including '' for negative-path tests);
      // otherwise attach the captured token like a real first-party page.
      if (token) headers.set(CSRF_HEADER, token);
    }
    if (!SAFE_METHODS.has(method)) {
      if (origin) headers.set('Origin', origin);
      if (secFetchSite) headers.set('Sec-Fetch-Site', secFetchSite);
    }

    const response = await app.fetch(
      new Request(`https://studio.test${appPath}`, { ...fetchInit, headers }),
      this.env,
      {},
    );
    const next = cookieFrom(response);
    if (next) this.cookie = next;
    // Capture the token from the Set-Cookie header (delivery amendment) the first
    // time /api/session sets it — the same channel a browser page reads.
    if (this.csrfToken === null && appPath.startsWith('/api/session') && response.ok) {
      const token = csrfCookieFrom(response);
      if (token) this.csrfToken = token;
    }
    return response;
  }
}

/** Convenience: open a session and read its assigned session id via /api/session. */
export async function openSession(app, env) {
  const session = new Session(env);
  const res = await session.request(app, '/api/session');
  const { sessionId } = await res.json();
  return { session, sessionId };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// `authorId` is the already-derived opaque gallery owner tag. Keeping hashing
// out of this synchronous fixture makes each caller explicit about the secret.
export function seedGalleryItem(r2, id, authorId, overrides = {}) {
  const manifest = {
    id,
    title: 'Seed Item',
    description: 'A seeded gallery item',
    prompt: '',
    authorId,
    publishedAt: new Date(0).toISOString(),
    artifactCount: 0,
    ...overrides,
  };
  r2.put(`agent-studio/gallery/items/${id}/manifest.json`, JSON.stringify(manifest));
  r2.put(
    `agent-studio/gallery/items/${id}/state.json`,
    JSON.stringify({ sessionId: null, workspace: null, panels: [], viewport: { x: 0, y: 0, zoom: 1 }, groups: [], connections: [] }),
  );
  return manifest;
}

/** Build a minimal valid workspace export/import bundle for import tests. */
export function makeImportBundle(overrides = {}) {
  const now = new Date(0).toISOString();
  return {
    version: 1,
    exportedAt: now,
    workspace: {
      id: 'ignored-on-import',
      name: 'Imported',
      description: 'from bundle',
      createdAt: now,
      updatedAt: now,
    },
    state: {
      sessionId: null,
      workspace: null,
      panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    messages: [],
    files: [
      { path: 'notes.md', contentType: 'text/markdown; charset=utf-8', encoding: 'utf8', content: '# hi' },
    ],
    ...overrides,
  };
}
