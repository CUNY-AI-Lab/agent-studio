import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { callable, type Connection, type ConnectionContext } from 'agents';
import { DynamicWorkerExecutor, type ExecuteResult } from '@cloudflare/codemode';
import { createCodeTool, resolveProvider, aiTools } from '@cloudflare/codemode/ai';
import { Workspace as RuntimeWorkspace } from '@cloudflare/shell';
import { gitTools } from '@cloudflare/shell/git';
import { stateTools } from '@cloudflare/shell/workers';
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import {
  DEFAULT_WORKSPACE_STATE,
  type LayoutPatch,
  type WorkspaceObservabilityEvent,
  type WorkspaceObservabilityRequest,
  type WorkspaceObservabilitySnapshot,
  type WorkspaceObservabilityToolCall,
  type WorkspacePanel,
  type WorkspaceRecord,
  type WorkspaceState,
} from '../domain/workspace';
import type { Env } from '../env';
import { createCailModel, resolveCailModelName } from '../lib/cail-model';
import { verifyCredentialForSession } from '../lib/cail-identity';
import { guardedWebFetch } from '../lib/web-fetch-guard';
import {
  extractPdfText,
  readXlsx,
  buildXlsx,
  buildDocx,
  MAX_PDF_PAGES,
  MAX_XLSX_ROWS,
  type XlsxCell,
  type DocxBlock,
} from '../lib/document-tools';
import { getSkillContent, SKILLS } from '../skills';
import { buildWorkspaceAgentSystemPrompt } from './instructions';
import {
  getMimeType,
  sanitizeRelativePath,
  toRuntimePath,
} from '../lib/files';
import { hydrateLegacyWorkspaceFiles } from '../lib/hydration';
import { addWorkspaceDownload } from '../lib/downloads';
import { putWorkspace } from '../lib/workspaces';
import { deriveCsrfToken, timingSafeEqual, wsOriginAllowed } from '../lib/csrf';
import { assertClientStateIdentity } from '../lib/agent-state-guard';
import { guardGitToken, parseGitAllowedHosts } from '../lib/git-guard';
import { quotaSignalFromError } from '../lib/quota-error';
import { checkHeavyRpcLimit } from '../lib/rate-limit';

const DYNAMIC_WORKER_TIMEOUT_MS = 30_000;
const RUNTIME_R2_PREFIX = 'agent-studio/runtime';
const MAX_TOOL_TEXT_CHARS = 2000;
const MAX_INLINE_MARKDOWN_CHARS = 3000;
const MAX_OBSERVABILITY_EVENTS = 400;
const MAX_OBSERVABILITY_REQUESTS = 20;
const OBSERVABILITY_STALL_MS = 15_000;
const HYDRATION_COMPLETE_KEY = 'runtimeWorkspaceHydrated:v1';
const MIGRATION_FROZEN_KEY = 'migrationFrozen:v1';

const CODEMODE_DESCRIPTION = [
  'Write an async JavaScript arrow function and execute it in a Cloudflare Dynamic Worker sandbox.',
  'Prefer this for multi-step analysis, file transformation, aggregation, and tasks that would otherwise require many sequential tool calls.',
  'Inside the sandbox, direct network access is blocked. Use the provided codemode.* helper functions, the state.* filesystem API, and git.* repository helpers instead.',
  '{{types}}',
].join('\n');

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function inferFilePanelType(filePath: string): 'pdf' | 'preview' | 'editor' {
  if (filePath.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (/\.(html?|svg)$/i.test(filePath)) return 'preview';
  return 'editor';
}

function fromRuntimePath(filePath: string): string {
  return filePath.replace(/^\/+/, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

type SerializedPanelContext = Record<string, unknown>;

function serializePanelForContext(panel: WorkspacePanel, allPanels: WorkspacePanel[]): SerializedPanelContext {
  const base = {
    id: panel.id,
    type: panel.type,
    title: panel.title,
    sourcePanelId: panel.sourcePanelId,
    layout: panel.layout,
  };

  switch (panel.type) {
    case 'markdown':
      return {
        ...base,
        content: panel.content,
      };
    case 'table':
      return {
        ...base,
        columns: panel.columns,
        rows: panel.rows,
      };
    case 'chart':
      return {
        ...base,
        chartType: panel.chartType,
        data: panel.data,
      };
    case 'cards':
      return {
        ...base,
        items: panel.items,
      };
    case 'preview':
      return {
        ...base,
        filePath: panel.filePath,
        content: panel.content,
      };
    case 'pdf':
    case 'editor':
    case 'file':
      return {
        ...base,
        filePath: panel.filePath,
      };
    case 'fileTree':
      return {
        ...base,
        kind: 'workspace-files',
      };
    case 'detail': {
      const linkedPanel = panel.linkedTo
        ? allPanels.find((candidate) => candidate.id === panel.linkedTo)
        : null;
      return {
        ...base,
        linkedTo: panel.linkedTo,
        linkedPanel: linkedPanel ? serializePanelForContext(linkedPanel, allPanels) : null,
      };
    }
    case 'chat':
      return base;
  }
}

function clipPreview(value: string, maxChars = 180): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}...`;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return clipPreview(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return clipPreview(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clipPreview(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function summarizeChunkData(chunk: { type: string } & Record<string, unknown>): Record<string, unknown> | undefined {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return { chars: typeof chunk.text === 'string' ? chunk.text.length : 0 };
    case 'tool-input-start':
      return {
        toolCallId: typeof chunk.id === 'string' ? chunk.id : undefined,
        toolName: typeof chunk.toolName === 'string' ? chunk.toolName : undefined,
      };
    case 'tool-input-delta':
      return {
        toolCallId: typeof chunk.id === 'string' ? chunk.id : undefined,
        chars: typeof chunk.delta === 'string' ? chunk.delta.length : 0,
        preview: typeof chunk.delta === 'string' ? clipPreview(chunk.delta) : undefined,
      };
    case 'tool-call':
      return {
        toolCallId: typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined,
        toolName: typeof chunk.toolName === 'string' ? chunk.toolName : undefined,
        invalid: Boolean(chunk.invalid),
        inputPreview: summarizeUnknown(chunk.input),
      };
    case 'tool-result':
      return {
        toolCallId: typeof chunk.toolCallId === 'string' ? chunk.toolCallId : undefined,
        toolName: typeof chunk.toolName === 'string' ? chunk.toolName : undefined,
        outputPreview: summarizeUnknown(chunk.output),
      };
    case 'raw':
      return {
        preview: summarizeUnknown(chunk.rawValue),
      };
    default:
      return undefined;
  }
}

const CAIL_CREDENTIAL_STORAGE_KEY = 'cail:identity-jwt';

export class WorkspaceAgent extends AIChatAgent<Env, WorkspaceState> {
  initialState: WorkspaceState = DEFAULT_WORKSPACE_STATE;
  private runtimeWorkspace?: RuntimeWorkspace;
  private observabilityEvents: WorkspaceObservabilityEvent[] = [];
  private observabilityRequests = new Map<string, WorkspaceObservabilityRequest>();
  private observabilitySequence = 0;
  private hydrationComplete = false;
  private hydrationPromise: Promise<void> | null = null;
  private migrationFrozen = false;
  /**
   * The caller's verified X-CAIL-Identity-JWT, forwarded to the model proxy as
   * the model-call credential. Set server-side (never over the client WebSocket,
   * which cannot carry the gateway-injected header) via setCailCredential, and
   * kept in DO storage so it survives hibernation. Never broadcast in state.
   */
  private cailIdentityJwt: string | null = null;

  async onStart() {
    if (!this.state.workspace) {
      this.setState(DEFAULT_WORKSPACE_STATE);
    }
    if (this.cailIdentityJwt === null) {
      const stored = await this.ctx.storage.get<string>(CAIL_CREDENTIAL_STORAGE_KEY);
      if (typeof stored === 'string') {
        this.cailIdentityJwt = stored;
      }
    }
    if (await this.ctx.storage.get(MIGRATION_FROZEN_KEY)) {
      this.migrationFrozen = true;
    }
  }

  /**
   * The session id this DO is keyed to. The agent name is `${sessionId}-${wid}`
   * and the session id is a 32-hex string; syncWorkspace also stamps it into
   * state. Prefer state (authoritative, set on every open) and fall back to the
   * name so the CSRF token can be derived even before the first sync.
   */
  private csrfSessionId(): string | null {
    if (this.state.sessionId) return this.state.sessionId;
    const match = /^([a-f0-9]{32})-/.exec(this.name);
    return match ? match[1] : null;
  }

  /** Expected per-connection CSRF token for this DO's session (rule 3). */
  private async expectedCsrfToken(): Promise<string | null> {
    const sessionId = this.csrfSessionId();
    if (!sessionId) return null;
    return deriveCsrfToken(sessionId, this.env.SESSION_SECRET);
  }

  private async csrfTokenMatches(candidate: string | null): Promise<boolean> {
    if (!candidate) return false;
    const expected = await this.expectedCsrfToken();
    return expected !== null && timingSafeEqual(candidate, expected);
  }

  /**
   * WebSocket connect gate (rule 4). Enforced here rather than per-message
   * because the `agents` framework dispatches RPC calls and chat requests inside
   * base-class constructor wrappers that run before any subclass onMessage
   * override — so the handshake is the only reliable seam a subclass owns for
   * gating state-changing traffic on this socket.
   *
   * Two checks, both against the fleet contract:
   *   * Origin (rule 4): re-checked here as defense-in-depth. server.ts already
   *     blocks a cross-origin upgrade before routeAgentRequest; this covers any
   *     future path that reaches the DO without that guard.
   *   * CSRF token (rules 3 & 4): the first-party page connects with
   *     `?csrfToken=<token>`. The browser cannot set custom headers on a WS
   *     upgrade, so the token rides the query string; its SOURCE is the
   *     path-scoped cail_csrf_agentstudio cookie the page reads from
   *     document.cookie (delivery amendment 2026-07-05 — the token is no longer
   *     in any response body). A sibling tool on the same host is same-origin
   *     but, being outside our cookie's path prefix, cannot read that token, so
   *     it cannot open a mutating socket. A connection that fails either
   *     check is closed (1008) — every message on this socket, chat or RPC,
   *     mutates or spends, so there is no read-only-only client to preserve.
   *
   * The token is verified once, at accept, and the accepted connection is
   * implicitly the "verified state on the connection" the contract calls for.
   */
  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    if (!wsOriginAllowed(ctx.request, this.env.CAIL_CANONICAL_ORIGIN)) {
      connection.close(1008, 'csrf_origin_mismatch');
      return;
    }
    let token: string | null = null;
    try {
      token = new URL(ctx.request.url).searchParams.get('csrfToken');
    } catch {
      token = null;
    }
    if (!(await this.csrfTokenMatches(token))) {
      connection.close(1008, 'csrf_token_invalid');
      return;
    }
  }

  validateStateChange(nextState: WorkspaceState, source: 'server' | unknown): void {
    if (source === 'server') return;
    assertClientStateIdentity(this.name, nextState);
  }

  /**
   * Store the caller's identity JWT for use as the model-proxy credential.
   *
   * @callable methods are client-invokable over the WS RPC channel, so this
   * must NOT trust its argument: it re-verifies the token through the same CAIL
   * verifier the HTTP middleware uses (HMAC + all claims) AND binds the verified
   * subject to THIS DO's session id. A garbage/expired token, or a genuinely
   * valid token belonging to a DIFFERENT subject, is rejected — a client can
   * never install a foreign credential onto someone else's workspace DO.
   *
   * The legitimate path (server.ts primeAgentCredential, after HTTP identity
   * verification) still succeeds: that token is valid and its subject maps to
   * exactly this DO's session id.
   *
   * A null token is ignored so an anonymous read never clears a live credential
   * mid-session.
   */
  @callable()
  async setCailCredential(identityJwt: string | null): Promise<void> {
    if (!identityJwt) return;
    if (identityJwt === this.cailIdentityJwt) return;

    const expectedSessionId = this.csrfSessionId();
    if (!expectedSessionId) {
      // No session id derivable yet (DO opened before first sync and the name
      // is not in the expected `${sessionId}-${wid}` shape): refuse rather than
      // store an unbindable credential.
      throw new Error('setCailCredential: session id unavailable for credential binding');
    }
    const identity = await verifyCredentialForSession(
      identityJwt,
      expectedSessionId,
      this.env.CAIL_IDENTITY_JWT_SECRET,
    );
    if (!identity) {
      throw new Error('setCailCredential: rejected unverified or non-matching identity JWT');
    }

    this.cailIdentityJwt = identityJwt;
    await this.ctx.storage.put(CAIL_CREDENTIAL_STORAGE_KEY, identityJwt);
  }

  async syncWorkspace(workspace: WorkspaceRecord, sessionId: string): Promise<void> {
    await this.ensureRuntimeWorkspaceHydrated(workspace, sessionId);
    const nextState: WorkspaceState = {
      ...this.state,
      sessionId,
      workspace,
      panels: this.state.panels.length > 0 ? this.state.panels : DEFAULT_WORKSPACE_STATE.panels,
      viewport: this.state.viewport || DEFAULT_WORKSPACE_STATE.viewport,
      groups: this.state.groups || [],
      connections: this.state.connections || [],
    };
    this.setState(nextState);
  }

  @callable()
  async freezeForMigration(): Promise<void> {
    this.migrationFrozen = true;
    await this.ctx.storage.put(MIGRATION_FROZEN_KEY, true);
  }

  async replaceWorkspaceState(state: WorkspaceState, workspace: WorkspaceRecord, sessionId: string): Promise<void> {
    this.setState({
      ...state,
      sessionId,
      workspace,
      panels: state.panels.length > 0 ? state.panels : DEFAULT_WORKSPACE_STATE.panels,
      viewport: state.viewport || DEFAULT_WORKSPACE_STATE.viewport,
      groups: state.groups || [],
      connections: state.connections || [],
    });
  }

  async onChatMessage(_onFinish?: unknown, options?: OnChatMessageOptions) {
    this.assertNotFrozen();
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSessionId();
    const requestId = options?.requestId ?? 'unknown';

    if (!this.cailIdentityJwt) {
      // No verified CAIL credential reached this workspace: the model proxy
      // has no way to authenticate or attribute spend. Surface the CAIL
      // authentication_required envelope rather than calling out anonymously.
      this.finalizeObservabilityRequest(requestId, 'error', 'No CAIL identity credential for model call', {
        error: 'authentication_required',
      }, 'error');
      return new Response(
        JSON.stringify({
          error: 'authentication_required',
          login_url: '/login',
          message: 'Sign in with CUNY Login at https://tools.ailab.gc.cuny.edu to use Agent Studio.',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    try {
      const scopedPanelIds = Array.isArray(options?.body?.scopePanelIds)
        ? options.body.scopePanelIds.filter((value): value is string => typeof value === 'string')
        : [];
      const scopedPanels = scopedPanelIds
        .map((panelId) => this.state.panels.find((panel) => panel.id === panelId))
        .filter((panel): panel is WorkspacePanel => Boolean(panel));
      const scopedPanelPrompt = scopedPanels.length > 0
        ? [
          'The client scoped this turn to the selected canvas tiles listed below.',
          'Focus on these tiles unless the user explicitly broadens scope.',
          ...scopedPanels.map((panel) => {
            const details = [
              `id=${panel.id}`,
              `type=${panel.type}`,
              panel.title ? `title=${panel.title}` : null,
              'filePath' in panel ? `file=${panel.filePath}` : null,
              'content' in panel && panel.content ? `content=${JSON.stringify(panel.content.slice(0, 240))}` : null,
              'linkedTo' in panel && panel.linkedTo ? `linkedTo=${panel.linkedTo}` : null,
            ].filter(Boolean).join(', ');
            return `- ${details}`;
          }),
        ].join('\n')
        : null;
      const hostTools = this.buildHostTools(workspace, sessionId, scopedPanels);
      const codemode = this.createCodeModeTool(hostTools);
      const modelTools = this.buildModelTools(hostTools);
      // Per-workspace override wins; otherwise the env default. The same name
      // feeds observability so traces reflect the model actually called.
      const modelName = workspace.model || resolveCailModelName(this.env);
      const model = createCailModel({
        env: this.env,
        identityJwt: this.cailIdentityJwt,
        model: workspace.model,
      });
      const scopedPanelTraceIds = scopedPanels.map((panel) => panel.id);

      this.ensureObservabilityRequest(requestId, modelName, scopedPanelTraceIds);
      this.pushObservabilityEvent(requestId, 'request-start', 'Chat request started', 'info', {
        workspaceId: workspace.id,
        sessionId,
        model: modelName,
        scopedPanelIds: scopedPanelTraceIds,
      });

      const result = streamText({
        model,
        abortSignal: options?.abortSignal,
        system: buildWorkspaceAgentSystemPrompt(scopedPanelPrompt),
        messages: pruneMessages({
          messages: await convertToModelMessages(this.messages),
          toolCalls: 'before-last-2-messages',
        }),
        tools: {
          ...modelTools,
          codemode,
        },
        stopWhen: stepCountIs(12),
        includeRawChunks: true,
        experimental_onStepStart: () => {
          const request = this.ensureObservabilityRequest(requestId, modelName, scopedPanelTraceIds);
          request.steps += 1;
          this.markObservabilityUpdated(request, false);
          this.pushObservabilityEvent(requestId, 'step-start', `Model step ${request.steps} started`, 'info');
        },
        onChunk: ({ chunk }) => {
          this.recordChunkObservability(
            requestId,
            modelName,
            scopedPanelTraceIds,
            chunk as { type: string } & Record<string, unknown>
          );
        },
        onFinish: ({ finishReason, rawFinishReason, totalUsage, response }) => {
          this.finalizeObservabilityRequest(requestId, 'finished', 'Chat request finished', {
            finishReason,
            rawFinishReason,
            totalUsage,
            responseId: response?.id,
          });
        },
        onAbort: ({ steps }) => {
          this.finalizeObservabilityRequest(requestId, 'aborted', 'Chat request aborted', {
            steps: steps.length,
          }, 'warn');
        },
        onError: (error) => {
          this.finalizeObservabilityRequest(requestId, 'error', 'streamText reported an error', {
            error: summarizeError(error.error),
          }, 'error');
          console.error('WorkspaceAgent streamText error', {
            workspaceId: workspace.id,
            sessionId,
            requestId,
            error,
          });
        },
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          this.finalizeObservabilityRequest(requestId, 'error', 'UI message stream failed', {
            error: summarizeError(error),
          }, 'error');
          console.error('WorkspaceAgent chat stream failed', {
            workspaceId: workspace.id,
            sessionId,
            requestId,
            error,
          });
          const quota = quotaSignalFromError(error);
          return quota ?? 'Agent Studio hit an internal error while streaming this response.';
        },
      });
    } catch (error) {
      this.finalizeObservabilityRequest(requestId, 'error', 'Chat failed before streaming began', {
        error: summarizeError(error),
      }, 'error');
      console.error('WorkspaceAgent chat failed before streaming began', {
        workspaceId: workspace.id,
        sessionId,
        requestId,
        error,
      });
      return new Response('Agent Studio could not start this response.', { status: 500 });
    }
  }

  @callable()
  async getSnapshot(): Promise<WorkspaceState> {
    return this.state;
  }

  @callable()
  async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }

  @callable()
  async getObservability(): Promise<WorkspaceObservabilitySnapshot> {
    return this.snapshotObservability();
  }

  @callable()
  async getRuntimeInfo(): Promise<{
    provider: 'dynamic-workers';
    codemode: true;
    git: true;
    timeoutMs: number;
    outbound: 'tool-only';
  }> {
    return {
      provider: 'dynamic-workers',
      codemode: true,
      git: true,
      timeoutMs: DYNAMIC_WORKER_TIMEOUT_MS,
      outbound: 'tool-only',
    };
  }

  @callable()
  async executeCode(code: string): Promise<ExecuteResult> {
    this.assertNotFrozen();
    const rateKey = this.csrfSessionId() ?? this.requireSessionId();
    if (!(await checkHeavyRpcLimit(this.env, rateKey))) {
      throw new Error('rate_limited: too many code executions — try again shortly.');
    }
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSessionId();
    const tools = this.buildHostTools(workspace, sessionId);
    const executor = this.createCodeExecutor();
    return executor.execute(code, this.buildCodeProviders(tools));
  }

  @callable()
  async getWorkspaceFiles(): Promise<Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    uploadedAt?: string;
    etag?: string;
  }>> {
    return this.listRuntimeFiles();
  }

  @callable()
  async readWorkspaceFileContent(filePath: string): Promise<{
    filePath: string;
    contentType: string;
    data: ArrayBuffer;
  } | null> {
    return this.readRuntimeFileContent(filePath);
  }

  @callable()
  async writeWorkspaceFileContent(
    filePath: string,
    data: string | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<{ ok: true; filePath: string }> {
    this.assertNotFrozen();
    const runtime = this.getRuntimeWorkspace();
    const relativePath = sanitizeRelativePath(filePath);
    if (typeof data === 'string') {
      await runtime.writeFile(toRuntimePath(relativePath), data, contentType || getMimeType(relativePath));
    } else {
      await runtime.writeFileBytes(toRuntimePath(relativePath), data, contentType || getMimeType(relativePath));
    }
    return { ok: true, filePath: relativePath };
  }

  @callable()
  async deleteWorkspaceFileContent(filePath: string): Promise<{ ok: true; filePath: string }> {
    this.assertNotFrozen();
    const runtime = this.getRuntimeWorkspace();
    const relativePath = sanitizeRelativePath(filePath);
    await runtime.rm(toRuntimePath(relativePath), { force: true });
    return { ok: true, filePath: relativePath };
  }

  @callable()
  async clearWorkspaceFiles(): Promise<void> {
    const runtime = this.getRuntimeWorkspace();
    const paths = (await runtime._getAllPaths()).filter((path) => path !== '/' && path !== '');
    for (const path of [...paths].sort((left, right) => right.length - left.length)) {
      await runtime.rm(path, { recursive: true, force: true });
    }
  }

  @callable()
  async addPanel(panel: WorkspacePanel): Promise<WorkspaceState> {
    this.assertNotFrozen();
    this.upsertPanel(panel);
    return this.state;
  }

  @callable()
  async removePanel(panelId: string): Promise<WorkspaceState> {
    this.assertNotFrozen();
    this.setState({
      ...this.state,
      panels: this.state.panels.filter((panel) => panel.id !== panelId),
      groups: this.state.groups
        .map((group) => ({ ...group, panelIds: group.panelIds.filter((id) => id !== panelId) }))
        .filter((group) => group.panelIds.length >= 2),
      connections: this.state.connections.filter(
        (connection) => connection.sourceId !== panelId && connection.targetId !== panelId
      ),
    });
    return this.state;
  }

  @callable()
  async applyLayoutPatch(patch: LayoutPatch): Promise<WorkspaceState> {
    this.assertNotFrozen();
    const panels = this.state.panels.map((panel) => {
      const nextLayout = patch.panels?.[panel.id];
      if (!nextLayout) return panel;
      return {
        ...panel,
        layout: {
          ...panel.layout,
          ...(Number.isFinite(nextLayout.x) ? { x: clamp(nextLayout.x as number, 0, 100000) } : {}),
          ...(Number.isFinite(nextLayout.y) ? { y: clamp(nextLayout.y as number, 0, 100000) } : {}),
          ...(Number.isFinite(nextLayout.width) ? { width: clamp(nextLayout.width as number, 100, 10000) } : {}),
          ...(Number.isFinite(nextLayout.height) ? { height: clamp(nextLayout.height as number, 60, 10000) } : {}),
        },
      };
    });

    this.setState({
      ...this.state,
      panels,
      groups: patch.groups ?? this.state.groups,
      connections: patch.connections ?? this.state.connections,
      viewport: patch.viewport ?? this.state.viewport,
    });
    return this.state;
  }

  private snapshotObservability(now = Date.now()): WorkspaceObservabilitySnapshot {
    const requests = [...this.observabilityRequests.values()]
      .slice(-MAX_OBSERVABILITY_REQUESTS)
      .map((request) => {
        const updatedAtMs = Date.parse(request.updatedAt);
        const idleMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
        return {
          ...request,
          idleMs,
          suspectedStall: request.status === 'streaming' && idleMs >= OBSERVABILITY_STALL_MS,
          tools: request.tools.map((toolCall) => ({ ...toolCall })),
          errors: [...request.errors],
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return {
      generatedAt: new Date(now).toISOString(),
      requests,
      events: [...this.observabilityEvents],
    };
  }

  private ensureObservabilityRequest(
    requestId: string,
    model: string,
    scopedPanelIds: string[]
  ): WorkspaceObservabilityRequest {
    const existing = this.observabilityRequests.get(requestId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const request: WorkspaceObservabilityRequest = {
      requestId,
      status: 'streaming',
      model,
      startedAt: now,
      updatedAt: now,
      lastChunkAt: undefined,
      idleMs: 0,
      suspectedStall: false,
      scopedPanelIds: [...scopedPanelIds],
      steps: 0,
      chunkCounts: {
        text: 0,
        reasoning: 0,
        toolInput: 0,
        toolResult: 0,
        raw: 0,
      },
      errors: [],
      tools: [],
    };
    this.observabilityRequests.set(requestId, request);
    while (this.observabilityRequests.size > MAX_OBSERVABILITY_REQUESTS) {
      const oldestKey = this.observabilityRequests.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.observabilityRequests.delete(oldestKey);
    }
    return request;
  }

  private pushObservabilityEvent(
    requestId: string,
    type: WorkspaceObservabilityEvent['type'],
    detail: string,
    level: WorkspaceObservabilityEvent['level'] = 'info',
    data?: Record<string, unknown>
  ) {
    const event: WorkspaceObservabilityEvent = {
      id: `${Date.now()}-${this.observabilitySequence += 1}`,
      requestId,
      at: new Date().toISOString(),
      level,
      type,
      detail,
      ...(data ? { data } : {}),
    };
    this.observabilityEvents.push(event);
    if (this.observabilityEvents.length > MAX_OBSERVABILITY_EVENTS) {
      this.observabilityEvents.splice(0, this.observabilityEvents.length - MAX_OBSERVABILITY_EVENTS);
    }
  }

  private markObservabilityUpdated(request: WorkspaceObservabilityRequest, chunk = false) {
    const now = new Date().toISOString();
    request.updatedAt = now;
    if (chunk) {
      request.lastChunkAt = now;
    }
  }

  private getOrCreateToolTrace(
    request: WorkspaceObservabilityRequest,
    toolCallId: string,
    toolName: string
  ): WorkspaceObservabilityToolCall {
    const existing = request.tools.find((toolCall) => toolCall.toolCallId === toolCallId);
    if (existing) {
      if (!existing.toolName && toolName) {
        existing.toolName = toolName;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const toolTrace: WorkspaceObservabilityToolCall = {
      toolCallId,
      toolName,
      state: 'input-streaming',
      inputChars: 0,
      deltaCount: 0,
      startedAt: now,
      updatedAt: now,
    };
    request.tools.push(toolTrace);
    return toolTrace;
  }

  private recordChunkObservability(
    requestId: string,
    model: string,
    scopedPanelIds: string[],
    chunk: { type: string } & Record<string, unknown>
  ) {
    const request = this.ensureObservabilityRequest(requestId, model, scopedPanelIds);
    this.markObservabilityUpdated(request, true);

    switch (chunk.type) {
      case 'text-delta':
        request.chunkCounts.text += 1;
        if (request.chunkCounts.text <= 3 || request.chunkCounts.text % 50 === 0) {
          this.pushObservabilityEvent(requestId, 'chunk', 'Text delta received', 'info', summarizeChunkData(chunk));
        }
        break;
      case 'reasoning-delta':
        request.chunkCounts.reasoning += 1;
        if (request.chunkCounts.reasoning <= 2 || request.chunkCounts.reasoning % 25 === 0) {
          this.pushObservabilityEvent(requestId, 'chunk', 'Reasoning delta received', 'info', summarizeChunkData(chunk));
        }
        break;
      case 'tool-input-start': {
        const toolCallId = typeof chunk.id === 'string' ? chunk.id : crypto.randomUUID();
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : 'unknown';
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = 'input-streaming';
        toolTrace.updatedAt = new Date().toISOString();
        this.pushObservabilityEvent(requestId, 'tool-call', `Tool input started: ${toolName}`, 'info', summarizeChunkData(chunk));
        break;
      }
      case 'tool-input-delta': {
        request.chunkCounts.toolInput += 1;
        const toolCallId = typeof chunk.id === 'string' ? chunk.id : 'unknown';
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, 'unknown');
        const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
        toolTrace.inputChars += delta.length;
        toolTrace.deltaCount += 1;
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = clipPreview(delta);
        const shouldLogProgress = toolTrace.deltaCount <= 3
          || toolTrace.deltaCount % 10 === 0
          || toolTrace.inputChars % 1000 < delta.length;
        if (shouldLogProgress) {
          this.pushObservabilityEvent(
            requestId,
            'chunk',
            `Tool input delta for ${toolTrace.toolName}`,
            'info',
            {
              toolCallId,
              deltaChars: delta.length,
              inputChars: toolTrace.inputChars,
              deltaCount: toolTrace.deltaCount,
              preview: toolTrace.lastPreview,
            }
          );
        }
        break;
      }
      case 'tool-call': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : 'unknown';
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : 'unknown';
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = 'input-available';
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = summarizeUnknown(chunk.input);
        this.pushObservabilityEvent(requestId, 'tool-call', `Tool call ready: ${toolName}`, 'info', summarizeChunkData(chunk));
        break;
      }
      case 'tool-result': {
        request.chunkCounts.toolResult += 1;
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : 'unknown';
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : 'unknown';
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = 'output-available';
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = summarizeUnknown(chunk.output);
        this.pushObservabilityEvent(requestId, 'tool-result', `Tool result available: ${toolName}`, 'info', summarizeChunkData(chunk));
        break;
      }
      case 'raw':
        request.chunkCounts.raw += 1;
        if (request.chunkCounts.raw <= 3 || request.chunkCounts.raw % 20 === 0) {
          this.pushObservabilityEvent(requestId, 'chunk', 'Raw provider chunk received', 'info', summarizeChunkData(chunk));
        }
        break;
      default:
        break;
    }
  }

  private finalizeObservabilityRequest(
    requestId: string,
    status: WorkspaceObservabilityRequest['status'],
    detail: string,
    data?: Record<string, unknown>,
    level: WorkspaceObservabilityEvent['level'] = 'info'
  ) {
    const request = this.observabilityRequests.get(requestId);
    if (request) {
      request.status = status;
      this.markObservabilityUpdated(request, false);
      if (status === 'error' && data?.error) {
        request.errors.push(String(data.error));
      }
      if (typeof data?.finishReason === 'string') {
        request.finishReason = data.finishReason;
      }
      if (typeof data?.rawFinishReason === 'string') {
        request.rawFinishReason = data.rawFinishReason;
      }
    }
    this.pushObservabilityEvent(requestId, status === 'finished' ? 'finish' : status === 'aborted' ? 'abort' : 'error', detail, level, data);
  }

  private createCodeExecutor(): DynamicWorkerExecutor {
    return new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      timeout: DYNAMIC_WORKER_TIMEOUT_MS,
      globalOutbound: null,
    });
  }

  private createCodeModeTool(tools: ReturnType<WorkspaceAgent['buildHostTools']>) {
    const codeModeTools = this.buildCodeModeHostTools(tools);
    return createCodeTool({
      tools: [
        aiTools(codeModeTools),
        stateTools(this.getRuntimeWorkspace()),
        guardGitToken(gitTools(this.getRuntimeWorkspace()), {
          token: this.env.GIT_AUTH_TOKEN,
          allowedHosts: parseGitAllowedHosts(this.env),
        }),
      ],
      executor: this.createCodeExecutor(),
      description: CODEMODE_DESCRIPTION,
    });
  }

  private buildCodeProviders(tools: ReturnType<WorkspaceAgent['buildHostTools']>) {
    const codeModeTools = this.buildCodeModeHostTools(tools);
    return [
      resolveProvider(aiTools(codeModeTools)),
      resolveProvider(stateTools(this.getRuntimeWorkspace())),
      resolveProvider(guardGitToken(gitTools(this.getRuntimeWorkspace()), {
        token: this.env.GIT_AUTH_TOKEN,
        allowedHosts: parseGitAllowedHosts(this.env),
      })),
    ];
  }

  private buildCodeModeHostTools(tools: ReturnType<WorkspaceAgent['buildHostTools']>) {
    const {
      list_files: _listFiles,
      read_file: _readFile,
      write_file: _writeFile,
      ...codeModeTools
    } = tools;

    return codeModeTools;
  }

  private buildHostTools(workspace: WorkspaceRecord, sessionId: string, scopedPanels: WorkspacePanel[] = []) {
    const tools = {
      list_files: tool({
        description: 'List all files in the current workspace.',
        inputSchema: z.object({}),
        execute: async () => this.listRuntimeFiles(),
      }),
      read_panel: tool({
        description: 'Inspect a canvas tile by id, including its full data where available.',
        inputSchema: z.object({
          panelId: z.string(),
        }),
        execute: async ({ panelId }) => {
          const panel = this.state.panels.find((candidate) => candidate.id === panelId);
          if (!panel) {
            throw new Error(`Panel not found: ${panelId}`);
          }
          const payload = serializePanelForContext(panel, this.state.panels);
          if (panel.type === 'fileTree') {
            return {
              ...payload,
              files: await this.listRuntimeFiles(),
            };
          }
          return payload;
        },
      }),
      read_file: tool({
        description: 'Read a UTF-8 text file from the current workspace.',
        inputSchema: z.object({ filePath: z.string() }),
        execute: async ({ filePath }) => {
          const runtime = this.getRuntimeWorkspace();
          const text = await runtime.readFile(toRuntimePath(filePath));
          if (text === null) {
            throw new Error(`File not found: ${filePath}`);
          }
          return text;
        },
      }),
      write_file: tool({
        description: [
          'Write a UTF-8 text file into the current workspace.',
          'Use this for durable artifacts that will be shown as file-backed tiles.',
          `Keep each call under ${MAX_TOOL_TEXT_CHARS} characters.`,
          'For larger files, make multiple calls with mode="append" or use codemode.',
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string(),
          content: z.string().max(MAX_TOOL_TEXT_CHARS),
          contentType: z.string().optional(),
          mode: z.enum(['replace', 'append']).default('replace'),
        }),
        strict: true,
        execute: async ({ filePath, content, contentType, mode }) => {
          const relativePath = sanitizeRelativePath(filePath);
          const runtime = this.getRuntimeWorkspace();
          const runtimePath = toRuntimePath(relativePath);
          const mimeType = contentType || getMimeType(relativePath);

          if (mode === 'append') {
            const existing = await runtime.exists(runtimePath);
            if (existing) {
              await runtime.appendFile(runtimePath, content, mimeType);
            } else {
              await runtime.writeFile(runtimePath, content, mimeType);
            }
          } else {
            await runtime.writeFile(runtimePath, content, mimeType);
          }
          return { ok: true, filePath: relativePath };
        },
      }),
      web_fetch: tool({
        description: [
          'Fetch a public http(s) URL from the host worker. Use this from codemode instead of direct fetch().',
          'Localhost, private-network, and cloud-metadata destinations are blocked.',
          'Configured institutional API credentials (e.g. CUNY Primo) are attached automatically server-side.',
        ].join(' '),
        inputSchema: z.object({
          url: z.string().url(),
          format: z.enum(['text', 'json']).default('text'),
        }),
        execute: async ({ url, format }) => guardedWebFetch(url, format, this.env),
      }),
      read_skill: tool({
        description: [
          'Read the reference doc for a research source or capability skill listed in the system prompt.',
          'Call this before the first use of a source in a conversation to get exact endpoints, parameters, and response shapes.',
        ].join(' '),
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const content = getSkillContent(name);
          if (!content) {
            throw new Error(
              `Unknown skill: ${name}. Available: ${SKILLS.map((skill) => skill.name).join(', ')}`
            );
          }
          return content;
        },
      }),
      parse_pdf: tool({
        description: [
          'Extract the text layer from a PDF file in the workspace and return it with page markers.',
          'Codemode-only: call this from inside codemode as codemode.parse_pdf({ filePath }).',
          'Text-layer only — scanned or image-only PDFs return little or no text (there is no OCR).',
          `Output is capped (~200k chars, ${MAX_PDF_PAGES} pages max); check "truncated" and re-run with maxPages if needed.`,
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string().describe('Workspace-relative path to the .pdf file.'),
          maxPages: z.number().int().positive().optional().describe('Extract only the first N pages.'),
        }),
        execute: async ({ filePath, maxPages }) => {
          const bytes = await this.requireRuntimeFileBytes(filePath);
          const result = await extractPdfText(bytes, { maxPages });
          return { ok: true, filePath: sanitizeRelativePath(filePath), ...result };
        },
      }),
      read_xlsx: tool({
        description: [
          'Read one sheet of an .xlsx/.xls/.csv workbook in the workspace into JSON rows.',
          'Codemode-only: call as codemode.read_xlsx({ filePath, sheet?, maxRows? }).',
          'Returns array-of-arrays rows by default; check "truncated" and "totalRows" for row caps.',
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string().describe('Workspace-relative path to the workbook.'),
          sheet: z.string().optional().describe('Sheet name; defaults to the first sheet.'),
          maxRows: z.number().int().positive().optional().describe(`Cap returned data rows (max ${MAX_XLSX_ROWS}).`),
          asObjects: z.boolean().optional().describe('Return rows as header-keyed objects instead of arrays.'),
        }),
        execute: async ({ filePath, sheet, maxRows, asObjects }) => {
          const bytes = await this.requireRuntimeFileBytes(filePath);
          const result = await readXlsx(bytes, { sheet, maxRows, asObjects });
          return { ok: true, filePath: sanitizeRelativePath(filePath), ...result };
        },
      }),
      write_xlsx: tool({
        description: [
          'Build an .xlsx workbook from sheets of array-rows and write it as a durable workspace file.',
          'Codemode-only: call as codemode.write_xlsx({ filePath, sheets }).',
          'Each sheet is { name, rows } where rows is an array of arrays (first row is usually the header).',
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string().describe('Workspace-relative path to write (should end in .xlsx).'),
          sheets: z.array(z.object({
            name: z.string(),
            rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
          })).min(1),
        }),
        execute: async ({ filePath, sheets }) => {
          const bytes = buildXlsx(sheets as { name: string; rows: XlsxCell[][] }[]);
          const relativePath = await this.writeRuntimeFileBytes(filePath, bytes);
          return { ok: true, filePath: relativePath, bytes: bytes.byteLength, sheets: sheets.length };
        },
      }),
      write_docx: tool({
        description: [
          'Build a Word .docx from a declarative content schema and write it as a durable workspace file.',
          'Codemode-only: call as codemode.write_docx({ filePath, content }).',
          'content is an array of blocks: {type:"heading",level,text} | {type:"paragraph",text,bold?,italic?} | {type:"list",ordered?,items} | {type:"table",rows}.',
          'You never touch the docx library directly — describe the document with these blocks.',
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string().describe('Workspace-relative path to write (should end in .docx).'),
          content: z.array(z.union([
            z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6).optional(), text: z.string() }),
            z.object({ type: z.literal('paragraph'), text: z.string(), bold: z.boolean().optional(), italic: z.boolean().optional() }),
            z.object({ type: z.literal('list'), ordered: z.boolean().optional(), items: z.array(z.string()) }),
            z.object({ type: z.literal('table'), rows: z.array(z.array(z.string())) }),
          ])).min(1),
        }),
        execute: async ({ filePath, content }) => {
          const bytes = await buildDocx(content as DocxBlock[]);
          const relativePath = await this.writeRuntimeFileBytes(filePath, bytes);
          return { ok: true, filePath: relativePath, bytes: bytes.byteLength, blocks: content.length };
        },
      }),
      ui_markdown: tool({
        description: [
          'Create or update a concise markdown panel on the canvas.',
          `Keep inline markdown under ${MAX_INLINE_MARKDOWN_CHARS} characters.`,
          'Use file-backed panels for durable long-form documents.',
        ].join(' '),
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          content: z.string().max(MAX_INLINE_MARKDOWN_CHARS),
        }),
        strict: true,
        execute: async ({ id, title, content }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: 'markdown',
            title,
            content,
          });
          return { ok: true, panelId };
        },
      }),
      ui_detail: tool({
        description: 'Create or update a detail panel linked to another panel, usually a table.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          linkedTo: z.string(),
        }),
        execute: async ({ id, title, linkedTo }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: 'detail',
            title,
            linkedTo,
          });
          return { ok: true, panelId };
        },
      }),
      ui_table: tool({
        description: 'Create or update a table panel on the canvas as a structured view over concise data.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          columns: z.array(z.object({ key: z.string(), label: z.string() })),
          rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
        }),
        execute: async ({ id, title, columns, rows }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: 'table',
            title,
            columns,
            rows,
          });
          return { ok: true, panelId };
        },
      }),
      ui_chart: tool({
        description: 'Create or update a chart panel on the canvas as a structured view over concise data.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          chartType: z.enum(['bar', 'line', 'pie', 'area']),
          data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
        }),
        execute: async ({ id, title, chartType, data }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: 'chart',
            title,
            chartType,
            data,
          });
          return { ok: true, panelId };
        },
      }),
      ui_cards: tool({
        description: 'Create or update a cards panel on the canvas for concise derived summaries.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          items: z.array(z.object({
            id: z.string().optional(),
            title: z.string(),
            subtitle: z.string().optional(),
            description: z.string().optional(),
            badge: z.string().optional(),
            metadata: z.record(z.string(), z.string()).optional(),
          })),
        }),
        execute: async ({ id, title, items }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: 'cards',
            title,
            items,
          });
          return { ok: true, panelId };
        },
      }),
      ui_show_file: tool({
        description: 'Add a file-backed panel to the canvas. Use this after writing durable files such as HTML, JS apps, SVG, markdown, CSV, images, or PDFs.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string().optional(),
          filePath: z.string(),
        }),
        execute: async ({ id, title, filePath }) => {
          const file = await this.readRuntimeFileContent(filePath);
          if (file === null) {
            throw new Error(`File not found: ${filePath}`);
          }
          const panelId = id || crypto.randomUUID();
          this.upsertPanel({
            id: panelId,
            type: inferFilePanelType(filePath),
            title: title || filePath.split('/').pop() || filePath,
            filePath,
          });
          return { ok: true, panelId };
        },
      }),
      ui_download: tool({
        description: 'Queue a client-side download for the user as txt, csv, or json.',
        inputSchema: z.object({
          filename: z.string().min(1),
          format: z.enum(['csv', 'json', 'txt']),
          data: z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.null(),
            z.array(z.unknown()),
            z.record(z.string(), z.unknown()),
          ]),
        }),
        execute: async ({ filename, format, data }) => {
          await addWorkspaceDownload(this.env, sessionId, workspace.id, {
            filename,
            format,
            data,
          });
          return { ok: true, filename, format };
        },
      }),
      ui_workspace: tool({
        description: 'Update the workspace title or description.',
        inputSchema: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
        }),
        execute: async ({ name, description }) => {
          const nextWorkspace = {
            ...workspace,
            name: name ?? workspace.name,
            description: description ?? workspace.description,
            updatedAt: new Date().toISOString(),
          };
          await putWorkspace(this.env, sessionId, nextWorkspace);
          await this.syncWorkspace(nextWorkspace, sessionId);
          return nextWorkspace;
        },
      }),
    };

    if (scopedPanels.length > 0) {
      return {
        ...tools,
        read_scoped_panels: tool({
          description: 'Inspect the full data for the tiles currently in scope for this chat turn.',
          inputSchema: z.object({}),
          execute: async () => Promise.all(
            scopedPanels.map(async (panel) => {
              const payload = serializePanelForContext(panel, this.state.panels);
              if (panel.type === 'fileTree') {
                return {
                  ...payload,
                  files: await this.listRuntimeFiles(),
                };
              }
              return payload;
            })
          ),
        }),
      };
    }

    return tools;
  }

  private buildModelTools(tools: ReturnType<WorkspaceAgent['buildHostTools']>) {
    const {
      web_fetch: _webFetch,
      // Document tools are codemode-only: bulk extracted content must flow
      // through sandbox code, not directly into model tool-result context.
      parse_pdf: _parsePdf,
      read_xlsx: _readXlsx,
      write_xlsx: _writeXlsx,
      write_docx: _writeDocx,
      ...modelTools
    } = tools;

    return modelTools;
  }

  private getRuntimeWorkspace(): RuntimeWorkspace {
    if (!this.runtimeWorkspace) {
      this.runtimeWorkspace = new RuntimeWorkspace({
        sql: this.ctx.storage.sql,
        r2: this.env.WORKSPACE_FILES,
        r2Prefix: `${RUNTIME_R2_PREFIX}/${this.name}`,
        name: () => this.name,
      });
    }
    return this.runtimeWorkspace;
  }

  private async ensureRuntimeWorkspaceHydrated(workspace: WorkspaceRecord, sessionId: string): Promise<void> {
    if (this.hydrationComplete) return;
    if (await this.ctx.storage.get(HYDRATION_COMPLETE_KEY)) {
      this.hydrationComplete = true;
      return;
    }
    if (this.hydrationPromise) {
      await this.hydrationPromise;
      return;
    }
    const runtime = this.getRuntimeWorkspace();
    this.hydrationPromise = (async () => {
      await hydrateLegacyWorkspaceFiles(this.env, sessionId, workspace.id, runtime);
      await this.ctx.storage.put(HYDRATION_COMPLETE_KEY, true);
      this.hydrationComplete = true;
    })();
    try {
      await this.hydrationPromise;
    } finally {
      this.hydrationPromise = null;
    }
  }

  private async listRuntimeFiles(): Promise<Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    uploadedAt?: string;
    modifiedAt?: string;
    etag?: string;
  }>> {
    const runtime = this.getRuntimeWorkspace();
    const paths = await runtime._getAllPaths();
    const entries = await Promise.all(paths.map(async (path) => {
      const stat = await runtime.lstat(path);
      if (!stat) return null;
      if (stat.type !== 'file' && stat.type !== 'directory') return null;
      const relativePath = fromRuntimePath(stat.path);
      if (!relativePath) return null;
      return {
        name: relativePath.split('/').pop() || relativePath,
        path: relativePath,
        isDirectory: stat.type === 'directory',
        size: stat.type === 'file' ? stat.size : undefined,
        uploadedAt: new Date(stat.updatedAt).toISOString(),
        modifiedAt: new Date(stat.updatedAt).toISOString(),
      };
    }));

    return entries
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.path.localeCompare(right.path);
      });
  }

  private async readRuntimeFileContent(filePath: string): Promise<{
    filePath: string;
    contentType: string;
    data: ArrayBuffer;
  } | null> {
    const runtime = this.getRuntimeWorkspace();
    const relativePath = sanitizeRelativePath(filePath);
    const stat = await runtime.stat(toRuntimePath(relativePath));
    if (!stat || stat.type !== 'file') {
      return null;
    }

    const data = await runtime.readFileBytes(toRuntimePath(relativePath));
    if (!data) {
      return null;
    }

    return {
      filePath: relativePath,
      contentType: stat.mimeType || getMimeType(relativePath),
      data: toArrayBuffer(data),
    };
  }

  /** Read a workspace file as raw bytes, throwing if it does not exist. */
  private async requireRuntimeFileBytes(filePath: string): Promise<Uint8Array> {
    const runtime = this.getRuntimeWorkspace();
    const relativePath = sanitizeRelativePath(filePath);
    const data = await runtime.readFileBytes(toRuntimePath(relativePath));
    if (!data) {
      throw new Error(`File not found: ${filePath}`);
    }
    return data;
  }

  /** Write raw bytes to a durable workspace file, returning the relative path. */
  private async writeRuntimeFileBytes(filePath: string, bytes: Uint8Array): Promise<string> {
    const runtime = this.getRuntimeWorkspace();
    const relativePath = sanitizeRelativePath(filePath);
    await runtime.writeFileBytes(toRuntimePath(relativePath), bytes, getMimeType(relativePath));
    return relativePath;
  }

  private requireWorkspace(): WorkspaceRecord {
    if (!this.state.workspace) {
      throw new Error('Workspace is not initialized');
    }
    return this.state.workspace;
  }

  private requireSessionId(): string {
    if (!this.state.sessionId) {
      throw new Error('Workspace session is not initialized');
    }
    return this.state.sessionId;
  }

  private assertNotFrozen(): void {
    if (this.migrationFrozen) {
      throw new Error('workspace is frozen for migration');
    }
  }

  private upsertPanel(panel: WorkspacePanel): void {
    const index = this.state.panels.findIndex((candidate) => candidate.id === panel.id);
    const panels = [...this.state.panels];
    if (index >= 0) {
      const current = panels[index];
      const preserved = {
        layout: panel.layout ? { ...current.layout, ...panel.layout } : current.layout,
        sourcePanelId: panel.sourcePanelId ?? current.sourcePanelId,
      };
      panels[index] = current.type === panel.type
        ? { ...current, ...panel, ...preserved } as WorkspacePanel
        : { ...panel, ...preserved } as WorkspacePanel;
    } else {
      panels.push(panel);
    }
    this.setState({ ...this.state, panels });
  }
}
