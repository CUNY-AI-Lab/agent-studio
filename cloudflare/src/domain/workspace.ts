/**
 * Canonical set of panel `type` literals (AS-3-7). The same enum is restated in
 * several hand-maintained places — the WorkspacePanelBase union below, the
 * import.ts zod discriminatedUnion, the workspace-agent panel switch, and the
 * frontend types.ts — with no compile-time link between them. This array is the
 * single source of truth the zod schema and the drift test reference so a new
 * panel type can't silently land in one copy but not the others.
 *
 * When you add a panel type: add it here. WorkspacePanelBase.type is typed as
 * `PanelType` (= PANEL_TYPES[number]) below, so the panel-object union is locked
 * to this array at compile time by that field type — there is no separate
 * `satisfies` guard; the lock is the `type: PanelType` field itself.
 */
export const PANEL_TYPES = [
  'chat',
  'table',
  'chart',
  'cards',
  'markdown',
  'pdf',
  'preview',
  'fileTree',
  'editor',
  'file',
  'detail',
] as const;

export type PanelType = (typeof PANEL_TYPES)[number];

export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  galleryId?: string;
  /** Optional per-workspace model override (a curated `cail/...` alias). */
  model?: string;
}

export interface PanelLayout {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PanelGroup {
  id: string;
  name?: string;
  panelIds: string[];
  color?: string;
}

export interface PanelConnection {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

interface WorkspacePanelBase {
  id: string;
  type: PanelType;
  title?: string;
  layout?: PanelLayout;
  sourcePanelId?: string;
}

export interface MarkdownPanel extends WorkspacePanelBase {
  type: 'markdown';
  content: string;
}

export interface TablePanel extends WorkspacePanelBase {
  type: 'table';
  columns: Array<{ key: string; label: string }>;
  rows: Record<string, string | number | boolean | null>[];
}

export interface ChartPanel extends WorkspacePanelBase {
  type: 'chart';
  chartType: 'bar' | 'line' | 'pie' | 'area';
  data: Record<string, string | number | boolean | null>[];
}

export interface CardsPanel extends WorkspacePanelBase {
  type: 'cards';
  items: Array<{
    id?: string;
    title: string;
    subtitle?: string;
    description?: string;
    badge?: string;
    metadata?: Record<string, string>;
  }>;
}

export interface FilePanel extends WorkspacePanelBase {
  type: 'pdf' | 'editor' | 'file';
  filePath: string;
}

export interface PreviewPanel extends WorkspacePanelBase {
  type: 'preview';
  filePath?: string;
  content?: string;
}

export interface FileTreePanel extends WorkspacePanelBase {
  type: 'fileTree';
}

export interface DetailPanel extends WorkspacePanelBase {
  type: 'detail';
  linkedTo?: string;
}

export interface ChatPanel extends WorkspacePanelBase {
  type: 'chat';
}

export type WorkspacePanel =
  | ChatPanel
  | MarkdownPanel
  | TablePanel
  | ChartPanel
  | CardsPanel
  | FilePanel
  | PreviewPanel
  | FileTreePanel
  | DetailPanel;

export interface WorkspaceState {
  sessionId: string | null;
  workspace: WorkspaceRecord | null;
  panels: WorkspacePanel[];
  viewport: WorkspaceViewport;
  groups: PanelGroup[];
  connections: PanelConnection[];
}

export interface WorkspaceObservabilityToolCall {
  toolCallId: string;
  toolName: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  inputChars: number;
  deltaCount: number;
  startedAt: string;
  updatedAt: string;
  lastPreview?: string;
}

export interface WorkspaceObservabilityRequest {
  requestId: string;
  status: 'streaming' | 'finished' | 'aborted' | 'error';
  model: string;
  startedAt: string;
  updatedAt: string;
  lastChunkAt?: string;
  idleMs: number;
  suspectedStall: boolean;
  scopedPanelIds: string[];
  steps: number;
  chunkCounts: {
    text: number;
    reasoning: number;
    toolInput: number;
    toolResult: number;
    raw: number;
  };
  finishReason?: string;
  rawFinishReason?: string;
  errors: string[];
  tools: WorkspaceObservabilityToolCall[];
}

export interface WorkspaceObservabilityEvent {
  id: string;
  requestId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  type:
    | 'request-start'
    | 'step-start'
    | 'chunk'
    | 'tool-call'
    | 'tool-result'
    | 'finish'
    | 'abort'
    | 'error';
  detail: string;
  data?: Record<string, unknown>;
}

export interface WorkspaceObservabilitySnapshot {
  generatedAt: string;
  requests: WorkspaceObservabilityRequest[];
  events: WorkspaceObservabilityEvent[];
}

export interface WorkspaceFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  uploadedAt?: string;
  modifiedAt?: string;
  etag?: string;
}

/**
 * Partial layout update. Like `panels`, the `groups` and `connections` arrays
 * are per-id UPSERTS of just the entries the client changed — never a whole
 * replacement snapshot — so a stale client array can't erase concurrent
 * server-side changes. Group deletion is explicit via `removeGroups`;
 * connections are only ever removed server-side (removePanel).
 */
export interface LayoutPatch {
  panels?: Record<string, PanelLayout>;
  groups?: PanelGroup[];
  removeGroups?: string[];
  connections?: PanelConnection[];
  viewport?: WorkspaceViewport;
}

const DEFAULT_VIEWPORT: WorkspaceViewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  sessionId: null,
  workspace: null,
  panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
  viewport: DEFAULT_VIEWPORT,
  groups: [],
  connections: [],
};
