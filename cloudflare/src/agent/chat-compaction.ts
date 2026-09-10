import type { ModelMessage, UIMessage } from 'ai';
import { PANEL_TYPES, type WorkspacePanel } from '../domain/workspace';
import { z } from 'zod';

export const CHAT_COMPACTION_SCHEMA_VERSION = 3;
export const CHAT_COMPACTION_RECENT_COMPLETE_TURNS = 2;
export const CHAT_COMPACTION_TRIGGER_CEILING = 0.8;
export const CHAT_COMPACTION_TARGET_CEILING = 0.6;
export const CHAT_COMPACTION_PANEL_PROMPT_MAX_CHARS = 2_048;
export const CHAT_COMPACTION_PART_VALUE_MAX_CHARS = 800;
// The summary and source digest cover the complete compacted range. These
// bounded metadata views are only for diagnostics/audit and must not grow with
// every turn in a long-lived workspace.
export const CHAT_COMPACTION_SOURCE_ID_LIMIT = 128;
export const CHAT_COMPACTION_PROVENANCE_LIMIT = 64;

// These reserves are deliberately explicit. The Gateway catalog reports the
// model's context window in tokens, while the application has no provider-
// specific tokenizer. The estimator is conservative and leaves room for the
// system prompt, tool definitions, and the response/tool loop.
export const CHAT_COMPACTION_RESERVE_TOKENS = {
  output: 8_192,
  system: 4_096,
  tools: 8_192,
} as const;

export interface ChatPanelProvenance {
  id: string;
  type: WorkspacePanel['type'];
  title?: string;
  sourcePanelId?: string;
  linkedTo?: string;
  filePath?: string;
  /** Exact bounded panel descriptor included in the scoped model prompt. */
  promptData: string;
}

export interface ChatTurnScopeSnapshot {
  userMessageId: string;
  requestId: string;
  scopePanelIds: string[];
  panels: ChatPanelProvenance[];
  recordedAt: string;
}

export interface ChatCompactionOverlay {
  version: typeof CHAT_COMPACTION_SCHEMA_VERSION;
  anchorMessageId: string | null;
  anchorThroughMessageId: string | null;
  throughMessageId: string;
  sourceMessageIds: string[];
  sourceFingerprint: string;
  summary: string;
  panelProvenance: ChatTurnScopeSnapshot[];
  modelContextLength: number;
  triggerTokens: number;
  targetTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatCompactionTurn {
  start: number;
  end: number;
  messages: UIMessage[];
  userMessage: UIMessage | null;
  settled: boolean;
}

export interface ChatCompactionPlan {
  candidateTurns: ChatCompactionTurn[];
  retainedTurns: ChatCompactionTurn[];
  candidateMessages: UIMessage[];
  retainedMessages: UIMessage[];
  throughMessageId: string | null;
  anchorMessageId: string | null;
  anchorThroughMessageId: string | null;
}

type CompactionSqlBinding = string | number | null;
type CompactionSqlRow = Record<string, string | number | null>;

interface StoredChatCompactionRow extends CompactionSqlRow {
  version: number;
  anchor_message_id: string | null;
  anchor_through_message_id: string | null;
  through_message_id: string;
  source_message_ids: string;
  source_fingerprint: string | null;
  summary: string;
  panel_provenance: string;
  model_context_length: number;
  trigger_tokens: number;
  target_tokens: number;
  created_at: string;
  updated_at: string;
}

interface StoredChatTurnContextRow extends CompactionSqlRow {
  user_message_id: string;
  request_id: string;
  scope_panel_ids: string;
  panels: string;
  recorded_at: string;
}

export interface ChatCompactionSqlStorage {
  exec?: (query: string, ...bindings: CompactionSqlBinding[]) => ChatCompactionSqlResult;
}

interface ChatCompactionSqlResult {
  toArray?: () => CompactionSqlRow[];
  [Symbol.iterator]?: () => IterableIterator<CompactionSqlRow>;
}

const CHAT_COMPACTION_TABLE = 'agent_studio_chat_compaction_overlay';
const CHAT_TURN_CONTEXT_TABLE = 'agent_studio_chat_turn_context';

const chatPanelProvenanceSchema = z.object({
  id: z.string(),
  type: z.enum(PANEL_TYPES),
  title: z.string().optional(),
  sourcePanelId: z.string().optional(),
  linkedTo: z.string().optional(),
  filePath: z.string().optional(),
  promptData: z.string().default(''),
});
const chatTurnScopeSnapshotSchema = z.object({
  userMessageId: z.string(),
  requestId: z.string(),
  scopePanelIds: z.array(z.string()),
  panels: z.array(chatPanelProvenanceSchema),
  recordedAt: z.string(),
});

export async function chatMessagesFingerprint(messages: UIMessage[]): Promise<string> {
  const serialized = JSON.stringify(messages);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PENDING_PART_STATES = new Set([
  'streaming',
  'input-streaming',
  'input-available',
  'approval-requested',
  'approval-responded',
]);

function hasPendingPart(message: UIMessage): boolean {
  return message.parts.some((part) => {
    return 'state' in part
      && part.state !== undefined
      && PENDING_PART_STATES.has(part.state);
  });
}

export function isSettledChatTurn(turn: ChatCompactionTurn): boolean {
  if (!turn.userMessage) return false;
  return turn.messages.every((message) => message.role !== 'assistant' || !hasPendingPart(message));
}

/**
 * Split the UI transcript at user messages. A complete turn is one user
 * message and every assistant/tool message up to the next user message. We
 * retain whole UI messages so reasoning and tool-call/result parts can never
 * be split across a compaction boundary.
 */
export function splitChatTurns(messages: UIMessage[]): ChatCompactionTurn[] {
  if (messages.length === 0) return [];

  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index);
  });
  if (starts.length === 0) {
    return [{
      start: 0,
      end: messages.length,
      messages: [...messages],
      userMessage: null,
      settled: false,
    }];
  }

  const turns: ChatCompactionTurn[] = [];
  const firstStart = starts[0];
  if (firstStart > 0) {
    const prelude = messages.slice(0, firstStart);
    turns.push({
      start: 0,
      end: firstStart,
      messages: prelude,
      userMessage: null,
      settled: false,
    });
  }

  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? messages.length;
    const turnMessages = messages.slice(start, end);
    const userMessage = turnMessages.find((message) => message.role === 'user') ?? null;
    const turn: ChatCompactionTurn = {
      start,
      end,
      messages: turnMessages,
      userMessage,
      settled: false,
    };
    turn.settled = isSettledChatTurn(turn);
    turns.push(turn);
  });

  return turns;
}

function uniqueMessages(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/**
 * Select old complete turns while preserving the current turn and the two
 * immediately preceding complete turns. If an older turn is unsettled, no
 * later turn is compacted across it.
 */
export function planChatCompaction(
  messages: UIMessage[],
  previousThroughMessageId?: string | null,
  recentCompleteTurns = CHAT_COMPACTION_RECENT_COMPLETE_TURNS,
): ChatCompactionPlan {
  const turns = splitChatTurns(messages);
  if (turns.length <= recentCompleteTurns + 1) {
    return {
      candidateTurns: [],
      retainedTurns: turns,
      candidateMessages: [],
      retainedMessages: messages,
      throughMessageId: previousThroughMessageId ?? null,
      anchorMessageId: null,
      anchorThroughMessageId: null,
    };
  }

  const candidateCount = Math.max(0, turns.length - recentCompleteTurns - 1);
  const candidateTurns = turns.slice(0, candidateCount);
  const retainedTurns = turns.slice(candidateCount);
  if (
    candidateTurns.some((turn) => !turn.userMessage || !turn.settled)
    || retainedTurns.length === 0
  ) {
    return {
      candidateTurns: [],
      retainedTurns: turns,
      candidateMessages: [],
      retainedMessages: messages,
      throughMessageId: previousThroughMessageId ?? null,
      anchorMessageId: null,
      anchorThroughMessageId: null,
    };
  }

  const candidateMessages = uniqueMessages(candidateTurns.flatMap((turn) => turn.messages));
  const throughMessageId = candidateMessages.at(-1)?.id ?? null;
  const firstUser = candidateTurns
    .flatMap((turn) => turn.messages)
    .find((message) => message.role === 'user');
  const anchorMessageId = firstUser?.id ?? null;
  const anchorThroughMessageId = candidateTurns[0]?.messages.at(-1)?.id ?? null;
  const retainedMessages = uniqueMessages(retainedTurns.flatMap((turn) => turn.messages));

  if (!throughMessageId) {
    return {
      candidateTurns: [],
      retainedTurns: turns,
      candidateMessages: [],
      retainedMessages: messages,
      throughMessageId: previousThroughMessageId ?? null,
      anchorMessageId: null,
      anchorThroughMessageId: null,
    };
  }

  // Once an overlay exists, only append newly eligible messages to its
  // summary. A missing marker means the canonical transcript changed (clear,
  // import, or replacement), so the caller must ignore the stale overlay.
  let newCandidateMessages = candidateMessages;
  let newAnchorMessageId = anchorMessageId;
  if (previousThroughMessageId) {
    const previousIndex = candidateMessages.findIndex((message) => message.id === previousThroughMessageId);
    if (previousIndex < 0) {
      return {
        candidateTurns: [],
        retainedTurns: turns,
        candidateMessages: [],
        retainedMessages: messages,
        throughMessageId: null,
        anchorMessageId: null,
        anchorThroughMessageId: null,
      };
    }
    newCandidateMessages = candidateMessages.slice(previousIndex + 1);
    newAnchorMessageId = null;
  }

  return {
    candidateTurns,
    retainedTurns,
    candidateMessages: newCandidateMessages,
    retainedMessages,
    throughMessageId,
    anchorMessageId: newAnchorMessageId,
    anchorThroughMessageId: previousThroughMessageId ? null : anchorThroughMessageId,
  };
}

/**
 * Resolve the canonical UI messages covered by a persisted overlay. The
 * digest, rather than the bounded diagnostic ID sample, is the freshness
 * authority. A missing or reordered marker makes the overlay unusable.
 */
export function sourceMessagesForChatCompaction(
  messages: UIMessage[],
  overlay: Pick<ChatCompactionOverlay, 'anchorMessageId' | 'anchorThroughMessageId' | 'throughMessageId'>,
): UIMessage[] | null {
  const throughIndex = messages.findIndex((message) => message.id === overlay.throughMessageId);
  if (throughIndex < 0) return null;
  if (!overlay.anchorMessageId || !overlay.anchorThroughMessageId) {
    return messages.slice(0, throughIndex + 1);
  }
  const anchorIndex = messages.findIndex((message) => message.id === overlay.anchorMessageId);
  const anchorThroughIndex = messages.findIndex((message) => message.id === overlay.anchorThroughMessageId);
  if (anchorIndex < 0 || anchorThroughIndex < anchorIndex || anchorThroughIndex > throughIndex) return null;
  return messages.slice(anchorIndex, throughIndex + 1);
}

export function estimateChatTokens(value: string | readonly UIMessage[] | readonly ModelMessage[]): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    serialized = String(value);
  }
  // JSON characters are a conservative, provider-independent proxy for token
  // count. The lower bound prevents tiny messages from rounding to zero.
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export interface ChatCompactionBudgets {
  hardTokens: number;
  triggerTokens: number;
  targetTokens: number;
}

export function chatCompactionBudgets(
  contextLength: number | null | undefined,
  reserves: {
    output?: number;
    system?: number;
    tools?: number;
  } = {},
): ChatCompactionBudgets | null {
  if (!Number.isFinite(contextLength) || !contextLength || contextLength <= 0) return null;
  const reserve = (reserves.output ?? CHAT_COMPACTION_RESERVE_TOKENS.output)
    + (reserves.system ?? CHAT_COMPACTION_RESERVE_TOKENS.system)
    + (reserves.tools ?? CHAT_COMPACTION_RESERVE_TOKENS.tools);
  const hardTokens = Math.floor(contextLength - reserve);
  if (hardTokens <= 0) return null;
  return {
    hardTokens,
    triggerTokens: Math.min(Math.floor(contextLength * CHAT_COMPACTION_TRIGGER_CEILING), hardTokens),
    targetTokens: Math.min(Math.floor(contextLength * CHAT_COMPACTION_TARGET_CEILING), hardTokens),
  };
}

/**
 * Owns only the app's compaction metadata. The AIChatAgent transcript remains
 * the source of truth; this store is a recoverable, one-row overlay plus
 * immutable per-turn scope snapshots.
 */
export class ChatCompactionStore {
  private schemaReady = false;

  constructor(private readonly sql: ChatCompactionSqlStorage | null | undefined) {}

  get available(): boolean {
    return this.sql?.exec !== undefined;
  }

  private query<T extends CompactionSqlRow = CompactionSqlRow>(
    query: string,
    ...bindings: CompactionSqlBinding[]
  ): T[] {
    const exec = this.sql?.exec;
    if (!exec) return [];
    const result = exec.call(this.sql, query, ...bindings);
    if (!result) return [];
    if (result.toArray) {
      // SAFETY: Durable Object SQL cursors return rows with the selected
      // columns; callers validate each row before constructing domain values.
      return result.toArray() as T[];
    }
    const iterator = result[Symbol.iterator];
    if (iterator) {
      // SAFETY: this cursor's iterator yields the same selected row contract as
      // toArray(), and callers validate each row before constructing domains.
      return [...iterator.call(result)].map((row) => row as T);
    }
    return [];
  }

  private ensureSchema(): boolean {
    if (!this.available) return false;
    if (this.schemaReady) return true;
    this.query(`
      create table if not exists ${CHAT_COMPACTION_TABLE} (
        slot integer primary key check (slot = 1),
        version integer not null,
        anchor_message_id text,
        anchor_through_message_id text,
        through_message_id text not null,
        source_message_ids text not null,
        source_fingerprint text,
        summary text not null,
        panel_provenance text not null,
        model_context_length integer not null,
        trigger_tokens integer not null,
        target_tokens integer not null,
        -- Retained as a write-compatible mirror for the v2 table, whose
        -- threshold_tokens column is NOT NULL. trigger/target are canonical.
        threshold_tokens integer not null,
        created_at text not null,
        updated_at text not null
      )
    `);
    // Existing agents may have an older table. ALTER is intentionally best
    // effort: a fresh table already contains both columns, while an older DO
    // gets the additive migration without touching canonical chat storage.
    try {
      this.query(`alter table ${CHAT_COMPACTION_TABLE} add column anchor_through_message_id text`);
    } catch {
      // Column already exists.
    }
    try {
      this.query(`alter table ${CHAT_COMPACTION_TABLE} add column source_fingerprint text`);
    } catch {
      // Column already exists.
    }
    try {
      this.query(`alter table ${CHAT_COMPACTION_TABLE} add column trigger_tokens integer`);
    } catch {
      // Column already exists.
    }
    try {
      this.query(`alter table ${CHAT_COMPACTION_TABLE} add column target_tokens integer`);
    } catch {
      // Column already exists.
    }
    try {
      this.query(`alter table ${CHAT_COMPACTION_TABLE} add column threshold_tokens integer`);
    } catch {
      // Column already exists.
    }
    this.query(`
      create table if not exists ${CHAT_TURN_CONTEXT_TABLE} (
        user_message_id text primary key,
        request_id text not null,
        scope_panel_ids text not null,
        panels text not null,
        recorded_at text not null
      )
    `);
    this.schemaReady = true;
    return true;
  }

  clear(): void {
    try {
      if (!this.ensureSchema()) return;
      this.query(`delete from ${CHAT_COMPACTION_TABLE}`);
      this.query(`delete from ${CHAT_TURN_CONTEXT_TABLE}`);
    } catch {
      // Chat reset must retain the framework's canonical behavior if metadata
      // is unavailable on an older Durable Object.
    }
  }

  readOverlay(): ChatCompactionOverlay | null {
    try {
      if (!this.ensureSchema()) return null;
      const row = this.query<StoredChatCompactionRow>(
        `select version, anchor_message_id, anchor_through_message_id,
          through_message_id, source_message_ids, source_fingerprint,
          summary, panel_provenance, model_context_length, trigger_tokens,
          target_tokens,
          created_at, updated_at
         from ${CHAT_COMPACTION_TABLE} where slot = 1 limit 1`,
      )[0];
      if (!row || Number(row.version) !== CHAT_COMPACTION_SCHEMA_VERSION) return null;
      const sourceMessageIds = z.array(z.string()).safeParse(JSON.parse(row.source_message_ids));
      const sourceFingerprint = z.string().safeParse(row.source_fingerprint);
      const panelProvenanceRows = z.array(chatTurnScopeSnapshotSchema)
        .safeParse(JSON.parse(row.panel_provenance));
      if (!sourceMessageIds.success || !sourceFingerprint.success || !panelProvenanceRows.success) return null;
      return {
        version: CHAT_COMPACTION_SCHEMA_VERSION,
        anchorMessageId: row.anchor_message_id,
        anchorThroughMessageId: row.anchor_through_message_id ?? null,
        throughMessageId: row.through_message_id,
        sourceMessageIds: sourceMessageIds.data,
        sourceFingerprint: sourceFingerprint.data,
        summary: row.summary,
        panelProvenance: panelProvenanceRows.data,
        modelContextLength: Number(row.model_context_length),
        triggerTokens: Number(row.trigger_tokens),
        targetTokens: Number(row.target_tokens),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  readTurnScopes(): Map<string, ChatTurnScopeSnapshot> {
    const result = new Map<string, ChatTurnScopeSnapshot>();
    try {
      if (!this.ensureSchema()) return result;
      const rows = this.query<StoredChatTurnContextRow>(
        `select user_message_id, request_id, scope_panel_ids, panels, recorded_at
         from ${CHAT_TURN_CONTEXT_TABLE}`,
      );
      for (const row of rows) {
        try {
          const ids = z.array(z.string()).safeParse(JSON.parse(row.scope_panel_ids));
          const panels = z.array(chatPanelProvenanceSchema).safeParse(JSON.parse(row.panels));
          if (!ids.success || !panels.success) continue;
          result.set(row.user_message_id, {
            userMessageId: row.user_message_id,
            requestId: row.request_id,
            scopePanelIds: ids.data,
            panels: panels.data,
            recordedAt: row.recorded_at,
          });
        } catch {
          // A malformed row cannot affect the canonical transcript or other
          // provenance snapshots.
        }
      }
    } catch {
      // Metadata is best effort for legacy agents without these tables.
    }
    return result;
  }

  recordTurnScope(args: {
    userMessageId: string;
    requestId: string;
    scopePanelIds: string[];
    scopedPanels: WorkspacePanel[];
  }): void {
    try {
      if (!this.ensureSchema()) return;
      const snapshots = args.scopedPanels.map(panelProvenance);
      this.query(
        `insert into ${CHAT_TURN_CONTEXT_TABLE}
          (user_message_id, request_id, scope_panel_ids, panels, recorded_at)
         values (?, ?, ?, ?, ?)
         on conflict(user_message_id) do nothing`,
        args.userMessageId,
        args.requestId,
        JSON.stringify(args.scopePanelIds),
        JSON.stringify(snapshots),
        new Date().toISOString(),
      );
    } catch {
      // Provenance must never reject or corrupt the canonical chat turn.
    }
  }

  writeOverlay(overlay: ChatCompactionOverlay): void {
    if (!this.ensureSchema()) throw new Error('chat compaction SQL storage unavailable');
    this.query(
      `insert into ${CHAT_COMPACTION_TABLE}
        (slot, version, anchor_message_id, anchor_through_message_id,
         through_message_id, source_message_ids, source_fingerprint,
         summary, panel_provenance, model_context_length, trigger_tokens,
         target_tokens, threshold_tokens,
         created_at, updated_at)
       values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(slot) do update set
         version = excluded.version,
         anchor_message_id = excluded.anchor_message_id,
         anchor_through_message_id = excluded.anchor_through_message_id,
         through_message_id = excluded.through_message_id,
         source_message_ids = excluded.source_message_ids,
         source_fingerprint = excluded.source_fingerprint,
         summary = excluded.summary,
         panel_provenance = excluded.panel_provenance,
         model_context_length = excluded.model_context_length,
         trigger_tokens = excluded.trigger_tokens,
         target_tokens = excluded.target_tokens,
         threshold_tokens = excluded.threshold_tokens,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      overlay.version,
      overlay.anchorMessageId,
      overlay.anchorThroughMessageId,
      overlay.throughMessageId,
      JSON.stringify(overlay.sourceMessageIds),
      overlay.sourceFingerprint,
      overlay.summary,
      JSON.stringify(overlay.panelProvenance),
      overlay.modelContextLength,
      overlay.triggerTokens,
      overlay.targetTokens,
      overlay.targetTokens,
      overlay.createdAt,
      overlay.updatedAt,
    );
  }
}

export function panelProvenance(panel: WorkspacePanel): ChatPanelProvenance {
  const result: ChatPanelProvenance = {
    id: panel.id,
    type: panel.type,
    promptData: panelPromptData(panel),
  };
  if (panel.title) result.title = panel.title;
  if (panel.sourcePanelId) result.sourcePanelId = panel.sourcePanelId;
  if ('linkedTo' in panel && panel.linkedTo) result.linkedTo = panel.linkedTo;
  if ('filePath' in panel && panel.filePath) result.filePath = panel.filePath;
  return result;
}

/**
 * The exact bounded descriptor sent in the scoped system prompt. Keeping it
 * with the durable provenance snapshot makes a later summary auditable even
 * if the live panel is edited or removed.
 */
export function panelPromptData(panel: WorkspacePanel): string {
  const descriptor: PanelPromptDescriptor = {
    id: panel.id,
    type: panel.type,
  };
  if (panel.title) descriptor.title = panel.title;
  if (panel.sourcePanelId) descriptor.sourcePanelId = panel.sourcePanelId;
  if ('linkedTo' in panel && panel.linkedTo) descriptor.linkedTo = panel.linkedTo;
  if ('filePath' in panel && panel.filePath) descriptor.filePath = panel.filePath;
  if ('content' in panel && panel.content) descriptor.content = panel.content.slice(0, 240);
  return JSON.stringify(descriptor).slice(0, CHAT_COMPACTION_PANEL_PROMPT_MAX_CHARS);
}

interface PanelPromptDescriptor {
  id: string;
  type: WorkspacePanel['type'];
  title?: string;
  sourcePanelId?: string;
  linkedTo?: string;
  filePath?: string;
  content?: string;
}

type ChatMessagePart = UIMessage['parts'][number];

function compactPartValue(label: string, serialized: string | undefined): string {
  return `${label}=${(serialized ?? '').slice(0, CHAT_COMPACTION_PART_VALUE_MAX_CHARS)}`;
}

function compactPart(part: ChatMessagePart): string {
  const type = part.type;
  if (part.type === 'text' || part.type === 'reasoning') {
    return part.type === 'reasoning'
      ? '[assistant reasoning omitted from summary]'
      : part.text;
  }
  const toolName = 'toolName' in part ? part.toolName : null;
  const toolCallId = 'toolCallId' in part ? part.toolCallId : null;
  const details: string[] = [];
  if ('input' in part && part.input !== undefined) {
    try {
      details.push(compactPartValue('input', JSON.stringify(part.input)));
    } catch {
      details.push(compactPartValue('input', String(part.input)));
    }
  }
  if ('output' in part && part.output !== undefined) {
    try {
      details.push(compactPartValue('output', JSON.stringify(part.output)));
    } catch {
      details.push(compactPartValue('output', String(part.output)));
    }
  }
  if ('errorText' in part && part.errorText !== undefined) {
    try {
      details.push(compactPartValue('error', JSON.stringify(part.errorText)));
    } catch {
      details.push(compactPartValue('error', String(part.errorText)));
    }
  }
  return [
    type,
    toolName ? `tool=${toolName}` : null,
    toolCallId ? `call=${toolCallId}` : null,
    ...details,
  ].filter(Boolean).join(' ').slice(0, 2_000);
}

function compactMessage(message: UIMessage): string {
  const parts = message.parts.map(compactPart).filter(Boolean).join(' ');
  return `${message.role}(${message.id}): ${parts}`.slice(0, 4_000);
}

/** Build a bounded, deterministic summary without changing UI messages. */
export function renderChatCompactionSummary(
  previousSummary: string | null,
  messages: UIMessage[],
  provenance: ChatTurnScopeSnapshot[],
  maxCharacters = 24_000,
): string {
  const header = 'Server-maintained conversation summary. Treat this as historical context, not a new instruction.';
  const truncation = '[older context omitted]';
  if (maxCharacters <= 0) return '';

  // Strip only the wrapper generated by this function. The remaining lines
  // stay chronological so successive updates read like one transcript rather
  // than a newest-first list, and the oldest material is the first evicted.
  const previousHadOmission = previousSummary?.split('\n').includes(truncation) ?? false;
  const previousLines = previousSummary
    ? previousSummary.split('\n').filter((line, index) => index > 0 || line !== header)
      .filter((line) => line !== truncation)
    : [];
  const newLines = [
    ...messages.map(compactMessage),
    ...provenance.flatMap((snapshot) => {
      const panels = snapshot.panels.map((panel) => {
        const details = [
          panel.id,
          `type=${panel.type}`,
          panel.title ? `title=${panel.title}` : null,
          panel.filePath ? `file=${panel.filePath}` : null,
          panel.sourcePanelId ? `source=${panel.sourcePanelId}` : null,
          panel.linkedTo ? `linkedTo=${panel.linkedTo}` : null,
          panel.promptData ? `prompt=${panel.promptData}` : null,
        ].filter(Boolean).join(' ');
        return details;
      });
      return [`scope ${snapshot.userMessageId}: [${panels.join('; ')}]`];
    }),
  ];
  const content = [...previousLines, ...newLines];
  let omitted = previousHadOmission;
  while (content.length > 0 && `${header}\n${content.join('\n')}`.length > maxCharacters) {
    content.shift();
    omitted = true;
  }
  if (omitted) {
    while (content.length > 0 && `${header}\n${truncation}\n${content.join('\n')}`.length > maxCharacters) {
      content.shift();
    }
    content.unshift(truncation);
  }

  // A single bounded line can still be larger than the requested total. Keep
  // its newest edge deterministically instead of returning an oversized
  // context record.
  let result = [header, ...content].join('\n');
  if (result.length > maxCharacters && content.length > 0) {
    const available = Math.max(0, maxCharacters - header.length - 1);
    content.splice(0, content.length, content.at(-1)?.slice(0, available) ?? '');
    result = [header, ...content].join('\n');
  }
  return result.slice(0, maxCharacters);
}
