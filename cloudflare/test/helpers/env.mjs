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
import { z } from 'zod';
import {
  normalizePanelRelations,
} from '../../src/lib/panel-connections.ts';

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
  export class WorkerEntrypoint { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }
  export class WorkflowEntrypoint { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }
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
let workspaceAgentPrototype = null;

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
  workspaceAgentPrototype = mod.WorkspaceAgent.prototype;
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

  async head(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      size: entry.value.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
    };
  }

  async put(key, value, opts = {}) {
    const expectedEtag = opts.onlyIf?.etagMatches;
    if (expectedEtag !== undefined && this.store.get(key)?.etag !== expectedEtag) {
      return null;
    }

    let bytes;
    const stringValue = z.string().safeParse(value).data;
    if (stringValue !== undefined) {
      bytes = new TextEncoder().encode(stringValue);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    } else {
      bytes = new TextEncoder().encode(JSON.stringify(value));
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

  async list({ prefix = '', delimiter, _cursor } = {}) {
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
    this.env = null;
    this.state = DEFAULT_STATE();
    this.messages = [];
    this.files = new Map(); // path -> { bytes: Uint8Array, contentType }
    this.directories = new Set(['/']);
    this.credential = null;
    this.syncCount = 0;
    this.frozen = false;
    this.destroyed = false;
    this.activeMutations = 0;
    this.storageOperationTail = Promise.resolve();
    this.runtime = null;
    this.uploadInProgress = false;
    this.uploadForwardPhase = false;
    this.uploadWriteIndex = 0;
    this.uploadEntries = [];
    this.uploadFailureInjected = false;
    this.afterUploadWrite = null;
    this.uploadWriteFailure = null;
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
    if (this.activeMutations > 0) {
      throw new Error('workspace has an active mutation; retry migration');
    }
    this.frozen = true;
  }

  async unfreezeAfterMigration() {
    this.frozen = false;
  }

  async destroyWorkspaceState() {
    if (this.activeMutations > 0) {
      throw new Error('workspace has an active mutation; retry destructive cleanup');
    }
    this.files.clear();
    this.directories = new Set(['/']);
    this.messages = [];
    this.credential = null;
    this.state = DEFAULT_STATE();
    this.destroyed = true;
  }

  async replaceWorkspaceState(state, workspace, sessionId) {
    const normalizedRelations = normalizePanelRelations(state.panels ?? [], state.connections ?? []);
    this.state = {
      ...DEFAULT_STATE(),
      ...state,
      ...normalizedRelations,
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

  async getRuntimeInfo() {
    return { provider: 'dynamic-workers', codemode: true, git: true, outbound: 'tool-only' };
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

  async publishGalleryWorkspace(args) {
    return workspaceAgentPrototype.publishGalleryWorkspace.call(this, args);
  }

  async unpublishGalleryWorkspace(args) {
    return workspaceAgentPrototype.unpublishGalleryWorkspace.call(this, args);
  }

  async uploadWorkspaceFiles(entries) {
    this.uploadInProgress = true;
    this.uploadForwardPhase = true;
    this.uploadWriteIndex = 0;
    this.uploadEntries = entries;
    this.uploadFailureInjected = false;
    try {
      return await workspaceAgentPrototype.uploadWorkspaceFiles.call(this, entries);
    } finally {
      this.uploadInProgress = false;
      this.uploadForwardPhase = false;
      this.uploadEntries = [];
    }
  }

  async writeWorkspaceFileContent(...args) {
    return workspaceAgentPrototype.writeWorkspaceFileContent.call(this, ...args);
  }

  async writeWorkspaceFileContentUnchecked(...args) {
    return workspaceAgentPrototype.writeWorkspaceFileContentUnchecked.call(this, ...args);
  }

  async writeRuntimeFileBytes(...args) {
    return workspaceAgentPrototype.writeRuntimeFileBytes.call(this, ...args);
  }

  async deleteWorkspaceFileContent(...args) {
    return workspaceAgentPrototype.deleteWorkspaceFileContent.call(this, ...args);
  }

  async clearWorkspaceFiles(...args) {
    return workspaceAgentPrototype.clearWorkspaceFiles.call(this, ...args);
  }

  async clearRuntimeFilesUnchecked(...args) {
    return workspaceAgentPrototype.clearRuntimeFilesUnchecked.call(this, ...args);
  }

  async withStorageOperation(operation) {
    return workspaceAgentPrototype.withStorageOperation.call(this, operation);
  }

  async withMutationFence(operation) {
    return workspaceAgentPrototype.withMutationFence.call(this, operation);
  }

  assertAuthorizedRpc() {
    return workspaceAgentPrototype.assertAuthorizedRpc.call(this);
  }

  assertStorageOperationSession(sessionId) {
    return workspaceAgentPrototype.assertStorageOperationSession.call(this, sessionId);
  }

  csrfSessionId() {
    return workspaceAgentPrototype.csrfSessionId.call(this);
  }

  serializeProviderWrites(...args) {
    return workspaceAgentPrototype.serializeProviderWrites.call(this, ...args);
  }

  buildSerializedStateTools(...args) {
    return workspaceAgentPrototype.buildSerializedStateTools.call(this, ...args);
  }

  buildSerializedGitTools(...args) {
    return workspaceAgentPrototype.buildSerializedGitTools.call(this, ...args);
  }

  assertNotFrozen() {
    if (this.frozen) throw new Error('workspace is frozen for migration');
  }

  getRuntimeWorkspace() {
    if (this.runtime) return this.runtime;
    const toBytes = (data) => data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new TextEncoder().encode(data);
    const parentDirectories = (key) => {
      const parents = [];
      let current = key;
      while (current.includes('/')) {
        current = current.slice(0, current.lastIndexOf('/')) || '/';
        parents.push(current);
        if (current === '/') break;
      }
      return parents;
    };
    const ensureParents = (key) => {
      for (const parent of parentDirectories(key)) this.directories.add(parent);
    };
    const statFor = (key) => {
      if (this.files.has(key)) {
        return {
          type: 'file',
          size: this.files.get(key).bytes.byteLength,
          updatedAt: new Date(0).toISOString(),
        };
      }
      if (this.directories.has(key)) {
        return {
          type: 'directory',
          size: 0,
          updatedAt: new Date(0).toISOString(),
        };
      }
      return null;
    };
    this.runtime = {
      readFile: async (filePath) => {
        const key = sanitizeRelativePath(filePath);
        const entry = this.files.get(key);
        return entry ? new TextDecoder().decode(entry.bytes) : null;
      },
      readFileBytes: async (filePath) => {
        const key = sanitizeRelativePath(filePath);
        const entry = this.files.get(key);
        return entry ? entry.bytes.slice() : null;
      },
      writeFile: async (filePath, data, contentType) => {
        const key = sanitizeRelativePath(filePath);
        const bytes = toBytes(data);
        ensureParents(key);
        this.files.set(key, {
          bytes: bytes.slice(),
          contentType: contentType || 'application/octet-stream',
        });
      },
      writeFileBytes: async (filePath, data, contentType) => {
        const key = sanitizeRelativePath(filePath);
        if (this.uploadInProgress && this.uploadForwardPhase) {
          const index = this.uploadWriteIndex++;
          const entry = this.uploadEntries[index];
          try {
            if (!this.uploadFailureInjected && this.uploadWriteFailure?.(entry, index)) {
              this.uploadFailureInjected = true;
              this.uploadForwardPhase = false;
              throw new Error('injected upload failure');
            }
            const bytes = new Uint8Array(data).slice();
            ensureParents(key);
            this.files.set(key, {
              bytes,
              contentType: contentType || 'application/octet-stream',
            });
            await this.afterUploadWrite?.(index, entry);
            return;
          } catch (error) {
            this.uploadForwardPhase = false;
            throw error;
          }
        }
        const bytes = new Uint8Array(data).slice();
        ensureParents(key);
        this.files.set(key, {
          bytes,
          contentType: contentType || 'application/octet-stream',
        });
      },
      appendFile: async (filePath, data, contentType) => {
        const key = sanitizeRelativePath(filePath);
        const current = this.files.get(key)?.bytes || new Uint8Array();
        const bytes = toBytes(data);
        const combined = new Uint8Array(current.byteLength + bytes.byteLength);
        combined.set(current);
        combined.set(bytes, current.byteLength);
        ensureParents(key);
        this.files.set(key, {
          bytes: combined,
          contentType: contentType || this.files.get(key)?.contentType || 'application/octet-stream',
        });
      },
      exists: async (filePath) => Boolean(statFor(sanitizeRelativePath(filePath))),
      stat: async (filePath) => statFor(sanitizeRelativePath(filePath)),
      lstat: async (filePath) => statFor(sanitizeRelativePath(filePath)),
      mkdir: async (filePath, options = {}) => {
        const key = sanitizeRelativePath(filePath) || '/';
        if (options.recursive !== false) {
          this.directories.add(key);
          for (const parent of parentDirectories(key)) this.directories.add(parent);
        } else {
          this.directories.add(key);
        }
      },
      readDir: async (filePath) => {
        const key = sanitizeRelativePath(filePath) || '/';
        const prefix = key === '/' ? '/' : `${key}/`;
        const children = new Map();
        for (const directory of this.directories) {
          if (!directory.startsWith(prefix) || directory === prefix) continue;
          const remainder = directory.slice(prefix.length);
          const name = remainder.split('/')[0];
          if (name) children.set(name, 'directory');
        }
        for (const file of this.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const remainder = file.slice(prefix.length);
          const name = remainder.split('/')[0];
          if (name && !children.has(name)) children.set(name, 'file');
        }
        return [...children].map(([name, type]) => ({ name, type }));
      },
      rm: async (filePath, options = {}) => {
        const key = sanitizeRelativePath(filePath) || '/';
        if (options.recursive) {
          const prefix = key === '/' ? '/' : `${key}/`;
          for (const file of this.files.keys()) {
            if (file === key || file.startsWith(prefix)) this.files.delete(file);
          }
          for (const directory of this.directories) {
            if (directory === key || directory.startsWith(prefix)) this.directories.delete(directory);
          }
          this.directories.add('/');
          return;
        }
        this.files.delete(key);
        if (key !== '/') this.directories.delete(key);
      },
      glob: async () => [
        ...[...this.directories].map((key) => ({ path: key })),
        ...[...this.files.keys()].map((key) => ({ path: `/${key}` })),
      ],
    };
    return this.runtime;
  }

  setState(next) {
    this.state = next;
  }

  upsertPanelWithAssociation(...args) {
    return workspaceAgentPrototype.upsertPanelWithAssociation.call(this, ...args);
  }

  async addPanel(panel) {
    return workspaceAgentPrototype.addPanel.call(this, panel);
  }

  async removePanel(panelId) {
    return workspaceAgentPrototype.removePanel.call(this, panelId);
  }

  async applyLayoutPatch(patch) {
    return workspaceAgentPrototype.applyLayoutPatch.call(this, patch);
  }
}

/**
 * WorkspaceAgent DurableObject-namespace double. getAgentByName() calls
 * idFromName(name) then get(id); we key our agent pool by the resolved name
 * (`${sessionId}-${workspaceId}`) so seeded and route-created agents line up.
 */
export function makeWorkspaceAgentNamespace() {
  const agents = new Map();
  let configuredEnv = null;
  const ensure = (name) => {
    if (!agents.has(name)) {
      const agent = new FakeWorkspaceAgent(name);
      agent.env = configuredEnv;
      agents.set(name, agent);
    }
    return agents.get(name);
  };
  return {
    agents,
    ensure,
    setEnv(env) {
      configuredEnv = env;
      for (const agent of agents.values()) agent.env = env;
    },
    namespace: {
      idFromName: (name) => ({ name, toString: () => name }),
      get: (id) => ensure(id.name),
    },
  };
}

export function makeMigrationRegistryNamespace() {
  const registries = new Map();
  const ensure = (name) => {
    if (!registries.has(name)) {
      const active = new Set();
      let claim = null;
      registries.set(name, {
        active,
        async beginAnonymousRequest(requestId) {
          if (claim) return false;
          active.add(requestId);
          return true;
        },
        async endAnonymousRequest(requestId) {
          active.delete(requestId);
        },
        async claim(subjectSessionId) {
          if (active.size > 0) return 'anonymous-active';
          if (!claim) {
            claim = { subjectSessionId, status: 'in-progress', startedAt: Date.now() };
            return 'run';
          }
          if (claim.subjectSessionId !== subjectSessionId) return 'claimed-by-other';
          if (claim.status === 'done') return 'already-done';
          if (claim.status === 'in-progress') return 'in-progress';
          claim = { subjectSessionId, status: 'in-progress', startedAt: Date.now() };
          return 'run';
        },
        async markDone(subjectSessionId) {
          if (claim?.subjectSessionId === subjectSessionId) claim = { ...claim, status: 'done' };
        },
        async markFailed(subjectSessionId) {
          if (claim?.subjectSessionId === subjectSessionId && claim.status !== 'done') {
            claim = { ...claim, status: 'failed' };
          }
        },
      });
    }
    return registries.get(name);
  };
  return {
    registries,
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
 * Build an anonymous-mode env with an explicit valid logging environment.
 * Returns the env plus the R2 and
 * agent-namespace doubles so tests can seed and assert against storage.
 */
export function makeEnv() {
  const r2 = new MockR2();
  const workspaceAgent = makeWorkspaceAgentNamespace();
  const migrationRegistry = makeMigrationRegistryNamespace();
  const env = {
    ASSETS: {
      fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`),
    },
    SESSION_SECRET: 'ab'.repeat(32), // 64 hex chars
    CAIL_LOG_ENV: 'test',
    // Leave identity entirely unconfigured for anonymous route fixtures.
    // Supplying only an issuer is a partial verifier config and now fails
    // closed before the absent-token path is considered.
    WORKSPACE_FILES: r2,
    WorkspaceAgent: workspaceAgent.namespace,
    MIGRATION_REGISTRY: migrationRegistry.namespace,
  };
  workspaceAgent.setEnv(env);
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
  const headers = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
  for (const header of headers) {
    const match = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,\\s]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

const CSRF_HEADER = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A session bound to one signed cookie. `request(app, path, init)` issues the
 * cookie on the first call and carries it on every subsequent call, so a
 * Session instance behaves like one browser.
 *
 * It also mirrors a first-party page's CSRF behavior (fleet contract §3¾): it
 * captures the per-session token from the /api/session bootstrap's Set-Cookie
 * header (the delivery channel; never the body) and attaches it as X-CSRF-Token
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
      new Request(
        `https://studio.test${this.env.CAIL_BASE_PATH ?? ''}${appPath}`,
        { ...fetchInit, headers },
      ),
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
