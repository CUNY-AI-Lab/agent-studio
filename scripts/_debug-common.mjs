import { mkdir, writeFile } from 'node:fs/promises';
import { AgentClient } from 'agents/client';

const CHAT_MESSAGE_TYPE = {
  REQUEST: 'cf_agent_use_chat_request',
  RESPONSE: 'cf_agent_use_chat_response',
  CANCEL: 'cf_agent_chat_request_cancel',
};

function parseSetCookie(setCookie) {
  if (!setCookie) return null;
  const first = setCookie.split(';')[0]?.trim();
  return first || null;
}

// The CSRF token is delivered via a Set-Cookie header (fleet contract §3¾ rule 3
// delivery amendment, 2026-07-05) named cail_csrf_agentstudio — never in the
// response body. A browser page reads it from document.cookie; this non-browser
// client parses the Set-Cookie header directly (the correct equivalent here).
const CSRF_COOKIE_NAME = 'cail_csrf_agentstudio';

function parseCsrfCookie(setCookie) {
  if (!setCookie) return null;
  // A single fetch() collapses multiple Set-Cookie headers into one comma-joined
  // string; cookie-pair commas don't occur here (values are hex + attributes),
  // so a name-anchored match is unambiguous.
  const match = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,\\s]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
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

// Protected workspace reads and every mutation carry the CSRF header (fleet
// contract §3¾ rule 3). Sending it on public reads is harmless and keeps this
// non-browser client aligned with both frontend fetch wrappers.
const CSRF_HEADER = 'X-CAIL-CSRF';

export class SessionClient {
  constructor(baseUrl, initialCookie) {
    this.baseUrl = new URL(baseUrl);
    this.cookie = initialCookie || '';
    this.csrfToken = '';
  }

  updateCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    const parsed = parseSetCookie(setCookie);
    if (parsed) {
      this.cookie = parsed;
    }
    // Capture the CSRF token from its Set-Cookie header whenever present (the
    // /api/session bootstrap sets it). Delivered via cookie, never body.
    const csrf = parseCsrfCookie(setCookie);
    if (csrf) {
      this.csrfToken = csrf;
    }
  }

  async fetch(path, init = {}) {
    const url = new URL(path, this.baseUrl);
    const headers = new Headers(init.headers || {});
    if (this.cookie) {
      headers.set('Cookie', this.cookie);
    }
    // Exercise the protected path exactly as a first-party page does. Absent
    // both Sec-Fetch-Site and Origin (a non-browser client), the worker falls
    // back to this token — so smoke passes with enforcement active.
    if (this.csrfToken) {
      headers.set(CSRF_HEADER, this.csrfToken);
    }
    const response = await fetch(url, {
      ...init,
      headers,
    });
    this.updateCookie(response);
    return response;
  }

  async json(path, init = {}) {
    const response = await this.fetch(path, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return payload;
  }

  async ensureSession() {
    // The CSRF token is captured from the Set-Cookie header in updateCookie()
    // (the amendment moved it out of the body); the body carries only sessionId.
    const payload = await this.json('/api/session');
    return payload.sessionId;
  }
}

export async function createWorkspace(session, name = 'CLI Debug Workspace') {
  const payload = await session.json('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return payload.workspace;
}

export async function fetchWorkspace(session, workspaceId) {
  return session.json(`/api/workspaces/${workspaceId}`);
}

export async function fetchObservability(session, workspaceId) {
  const payload = await session.json(`/api/workspaces/${workspaceId}/observability`);
  return payload.observability;
}

export function printObservabilitySummary(observability) {
  const latest = observability.requests[0];
  if (!latest) {
    console.log('No observability requests recorded yet.');
    return;
  }

  console.log(`requestId: ${latest.requestId}`);
  console.log(`status: ${latest.status}`);
  console.log(`model: ${latest.model}`);
  console.log(`startedAt: ${latest.startedAt}`);
  console.log(`updatedAt: ${latest.updatedAt}`);
  console.log(`idleMs: ${latest.idleMs}`);
  console.log(`suspectedStall: ${latest.suspectedStall}`);
  console.log(`steps: ${latest.steps}`);
  console.log(`finishReason: ${latest.finishReason || '(none)'}`);
  if (latest.rawFinishReason) {
    console.log(`rawFinishReason: ${latest.rawFinishReason}`);
  }
  if (latest.errors.length > 0) {
    console.log(`errors: ${latest.errors.join(' | ')}`);
  }
  console.log(`chunkCounts: text=${latest.chunkCounts.text} reasoning=${latest.chunkCounts.reasoning} toolInput=${latest.chunkCounts.toolInput} toolResult=${latest.chunkCounts.toolResult} raw=${latest.chunkCounts.raw}`);
  if (latest.tools.length > 0) {
    console.log('tools:');
    for (const tool of latest.tools) {
      console.log(`  - ${tool.toolName} (${tool.toolCallId}) state=${tool.state} chars=${tool.inputChars} deltas=${tool.deltaCount}${tool.lastPreview ? ` preview=${JSON.stringify(tool.lastPreview)}` : ''}`);
    }
  }
}

export async function saveObservability(observability, prefix = 'chat-trace') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `logs/${prefix}-${stamp}.json`;
  await mkdir('logs', { recursive: true });
  await writeFile(path, `${JSON.stringify(observability, null, 2)}\n`, 'utf8');
  return path;
}

export async function connectAgent(session, workspacePayload) {
  const { agent } = workspacePayload;
  const url = new URL(session.baseUrl);
  const client = new AgentClient({
    agent: agent.className,
    name: agent.name,
    host: url.host,
    secure: url.protocol === 'https:',
    headers: session.cookie ? { Cookie: session.cookie } : undefined,
    // Per-connection CSRF token on the WS upgrade (fleet contract §3¾ rule 4).
    // The DO closes the socket at accept without it, so smoke exercises the
    // protected handshake rather than bypassing it.
    query: session.csrfToken ? { csrfToken: session.csrfToken } : undefined,
  });
  await client.ready;
  return client;
}

function makeUserMessage(prompt) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
  };
}

export async function sendChatTurn({
  client,
  messages,
  prompt,
  scopePanelIds = [],
  idleTimeoutMs = 60000,
  totalTimeoutMs = 180000,
  verbose = true,
}) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const allMessages = [...messages, makeUserMessage(prompt)];

  return new Promise((resolve, reject) => {
    let finished = false;
    let lastActivityAt = Date.now();
    const chunks = [];
    const textParts = [];
    let idleTimer = null;
    let totalTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      client.removeEventListener('message', onMessage);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          client.send(JSON.stringify({
            id: requestId,
            type: CHAT_MESSAGE_TYPE.CANCEL,
          }));
        } catch {}
        cleanup();
        resolve({
          ok: false,
          requestId,
          reason: `idle-timeout after ${idleTimeoutMs}ms`,
          chunks,
          text: textParts.join(''),
        });
      }, idleTimeoutMs);
    };

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
        if (data.type !== CHAT_MESSAGE_TYPE.RESPONSE || data.id !== requestId) {
          return;
        }

        lastActivityAt = Date.now();
        resetIdleTimer();

        if (data.error) {
          fail(new Error(data.body || 'Chat stream error'));
          return;
        }

        if (typeof data.body === 'string' && data.body.trim()) {
          const chunk = JSON.parse(data.body);
          chunks.push(chunk);
          if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
            textParts.push(chunk.delta);
            if (verbose) process.stdout.write(chunk.delta);
          } else if (verbose && (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available' || chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error')) {
            process.stdout.write(`\n[${chunk.type}:${chunk.toolName || chunk.toolCallId}]\n`);
          }
        }

        if (data.done) {
          if (verbose) process.stdout.write('\n');
          finish({
            ok: true,
            requestId,
            chunks,
            text: textParts.join(''),
            lastActivityAt,
          });
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    totalTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        client.send(JSON.stringify({
          id: requestId,
          type: CHAT_MESSAGE_TYPE.CANCEL,
        }));
      } catch {}
      cleanup();
      resolve({
        ok: false,
        requestId,
        reason: `total-timeout after ${totalTimeoutMs}ms`,
        chunks,
        text: textParts.join(''),
      });
    }, totalTimeoutMs);

    client.addEventListener('message', onMessage);
    resetIdleTimer();

    client.send(JSON.stringify({
      id: requestId,
      type: CHAT_MESSAGE_TYPE.REQUEST,
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: allMessages,
          trigger: 'submit-message',
          ...(scopePanelIds.length > 0 ? { scopePanelIds } : {}),
        }),
      },
    }));
  });
}
