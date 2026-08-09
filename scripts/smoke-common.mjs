import { AgentClient } from 'agents/client';

const CHAT_MESSAGE_TYPE = {
  REQUEST: 'cf_agent_use_chat_request',
  RESPONSE: 'cf_agent_use_chat_response',
};

// Identity keyring transport. Keep both credentials in the environment so a
// shell history, process argument list, or smoke log never receives a JWT.
export const APP_IDENTITY_JWT_ENV = 'AGENT_STUDIO_APP_IDENTITY_JWT';
export const GATEWAY_IDENTITY_JWT_ENV = 'AGENT_STUDIO_GATEWAY_IDENTITY_JWT';
export const APP_IDENTITY_JWT_HEADER = 'X-CAIL-Identity-JWT';
export const GATEWAY_IDENTITY_JWT_HEADER = 'X-CAIL-Gateway-Identity-JWT';

function normalizeIdentityJwt(value) {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  return token || undefined;
}

export function identityCredentialsFromEnv(env = process.env) {
  return {
    appIdentityJwt: normalizeIdentityJwt(env[APP_IDENTITY_JWT_ENV]),
    gatewayIdentityJwt: normalizeIdentityJwt(env[GATEWAY_IDENTITY_JWT_ENV]),
  };
}

export function identityHeaders(credentials = {}, { includeGateway = false } = {}) {
  const headers = {};
  const appIdentityJwt = normalizeIdentityJwt(credentials.appIdentityJwt);
  const gatewayIdentityJwt = normalizeIdentityJwt(credentials.gatewayIdentityJwt);
  if (appIdentityJwt) headers[APP_IDENTITY_JWT_HEADER] = appIdentityJwt;
  if (includeGateway && gatewayIdentityJwt) headers[GATEWAY_IDENTITY_JWT_HEADER] = gatewayIdentityJwt;
  return headers;
}

/** Remove credentials and common identity-bearing values from diagnostics. */
export function redactSensitiveText(value, credentials = {}) {
  let text = String(value);
  for (const token of [credentials.appIdentityJwt, credentials.gatewayIdentityJwt]) {
    const normalized = normalizeIdentityJwt(token);
    if (normalized) text = text.replaceAll(normalized, '[redacted]');
  }
  return text
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt redacted]')
    .replace(/\bcail-[A-Za-z0-9_-]+\b/g, '[subject redacted]')
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, '[id redacted]')
    .replace(/\b[^\s@]+@[^\s@]+\b/g, '[email redacted]');
}

/** Credentialed chat needs both the app and gateway identity legs. */
export function assertIdentityCredentials(credentials = {}, { withChat = false } = {}) {
  const appIdentityJwt = normalizeIdentityJwt(credentials.appIdentityJwt);
  const gatewayIdentityJwt = normalizeIdentityJwt(credentials.gatewayIdentityJwt);
  if (withChat && Boolean(appIdentityJwt) !== Boolean(gatewayIdentityJwt)) {
    throw new Error(
      `--with-chat=true requires both ${APP_IDENTITY_JWT_ENV} and ${GATEWAY_IDENTITY_JWT_ENV}`,
    );
  }
  return { appIdentityJwt, gatewayIdentityJwt };
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const inlineValueIndex = token.indexOf('=', 2);
    if (inlineValueIndex !== -1) {
      const key = token.slice(2, inlineValueIndex);
      args[key] = token.slice(inlineValueIndex + 1) || 'true';
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function applicationMount(baseUrl) {
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/g, '');
  return pathname === '/' ? '' : pathname;
}

export function applicationUrl(path, baseUrl) {
  if (!path.startsWith('/')) {
    throw new Error('Application path must start with /');
  }
  const url = new URL(baseUrl);
  url.pathname = `${applicationMount(url)}${path}`.replace(/\/+/g, '/');
  url.search = '';
  url.hash = '';
  return url;
}

export function agentSocketBasePath(baseUrl, agentClass, agentName) {
  const agent = agentClass
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return [
    applicationMount(baseUrl).replace(/^\/+/, ''),
    'agents',
    agent,
    encodeURIComponent(agentName),
  ].filter(Boolean).join('/');
}

const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';
const CSRF_HEADER = 'X-CAIL-CSRF';

function parseSetCookie(setCookie) {
  if (!setCookie) return null;
  return setCookie.split(';')[0]?.trim() || null;
}

function parseCsrfCookie(setCookie) {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,\\s]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export class SessionClient {
  constructor(baseUrl, initialCookie, credentials = {}) {
    this.baseUrl = new URL(baseUrl);
    this.cookie = initialCookie || '';
    this.csrfToken = '';
    this.identity = assertIdentityCredentials(credentials);
  }

  updateCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    const parsed = parseSetCookie(setCookie);
    if (parsed) this.cookie = parsed;
    const csrf = parseCsrfCookie(setCookie);
    if (csrf) this.csrfToken = csrf;
  }

  async fetch(path, init = {}, { includeGateway = false } = {}) {
    const url = applicationUrl(path, this.baseUrl);
    const headers = new Headers(init.headers || {});
    const keyringHeaders = identityHeaders(this.identity, { includeGateway });
    for (const headerName of [APP_IDENTITY_JWT_HEADER, GATEWAY_IDENTITY_JWT_HEADER]) {
      const value = keyringHeaders[headerName];
      if (value) headers.set(headerName, value);
      else headers.delete(headerName);
    }
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (this.csrfToken) headers.set(CSRF_HEADER, this.csrfToken);
    const response = await fetch(url, { ...init, headers });
    this.updateCookie(response);
    return response;
  }

  async json(path, init = {}, options = {}) {
    const response = await this.fetch(path, init, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.error === 'string'
        ? payload.error
        : payload.error ? JSON.stringify(payload.error) : '';
      const message = `Request failed with ${response.status}${detail ? `: ${detail}` : ''}`;
      throw new Error(redactSensitiveText(message, this.identity));
    }
    return payload;
  }

  async ensureSession() {
    const payload = await this.json('/api/session');
    return payload.sessionId;
  }
}

export async function createWorkspace(session, name = 'Smoke Test Workspace') {
  const payload = await session.json('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, { includeGateway: true });
  return payload.workspace;
}

export function fetchWorkspace(session, workspaceId, options = {}) {
  return session.json(`/api/workspaces/${workspaceId}`, {}, options);
}

export async function connectAgent(session, workspacePayload, { timeoutMs = 10000 } = {}) {
  const { agent } = workspacePayload;
  const url = new URL(session.baseUrl);
  const client = new AgentClient({
    agent: agent.className,
    name: agent.name,
    host: url.host,
    secure: url.protocol === 'https:',
    basePath: agentSocketBasePath(url, agent.className, agent.name),
    query: session.csrfToken ? { csrfToken: session.csrfToken } : undefined,
  });
  let timeout;
  try {
    await Promise.race([
      client.ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Agent WebSocket did not become ready')), timeoutMs);
      }),
    ]);
    return client;
  } catch (error) {
    client.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function makeUserMessage(prompt) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
  };
}

/** Send one chat turn and wait for the server's terminal response. */
export function sendChatTurn({ client, messages, prompt }) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const allMessages = [...messages, makeUserMessage(prompt)];

  return new Promise((resolve, reject) => {
    let finished = false;
    const chunks = [];
    const textParts = [];

    const cleanup = () => client.removeEventListener('message', onMessage);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== CHAT_MESSAGE_TYPE.RESPONSE || data.id !== requestId) return;
        if (data.error) {
          fail(new Error(data.body || 'Chat stream error'));
          return;
        }
        if (typeof data.body === 'string' && data.body.trim()) {
          const chunk = JSON.parse(data.body);
          chunks.push(chunk);
          if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
            textParts.push(chunk.delta);
          }
        }
        if (data.done) {
          finish({ ok: true, requestId, chunks, text: textParts.join('') });
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    client.addEventListener('message', onMessage);
    client.send(JSON.stringify({
      id: requestId,
      type: CHAT_MESSAGE_TYPE.REQUEST,
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: allMessages,
          trigger: 'submit-message',
        }),
      },
    }));
  });
}
