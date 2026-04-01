export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  galleryId?: string;
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
  type: 'chat' | 'table' | 'chart' | 'cards' | 'markdown' | 'pdf' | 'preview' | 'fileTree' | 'editor' | 'file' | 'detail';
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

export interface LayoutPatch {
  panels?: Record<string, PanelLayout>;
  groups?: PanelGroup[];
  connections?: PanelConnection[];
  viewport?: WorkspaceViewport;
}

export const DEFAULT_VIEWPORT: WorkspaceViewport = {
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
