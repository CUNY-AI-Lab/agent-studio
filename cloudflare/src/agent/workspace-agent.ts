import {
  AIChatAgent,
  type OnChatMessageOptions,
} from '@cloudflare/ai-chat';
import { callable, type Connection, type ConnectionContext } from 'agents';
import { DynamicWorkerExecutor, type ExecuteResult } from '@cloudflare/codemode';
import {
  createCodeTool,
  resolveProvider,
  aiTools,
  type CodeOutput,
} from '@cloudflare/codemode/ai';
import { Workspace as RuntimeWorkspace } from '@cloudflare/shell';
import { gitTools } from '@cloudflare/shell/git';
import { stateTools } from '@cloudflare/shell/workers';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from 'ai';
import {
  createCailAuthError,
  serializeCailAuthError,
} from '@cuny-ai-lab/cail-identity';
import { z } from 'zod';
import {
  DEFAULT_WORKSPACE_STATE,
  type LayoutPatch,
  type WorkspacePanel,
  type WorkspaceRecord,
  type WorkspaceState,
} from '../domain/workspace';
import type { Env } from '../env';
import { createCailModel } from '../lib/cail-model';
import {
  isCailIdentityConfigError,
  verifyGatewayCredentialForSession,
} from '../lib/cail-identity';
import { panelSchema } from '../lib/import';
import {
  connectionEndpointKey,
  makePanelConnection,
  normalizePanelRelations,
} from '../lib/panel-connections';
import { layoutPatchSchema, panelIdSchema, runtimeCodeSchema } from '../lib/workspace-validation';
import { canonicalError } from '../lib/error-envelope';
import { guardedWebFetch } from '../lib/web-fetch-guard';
import {
  extractPdfText,
  readXlsx,
  buildXlsx,
  buildDocx,
  MAX_PDF_PAGES,
  MAX_XLSX_ROWS,
} from '../lib/document-tools';
import { getSkillContent, SKILLS } from '../skills';
import { buildWorkspaceAgentSystemPrompt } from './instructions';
import {
  getMimeType,
  sanitizeRelativePath,
  toRuntimePath,
} from '../lib/files';
import { addWorkspaceDownload } from '../lib/downloads';
import { updateWorkspaceWithRetry } from '../lib/workspaces';
import { verifyCsrfToken, wsOriginAllowed } from '../lib/csrf';
import { assertClientStateIdentity } from '../lib/agent-state-guard';
import { guardGitToken, parseGitAllowedHosts } from '../lib/git-guard';
import {
  extractCanonicalCailError,
  quotaSignalFromError,
} from '../lib/quota-error';
import { checkHeavyRpcLimit } from '../lib/rate-limit';

const RUNTIME_R2_PREFIX = 'agent-studio/runtime';
const MIGRATION_FROZEN_KEY = 'migrationFrozen:v1';
const MIGRATION_STABILITY_TIMEOUT_MS = 5_000;
// Keep a finite stop for the AI SDK tool loop so a malformed or non-terminating
// tool plan cannot spend indefinitely. This is a loop safety boundary, not an
// output/token cap.
const MODEL_TOOL_LOOP_STEPS = 12;

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

interface SerializedPanelContextBase {
  id: string;
  title?: string;
  sourcePanelId?: string;
  layout?: WorkspacePanel['layout'];
}

type TablePanel = Extract<WorkspacePanel, { type: 'table' }>;
type CardsPanel = Extract<WorkspacePanel, { type: 'cards' }>;

type SerializedPanelContext =
  | (SerializedPanelContextBase & { type: 'chat' })
  | (SerializedPanelContextBase & { type: 'markdown'; content: string })
  | (SerializedPanelContextBase & {
    type: 'table';
    columns: TablePanel['columns'];
    rows: TablePanel['rows'];
  })
  | (SerializedPanelContextBase & {
    type: 'chart';
    chartType: 'bar' | 'line' | 'pie' | 'area';
    data: Array<Record<string, string | number | boolean | null>>;
  })
  | (SerializedPanelContextBase & { type: 'cards'; items: CardsPanel['items'] })
  | (SerializedPanelContextBase & { type: 'preview'; filePath?: string; content?: string })
  | (SerializedPanelContextBase & { type: 'pdf' | 'editor' | 'file'; filePath: string })
  | (SerializedPanelContextBase & { type: 'fileTree'; kind: 'workspace-files' })
  | (SerializedPanelContextBase & {
    type: 'detail';
    linkedTo?: string;
    linkedPanel: SerializedPanelContext | null;
  });

function serializePanelForContext(panel: WorkspacePanel, allPanels: WorkspacePanel[]): SerializedPanelContext {
  const base = {
    id: panel.id,
    title: panel.title,
    sourcePanelId: panel.sourcePanelId,
    layout: panel.layout,
  };

  switch (panel.type) {
    case 'markdown':
      return {
        ...base,
        type: 'markdown',
        content: panel.content,
      };
    case 'table':
      return {
        ...base,
        type: 'table',
        columns: panel.columns,
        rows: panel.rows,
      };
    case 'chart':
      return {
        ...base,
        type: 'chart',
        chartType: panel.chartType,
        data: panel.data,
      };
    case 'cards':
      return {
        ...base,
        type: 'cards',
        items: panel.items,
      };
    case 'preview':
      return {
        ...base,
        type: 'preview',
        filePath: panel.filePath,
        content: panel.content,
      };
    case 'pdf':
    case 'editor':
    case 'file':
      return {
        ...base,
        type: panel.type,
        filePath: panel.filePath,
      };
    case 'fileTree':
      return {
        ...base,
        type: 'fileTree',
        kind: 'workspace-files',
      };
    case 'detail': {
      const linkedPanel = panel.linkedTo
        ? allPanels.find((candidate) => candidate.id === panel.linkedTo)
        : null;
      return {
        ...base,
        type: 'detail',
        linkedTo: panel.linkedTo,
        linkedPanel: linkedPanel ? serializePanelForContext(linkedPanel, allPanels) : null,
      };
    }
    case 'chat':
      return { ...base, type: 'chat' };
  }
}

const CAIL_CREDENTIAL_STORAGE_KEY = 'cail:identity-jwt';

type CurrentGatewayCredentialCheck =
  | { status: 'valid' | 'missing' | 'invalid' }
  | { status: 'config' };

export class WorkspaceAgent extends AIChatAgent<Env, WorkspaceState> {
  initialState: WorkspaceState = DEFAULT_WORKSPACE_STATE;
  private runtimeWorkspace?: RuntimeWorkspace;
  private migrationFrozen = false;
  private activeMutations = 0;
  /**
   * The caller's selected verified identity JWT, forwarded to the model proxy as
   * the model-call credential. Set server-side (never over the client WebSocket,
   * which cannot carry the gateway-injected header) via setCailCredential, and
   * kept in DO storage so it survives hibernation. Never broadcast in state.
   */
  private cailIdentityJwt: string | null = null;
  private cailSubject: string | null = null;

  async onStart() {
    if (!this.state.workspace) {
      this.setState(DEFAULT_WORKSPACE_STATE);
    }
    const normalizedRelations = normalizePanelRelations(this.state.panels, this.state.connections);
    this.setState({ ...this.state, ...normalizedRelations });
    if (this.cailIdentityJwt === null) {
      const stored = await this.ctx.storage.get<string>(CAIL_CREDENTIAL_STORAGE_KEY);
      if (stored) {
        const expectedSessionId = this.csrfSessionId();
        if (expectedSessionId) {
          // Re-verify credentials restored after hibernation/eviction. This
          // also prevents a pre-F04 app-audience token from being revived by
          // the new code after it was persisted by an older deployment.
          const identity = await verifyGatewayCredentialForSession(
            stored,
            expectedSessionId,
            this.env,
          );
          if (!isCailIdentityConfigError(identity) && identity) {
            this.cailIdentityJwt = stored;
            this.cailSubject = identity.subject;
          } else if (!isCailIdentityConfigError(identity)) {
            // Invalid, expired, wrong-audience, or cross-session credentials
            // must never remain available to a later model call. A config
            // error is retained for a later retry after operator repair.
            await this.ctx.storage.delete(CAIL_CREDENTIAL_STORAGE_KEY);
          }
        }
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

  private async csrfTokenMatches(candidate: string | null): Promise<boolean> {
    const sessionId = this.csrfSessionId();
    if (!sessionId) return false;
    const principalKind = this.env.CAIL_REQUIRE_IDENTITY === 'true'
      ? 'subject'
      : candidate?.split('.')[1] === 'subject' ? 'subject' : 'anonymous';
    return Boolean(await verifyCsrfToken(
      candidate,
      sessionId,
      this.env.SESSION_SECRET,
      principalKind,
    ));
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
    if (this.migrationFrozen) {
      connection.close(1012, 'migration_in_progress');
      return;
    }
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
    this.assertAuthorizedRpc();
    assertClientStateIdentity(this.name, nextState);
    // The browser has bounded callable methods for every supported mutation.
    // Accepting the Agents SDK's generic full-state replacement would bypass
    // those schemas, migration/deletion freezes, and layout merge semantics.
    throw new Error('client state replacement is disabled; use callable mutations');
  }

  /**
   * Store the caller's identity JWT for use as the model-proxy credential.
   *
   * This internal server-to-DO RPC is deliberately not @callable. It still
   * treats its argument as untrusted: it re-verifies the token through the
   * same CAIL verifier the HTTP middleware uses (RS256/JWKS + all claims) and
   * binds the verified subject to this DO's session id. A garbage/expired
   * token, or a valid token belonging to a different subject, is rejected.
   *
   * The legitimate path (server.ts primeAgentCredential, after HTTP identity
   * verification) still succeeds: that token is valid and its subject maps to
   * exactly this DO's session id.
   *
   * A null token is ignored so an anonymous read never clears a live credential
   * mid-session.
   */
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
    const identity = await verifyGatewayCredentialForSession(
      identityJwt,
      expectedSessionId,
      this.env,
    );
    if (isCailIdentityConfigError(identity)) {
      throw new Error('setCailCredential: identity verification config could not be loaded');
    }
    if (!identity) {
      throw new Error('setCailCredential: rejected unverified or non-matching identity JWT');
    }

    this.cailIdentityJwt = identityJwt;
    this.cailSubject = identity.subject;
    await this.ctx.storage.put(CAIL_CREDENTIAL_STORAGE_KEY, identityJwt);
  }

  /**
   * Re-verify the in-memory Gateway leg before a warm WebSocket starts a model
   * turn. Durable Object memory can outlive a short-lived JWT, so installation
   * time verification alone is not enough. Invalid or expired credentials are
   * removed from memory and storage; an unavailable verifier is kept for the
   * operator to repair and is reported separately to the chat boundary.
   */
  protected async verifyCurrentGatewayCredential(
    expectedSessionId: string,
  ): Promise<CurrentGatewayCredentialCheck> {
    const token = this.cailIdentityJwt;
    if (!token) return { status: 'missing' };

    // Pass the current clock explicitly so a warm DO never reuses an
    // installation-time validity decision. The shared verifier still owns all
    // JWT signature, issuer, audience, subject, exp, and nbf checks.
    const identity = await verifyGatewayCredentialForSession(
      token,
      expectedSessionId,
      this.env,
      Math.floor(Date.now() / 1000),
    );
    if (isCailIdentityConfigError(identity)) {
      return { status: 'config' };
    }
    if (!identity) {
      this.cailIdentityJwt = null;
      this.cailSubject = null;
      await this.ctx.storage.delete(CAIL_CREDENTIAL_STORAGE_KEY);
      return { status: 'invalid' };
    }

    // Keep the in-memory derived fields tied to the claims just verified. The
    // token itself is unchanged, so the persisted credential remains intact.
    this.cailSubject = identity.subject;
    return { status: 'valid' };
  }

  async syncWorkspace(workspace: WorkspaceRecord, sessionId: string): Promise<void> {
    this.assertNotFrozen();
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

  async freezeForMigration(): Promise<void> {
    let failure: unknown;
    let failed = false;
    // blockConcurrencyWhile queues later Durable Object events, including
    // WebSocket tool-result/approval frames. waitUntilStable therefore drains
    // only already-delivered turns/interactions; a frame needed after this
    // admission waits behind the block and makes the freeze time out/retry.
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const stable = await this.waitUntilStable({ timeout: MIGRATION_STABILITY_TIMEOUT_MS });
        if (!stable) {
          throw new Error('workspace did not become stable before migration freeze');
        }
        if (this.activeMutations > 0) {
          throw new Error('workspace has an active mutation; retry migration');
        }
        this.migrationFrozen = true;
        await this.ctx.storage.put(MIGRATION_FROZEN_KEY, true);
      } catch (error) {
        // Durable Object state resets if blockConcurrencyWhile's callback
        // throws. Capture the failure and throw only after the block exits.
        this.migrationFrozen = false;
        failure = error;
        failed = true;
      }
    });
    if (failed) {
      throw failure instanceof Error
        ? failure
        : new Error('workspace migration freeze failed', { cause: failure });
    }
  }

  async unfreezeAfterMigration(): Promise<void> {
    await this.ctx.storage.delete(MIGRATION_FROZEN_KEY);
    this.migrationFrozen = false;
  }

  /** Internal destructive RPC used only after an authorized delete/migration. */
  async destroyWorkspaceState(): Promise<void> {
    if (this.activeMutations > 0) {
      throw new Error('workspace has an active mutation; retry destructive cleanup');
    }
    if (!this.migrationFrozen) {
      await this.freezeForMigration();
    }
    await this.clearRuntimeFilesUnchecked();
    this.cailIdentityJwt = null;
    this.cailSubject = null;
    this.messages = [];
    for (const table of [
      'cf_ai_chat_agent_messages',
      'cf_ai_chat_request_context',
      'cf_ai_chat_agent_tool_runs',
      'cf_ai_chat_agent_tool_milestones',
    ]) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    // `destroy()` aborts the Durable Object isolate after clearing storage.
    // This method is reached through an RPC during workspace deletion, so an
    // inline abort turns a successful cleanup into a 500 at the caller. The
    // Agents SDK's deferred primitive persists a destruction marker and lets
    // the next alarm perform the abort in its own invocation.
    await this._cf_scheduleDestroy();
  }

  async replaceWorkspaceState(state: WorkspaceState, workspace: WorkspaceRecord, sessionId: string): Promise<void> {
    const panels = state.panels.length > 0 ? state.panels : DEFAULT_WORKSPACE_STATE.panels;
    const normalizedRelations = normalizePanelRelations(panels, state.connections || []);
    this.setState({
      ...state,
      sessionId,
      workspace,
      ...normalizedRelations,
      viewport: state.viewport || DEFAULT_WORKSPACE_STATE.viewport,
      groups: state.groups || [],
    });
  }

  protected override resetTurnState(): void {
    this.assertNotFrozen();
    super.resetTurnState();
  }

  async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds?: string[],
    options?: { _deleteStaleRows?: boolean },
  ): Promise<void> {
    this.assertNotFrozen();
    this.activeMutations += 1;
    try {
      await super.persistMessages(messages, excludeBroadcastIds, options);
    } finally {
      this.activeMutations -= 1;
    }
  }

  async onChatMessage(
    _onFinish?: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ) {
    this.assertNotFrozen();
    const workspace = this.requireWorkspace();
    const sessionId = this.requireSessionId();

    const credentialCheck = await this.verifyCurrentGatewayCredential(sessionId);
    const identityJwt = this.cailIdentityJwt;
    if (credentialCheck.status !== 'valid' || !identityJwt) {
      const errorText = serializeCailAuthError(
        createCailAuthError('authentication_required', 'Sign in to continue.', '/agent-studio'),
      );
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => writer.write({ type: 'error', errorText }),
        }),
      });
    }

    if (!(await checkHeavyRpcLimit(this.env, sessionId))) {
      const errorText = JSON.stringify(canonicalError(
        'rate_limited',
        'Too many agent turns — try again shortly.',
        { type: 'rate_limit_error', retryable: true },
      ));
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => writer.write({ type: 'error', errorText }),
        }),
      });
    }

    try {
      const scopedPanelIds = z.array(z.string()).safeParse(options?.body?.scopePanelIds).data ?? [];
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
      const model = createCailModel({
        env: this.env,
        identityJwt,
        model: workspace.model,
      });

      const result = streamText({
        model,
        // The gateway does not yet deduplicate model execution. A retry after
        // an uncertain response could run and bill the same turn twice.
        maxRetries: 0,
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
        stopWhen: stepCountIs(MODEL_TOOL_LOOP_STEPS),
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          const errorCandidate = error instanceof Error ? error : null;
          const cail = extractCanonicalCailError(errorCandidate);
          const quota = quotaSignalFromError(errorCandidate, cail);
          return quota ?? 'Agent Studio hit an internal error while streaming this response.';
        },
      });
    } catch {
      const errorText = JSON.stringify(canonicalError(
        'internal_error',
        'Agent Studio could not start this response.',
        { type: 'api_error', retryable: true },
      ));
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => writer.write({ type: 'error', errorText }),
        }),
      });
    }
  }

  async getSnapshot(): Promise<WorkspaceState> {
    return this.state;
  }

  async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }

  async getRuntimeInfo(): Promise<{
    provider: 'dynamic-workers';
    codemode: true;
    git: true;
    outbound: 'tool-only';
  }> {
    return {
      provider: 'dynamic-workers',
      codemode: true,
      git: true,
      outbound: 'tool-only',
    };
  }

  @callable()
  async executeCode(code: string): Promise<ExecuteResult> {
    return this.withMutationFence(() => this.executeCodeFenced(code));
  }

  private async executeCodeFenced(code: string): Promise<ExecuteResult> {
    this.assertAuthorizedRpc();
    code = runtimeCodeSchema.parse(code);
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

  async readWorkspaceFileContent(filePath: string): Promise<{
    filePath: string;
    contentType: string;
    data: ArrayBuffer;
  } | null> {
    return this.readRuntimeFileContent(filePath);
  }

  async writeWorkspaceFileContent(
    filePath: string,
    data: string | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<{ ok: true; filePath: string }> {
    return this.withMutationFence(async () => {
      const runtime = this.getRuntimeWorkspace();
      const relativePath = sanitizeRelativePath(filePath);
      const textData = z.string().safeParse(data).data;
      if (textData !== undefined) {
        await runtime.writeFile(toRuntimePath(relativePath), textData, contentType || getMimeType(relativePath));
      } else {
        const binaryData = z.union([
          z.instanceof(ArrayBuffer),
          z.instanceof(Uint8Array),
        ]).parse(data);
        await runtime.writeFileBytes(toRuntimePath(relativePath), binaryData, contentType || getMimeType(relativePath));
      }
      return { ok: true, filePath: relativePath };
    });
  }

  async deleteWorkspaceFileContent(filePath: string): Promise<{ ok: true; filePath: string }> {
    return this.withMutationFence(async () => {
      const runtime = this.getRuntimeWorkspace();
      const relativePath = sanitizeRelativePath(filePath);
      await runtime.rm(toRuntimePath(relativePath), { force: true });
      return { ok: true, filePath: relativePath };
    });
  }

  async clearWorkspaceFiles(): Promise<void> {
    await this.withMutationFence(() => this.clearRuntimeFilesUnchecked());
  }

  private async clearRuntimeFilesUnchecked(): Promise<void> {
    const runtime = this.getRuntimeWorkspace();
    const paths = (await runtime._getAllPaths()).filter((path) => path !== '/' && path !== '');
    for (const path of [...paths].sort((left, right) => right.length - left.length)) {
      await runtime.rm(path, { recursive: true, force: true });
    }
  }

  @callable()
  async addPanel(panel: WorkspacePanel): Promise<WorkspaceState> {
    this.assertNotFrozen();
    this.assertAuthorizedRpc();
    const parsedPanel = panelSchema.parse(panel);
    this.upsertPanelWithAssociation(parsedPanel, parsedPanel.sourcePanelId);
    return this.state;
  }

  @callable()
  async removePanel(panelId: string): Promise<WorkspaceState> {
    this.assertNotFrozen();
    this.assertAuthorizedRpc();
    panelId = panelIdSchema.parse(panelId);
    const panels = this.state.panels.filter((panel) => panel.id !== panelId);
    const connections = this.state.connections.filter(
      (connection) => connection.sourceId !== panelId && connection.targetId !== panelId,
    );
    const normalizedRelations = normalizePanelRelations(panels, connections);
    this.setState({
      ...this.state,
      ...normalizedRelations,
      groups: this.state.groups
        .map((group) => ({ ...group, panelIds: group.panelIds.filter((id) => id !== panelId) }))
        .filter((group) => group.panelIds.length >= 2),
    });
    return this.state;
  }

  @callable()
  async applyLayoutPatch(patch: LayoutPatch): Promise<WorkspaceState> {
    this.assertNotFrozen();
    this.assertAuthorizedRpc();
    const parsedPatch = layoutPatchSchema.parse(patch);
    const panels = this.state.panels.map((panel) => {
      const nextLayout = parsedPatch.panels?.[panel.id];
      if (!nextLayout) return panel;
      const layout = { ...panel.layout };
      if (nextLayout.x !== undefined) layout.x = clamp(nextLayout.x, 0, 100000);
      if (nextLayout.y !== undefined) layout.y = clamp(nextLayout.y, 0, 100000);
      if (nextLayout.width !== undefined) layout.width = clamp(nextLayout.width, 100, 10000);
      if (nextLayout.height !== undefined) layout.height = clamp(nextLayout.height, 60, 10000);
      return {
        ...panel,
        layout,
      };
    });

    // Connections and groups merge per id, like panels (V3): a patch upserts
    // only the entries it names and never implicitly deletes the rest, so a
    // stale client snapshot can't erase a concurrent server-side change (e.g.
    // removePanel filtering connections, or another tab's group edit).
    // Deletions are explicit: groups via patch.removeGroups and connections via
    // patch.removeConnections (removePanel also filters references). Merged
    // entries referencing panels that no longer exist are dropped, so a stale
    // patch can't resurrect a removed panel's connections or group membership.
    const panelIds = new Set(panels.map((panel) => panel.id));

    const connectionsById = new Map(this.state.connections.map((connection) => [connection.id, connection]));
    for (const connection of parsedPatch.connections ?? []) {
      connectionsById.set(connection.id, connection);
    }
    for (const connectionId of parsedPatch.removeConnections ?? []) {
      connectionsById.delete(connectionId);
    }
    const connections = [...connectionsById.values()].filter(
      (connection) => panelIds.has(connection.sourceId) && panelIds.has(connection.targetId)
    );
    const normalizedRelations = normalizePanelRelations(panels, connections);

    const groupsById = new Map(this.state.groups.map((group) => [group.id, group]));
    for (const group of parsedPatch.groups ?? []) {
      groupsById.set(group.id, group);
    }
    for (const groupId of parsedPatch.removeGroups ?? []) {
      groupsById.delete(groupId);
    }
    const groups = [...groupsById.values()]
      .map((group) => ({ ...group, panelIds: group.panelIds.filter((panelId) => panelIds.has(panelId)) }))
      .filter((group) => group.panelIds.length >= 2);

    this.setState({
      ...this.state,
      ...normalizedRelations,
      groups,
      viewport: parsedPatch.viewport ?? this.state.viewport,
    });
    return this.state;
  }

  private createCodeExecutor(): DynamicWorkerExecutor {
    return new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      globalOutbound: null,
    });
  }

  private createCodeModeTool(tools: ReturnType<WorkspaceAgent['buildHostTools']>) {
    const codeModeTools = this.buildCodeModeHostTools(tools);
    const codemode = createCodeTool({
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

    // `state.*` and `git.*` providers can mutate the Durable Object's runtime
    // workspace from inside the sandbox. Hold the same fence used by direct
    // mutation RPCs across the entire sandbox run so migration cleanup cannot
    // interleave with a code-mode write at an async boundary.
    const execute = codemode.execute;
    if (!execute) {
      throw new Error('codemode tool is missing its executor');
    }
    codemode.execute = (input, options) => this.withMutationFence(async () => {
      const output = await execute(input, options);
      // SAFETY: createCodeTool's concrete executor always returns CodeOutput;
      // the AI SDK Tool type also permits streaming results for other tools.
      return output as CodeOutput;
    });
    return codemode;
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
          'Use mode="append" when adding to an existing file.',
        ].join(' '),
        inputSchema: z.object({
          filePath: z.string(),
          content: z.string(),
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
          const bytes = buildXlsx(sheets);
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
          const bytes = await buildDocx(content);
          const relativePath = await this.writeRuntimeFileBytes(filePath, bytes);
          return { ok: true, filePath: relativePath, bytes: bytes.byteLength, blocks: content.length };
        },
      }),
      ui_markdown: tool({
        description: [
          'Create or update a concise markdown panel on the canvas.',
          'Use file-backed panels for durable long-form documents.',
          'When sourcePanelId is provided, it is an explicit persisted association to that existing tile.',
        ].join(' '),
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          content: z.string(),
          sourcePanelId: z.string().optional().describe('Existing tile id to associate explicitly with this tile.'),
        }),
        strict: true,
        execute: async ({ id, title, content, sourcePanelId }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: 'markdown',
            title,
            content,
          }, sourcePanelId);
          return { ok: true, panelId };
        },
      }),
      ui_detail: tool({
        description: 'Create or update a detail panel linked to another panel, usually a table. The linkedTo relationship is persisted as a visible tile association.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          linkedTo: z.string(),
        }),
        execute: async ({ id, title, linkedTo }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: 'detail',
            title,
            linkedTo,
          }, linkedTo);
          return { ok: true, panelId };
        },
      }),
      ui_table: tool({
        description: 'Create or update a table panel on the canvas as a structured view over concise data. When sourcePanelId is provided, it is an explicit persisted association to that existing tile.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          columns: z.array(z.object({ key: z.string(), label: z.string() })),
          rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
          sourcePanelId: z.string().optional().describe('Existing tile id to associate explicitly with this tile.'),
        }),
        execute: async ({ id, title, columns, rows, sourcePanelId }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: 'table',
            title,
            columns,
            rows,
          }, sourcePanelId);
          return { ok: true, panelId };
        },
      }),
      ui_chart: tool({
        description: 'Create or update a chart panel on the canvas as a structured view over concise data. When sourcePanelId is provided, it is an explicit persisted association to that existing tile.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string(),
          chartType: z.enum(['bar', 'line', 'pie', 'area']),
          data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
          sourcePanelId: z.string().optional().describe('Existing tile id to associate explicitly with this tile.'),
        }),
        execute: async ({ id, title, chartType, data, sourcePanelId }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: 'chart',
            title,
            chartType,
            data,
          }, sourcePanelId);
          return { ok: true, panelId };
        },
      }),
      ui_cards: tool({
        description: 'Create or update a cards panel on the canvas for concise derived summaries. When sourcePanelId is provided, it is an explicit persisted association to that existing tile.',
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
          sourcePanelId: z.string().optional().describe('Existing tile id to associate explicitly with this tile.'),
        }),
        execute: async ({ id, title, items, sourcePanelId }) => {
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: 'cards',
            title,
            items,
          }, sourcePanelId);
          return { ok: true, panelId };
        },
      }),
      ui_show_file: tool({
        description: 'Add a file-backed panel to the canvas. Use this after writing durable files such as HTML, JS apps, SVG, markdown, CSV, images, or PDFs. When sourcePanelId is provided, it is an explicit persisted association to that existing tile.',
        inputSchema: z.object({
          id: z.string().optional(),
          title: z.string().optional(),
          filePath: z.string(),
          sourcePanelId: z.string().optional().describe('Existing tile id to associate explicitly with this tile.'),
        }),
        execute: async ({ id, title, filePath, sourcePanelId }) => {
          const file = await this.readRuntimeFileContent(filePath);
          if (file === null) {
            throw new Error(`File not found: ${filePath}`);
          }
          const panelId = id || crypto.randomUUID();
          this.upsertPanelWithAssociation({
            id: panelId,
            type: inferFilePanelType(filePath),
            title: title || filePath.split('/').pop() || filePath,
            filePath,
          }, sourcePanelId);
          return { ok: true, panelId };
        },
      }),
      ui_download: tool({
        description: 'Queue a client-side download for the user as txt, csv, or json.',
        inputSchema: z.object({
          filename: z.string().min(1),
          format: z.enum(['csv', 'json', 'txt']),
          data: z.json(),
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
          // CAS update (V2): `workspace` was captured at turn start, so a
          // blind put of it would revert a PATCH (e.g. a model override) that
          // landed while this turn was streaming. Patch the freshly read
          // record through the etag CAS instead.
          const result = await updateWorkspaceWithRetry(this.env, sessionId, workspace.id, (current) => ({
            ...current,
            name: name ?? current.name,
            description: description ?? current.description,
            updatedAt: new Date().toISOString(),
          }));
          if (!result.ok) {
            throw new Error(
              result.reason === 'not-found'
                ? `Workspace record not found: ${workspace.id}`
                : 'Conflicting concurrent workspace update; retry'
            );
          }
          await this.syncWorkspace(result.workspace, sessionId);
          return result.workspace;
        },
      }),
    };

    // A migration freeze may interleave at any await boundary. Track every
    // host-side mutation as one fenced unit: freeze refuses while a unit is
    // active, and once frozen no later tool can begin.
    type MutationTool = { execute?: (...args: never[]) => Promise<never> };
    interface MutationToolSet {
      write_file?: MutationTool;
      write_xlsx?: MutationTool;
      write_docx?: MutationTool;
      ui_markdown?: MutationTool;
      ui_detail?: MutationTool;
      ui_table?: MutationTool;
      ui_chart?: MutationTool;
      ui_cards?: MutationTool;
      ui_show_file?: MutationTool;
      ui_download?: MutationTool;
      ui_workspace?: MutationTool;
    }
    const mutationToolNames: Array<keyof MutationToolSet> = [
      'write_file',
      'write_xlsx',
      'write_docx',
      'ui_markdown',
      'ui_detail',
      'ui_table',
      'ui_chart',
      'ui_cards',
      'ui_show_file',
      'ui_download',
      'ui_workspace',
    ];
    // SAFETY: these are the exact mutation tools returned by buildHostTools;
    // only their execute callbacks are wrapped below, preserving each tool's
    // validated input schema and public name.
    const mutableTools = tools as MutationToolSet;
    for (const name of mutationToolNames) {
      const toolDefinition = mutableTools[name];
      const original = toolDefinition?.execute;
      if (!original) continue;
      toolDefinition.execute = (...args: never[]) =>
        this.withMutationFence(() => original(...args));
    }

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

  private async withMutationFence<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertNotFrozen();
    this.activeMutations += 1;
    try {
      return await operation();
    } finally {
      this.activeMutations -= 1;
    }
  }

  private assertAuthorizedRpc(): void {
    if (this.env.CAIL_REQUIRE_IDENTITY === 'true' && !this.cailSubject) {
      throw new Error('authentication_required: reconnect through the authenticated HTTP session');
    }
  }

  /**
   * Persist a panel update and an explicitly requested tile association in one
   * state write. `sourcePanelId` is a caller-supplied relationship, never an
   * inferred line from layout or proximity.
   */
  private upsertPanelWithAssociation(panel: WorkspacePanel, sourcePanelId?: string): void {
    const relationshipId = sourcePanelId ?? (panel.type === 'detail' ? panel.linkedTo : undefined);
    if (relationshipId !== undefined) {
      panelIdSchema.parse(relationshipId);
      if (relationshipId === panel.id) {
        throw new Error('A tile cannot be associated with itself');
      }
      if (!this.state.panels.some((candidate) => candidate.id === relationshipId)) {
        throw new Error(`Panel not found: ${relationshipId}`);
      }
    }

    let panelWithSource: WorkspacePanel = relationshipId === undefined
      ? panel
      : {
        ...panel,
        sourcePanelId: relationshipId,
      };
    if (relationshipId !== undefined && panelWithSource.type === 'detail') {
      panelWithSource = { ...panelWithSource, linkedTo: relationshipId };
    }
    const index = this.state.panels.findIndex((candidate) => candidate.id === panelWithSource.id);
    const panels = [...this.state.panels];
    const previousPanel = index >= 0 ? panels[index] : undefined;
    let mergedPanel: WorkspacePanel;
    if (index >= 0) {
      const current = panels[index];
      const preserved = {
        layout: panelWithSource.layout ? { ...current.layout, ...panelWithSource.layout } : current.layout,
        sourcePanelId: panelWithSource.sourcePanelId ?? current.sourcePanelId,
      };
      mergedPanel = current.type === panelWithSource.type
        ? { ...current, ...panelWithSource, ...preserved }
        : { ...panelWithSource, ...preserved };
      panels[index] = panelSchema.parse(mergedPanel);
      mergedPanel = panels[index];
    } else {
      panels.push(panelWithSource);
      mergedPanel = panelWithSource;
    }

    let nextConnections = [...this.state.connections];
    if (relationshipId !== undefined) {
      const previousRelationshipId = previousPanel?.sourcePanelId
        ?? (previousPanel?.type === 'detail' ? previousPanel.linkedTo : undefined);
      if (previousRelationshipId !== undefined) {
        nextConnections = nextConnections.filter(
          (current) => connectionEndpointKey(current.sourceId, current.targetId)
            !== connectionEndpointKey(previousRelationshipId, mergedPanel.id),
        );
      }
      const connection = makePanelConnection(relationshipId, mergedPanel.id);
      if (!nextConnections.some((current) => connectionEndpointKey(current.sourceId, current.targetId) === connectionEndpointKey(connection.sourceId, connection.targetId))) {
        nextConnections.push(connection);
      }
    }

    const normalizedRelations = normalizePanelRelations(panels, nextConnections);
    this.setState({ ...this.state, ...normalizedRelations });
  }
}
