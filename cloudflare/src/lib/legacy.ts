import type { UIMessage, UIMessagePart } from 'ai';
import type {
  CardsPanel,
  ChartPanel,
  TablePanel,
  WorkspaceFileInfo,
  WorkspacePanel,
  WorkspaceRecord,
  WorkspaceState,
} from '../domain/workspace';
import type { GalleryItemFull } from '../domain/gallery';

type LegacyToolExecution = {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'success' | 'error';
  output?: string;
};

type LegacyContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'tools';
      tools: LegacyToolExecution[];
    };

type LegacyPanel = {
  id: string;
  type: 'chat' | 'table' | 'editor' | 'preview' | 'fileTree' | 'detail' | 'chart' | 'cards' | 'markdown' | 'pdf';
  title?: string;
  layout?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  tableId?: string;
  chartId?: string;
  cardsId?: string;
  filePath?: string;
  content?: string;
  linkedTo?: string;
  sourcePanel?: string;
};

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function inferTableColumnType(
  rows: Array<Record<string, string | number | boolean | null>>,
  key: string
): 'text' | 'number' | 'date' | 'url' | 'status' {
  const sample = rows.find((row) => row[key] !== null && row[key] !== undefined)?.[key];
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'status';
  if (typeof sample === 'string') {
    if (/^https?:\/\//i.test(sample)) return 'url';
    if (!Number.isNaN(Date.parse(sample)) && /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/.test(sample)) return 'date';
  }
  return 'text';
}

function inferChartConfig(panel: ChartPanel): {
  xKey?: string;
  yKey?: string;
  labelKey?: string;
  valueKey?: string;
} {
  const sample = panel.data.find((row) => Object.keys(row).length > 0);
  if (!sample) return {};

  const entries = Object.entries(sample);
  const numericKey = entries.find(([, value]) => typeof value === 'number')?.[0];
  const categoricalKey = entries.find(([, value]) => typeof value === 'string')?.[0];
  const fallbackFirst = entries[0]?.[0];
  const fallbackSecond = entries[1]?.[0];

  if (panel.chartType === 'pie') {
    return {
      labelKey: categoricalKey || fallbackFirst,
      valueKey: numericKey || fallbackSecond || fallbackFirst,
    };
  }

  return {
    xKey: categoricalKey || fallbackFirst,
    yKey: numericKey || fallbackSecond || fallbackFirst,
  };
}

function toLegacyPanel(panel: WorkspacePanel): LegacyPanel {
  const base = {
    id: panel.id,
    title: panel.title,
    layout: panel.layout,
    sourcePanel: panel.sourcePanelId,
  };

  switch (panel.type) {
    case 'chat':
      return { ...base, type: 'chat' };
    case 'fileTree':
      return { ...base, type: 'fileTree' };
    case 'markdown':
      return { ...base, type: 'markdown', content: panel.content };
    case 'table':
      return { ...base, type: 'table', tableId: panel.id };
    case 'chart':
      return { ...base, type: 'chart', chartId: panel.id };
    case 'cards':
      return { ...base, type: 'cards', cardsId: panel.id };
    case 'pdf':
      return { ...base, type: 'pdf', filePath: panel.filePath };
    case 'preview':
      return { ...base, type: 'preview', filePath: panel.filePath, content: panel.content };
    case 'editor':
    case 'file':
      return { ...base, type: 'editor', filePath: panel.filePath };
    case 'detail':
      return { ...base, type: 'detail', linkedTo: panel.linkedTo };
  }
}

type ToolLikeUIPart = UIMessagePart<never, never> & {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  state?: string;
  output?: unknown;
  errorText?: string;
  approval?: { reason?: string };
};

function isToolPart(part: UIMessagePart<never, never>): part is ToolLikeUIPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function toLegacyToolExecution(part: UIMessagePart<never, never>): LegacyToolExecution | null {
  if (!isToolPart(part)) return null;

  const toolName = part.type === 'dynamic-tool'
    ? part.toolName
    : part.type.replace(/^tool-/, '');

  const status = (() => {
    switch (part.state) {
      case 'output-available':
        return 'success';
      case 'output-error':
      case 'output-denied':
        return 'error';
      default:
        return 'running';
    }
  })();

  const output = (() => {
    switch (part.state) {
      case 'output-available':
        return stringifyValue(part.output);
      case 'output-error':
        return part.errorText;
      case 'output-denied':
        return part.approval?.reason || 'Tool output denied';
      default:
        return undefined;
    }
  })();

  return {
    id: part.toolCallId || crypto.randomUUID(),
    name: toolName,
    input: part.input,
    status,
    ...(output ? { output } : {}),
  };
}

function toLegacyMessage(message: UIMessage): {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks?: LegacyContentBlock[];
} | null {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }

  let currentText = '';
  let currentTools: LegacyToolExecution[] = [];
  const blocks: LegacyContentBlock[] = [];
  let content = '';

  const flushText = () => {
    if (!currentText) return;
    blocks.push({ type: 'text', text: currentText });
    content += currentText;
    currentText = '';
  };

  const flushTools = () => {
    if (currentTools.length === 0) return;
    blocks.push({ type: 'tools', tools: currentTools });
    currentTools = [];
  };

  for (const part of message.parts) {
    if (part.type === 'text') {
      flushTools();
      currentText += part.text;
      continue;
    }

    if (part.type === 'reasoning' || part.type === 'step-start' || part.type === 'source-url' || part.type === 'source-document' || part.type === 'file') {
      continue;
    }

    const toolExecution = toLegacyToolExecution(part as UIMessagePart<never, never>);
    if (toolExecution) {
      flushText();
      currentTools.push(toolExecution);
    }
  }

  flushText();
  flushTools();

  return {
    id: message.id,
    role: message.role,
    content,
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

export function toLegacyMessages(messages: UIMessage[]) {
  return messages
    .map(toLegacyMessage)
    .filter((message): message is NonNullable<typeof message> => Boolean(message));
}

export function toLegacyFileInfo(file: WorkspaceFileInfo) {
  return {
    name: file.name,
    path: file.path,
    isDirectory: file.isDirectory,
    size: file.size,
    modifiedAt: file.uploadedAt,
  };
}

export function toLegacyPanelUpdate(panel: WorkspacePanel, action: 'add' | 'update' | 'remove') {
  const legacyPanel = toLegacyPanel(panel);

  if (panel.type === 'table') {
    const tablePanel = panel as TablePanel;
    return {
      action,
      panel: legacyPanel,
      data: {
        table: {
          id: tablePanel.id,
          title: tablePanel.title || 'Table',
          columns: tablePanel.columns.map((column) => ({
            key: column.key,
            label: column.label,
            type: inferTableColumnType(tablePanel.rows, column.key),
          })),
          data: tablePanel.rows,
        },
      },
    };
  }

  if (panel.type === 'chart') {
    const chartPanel = panel as ChartPanel;
    return {
      action,
      panel: legacyPanel,
      data: {
        chart: {
          id: chartPanel.id,
          title: chartPanel.title || 'Chart',
          type: chartPanel.chartType,
          data: chartPanel.data,
          config: inferChartConfig(chartPanel),
        },
      },
    };
  }

  if (panel.type === 'cards') {
    const cardsPanel = panel as CardsPanel;
    return {
      action,
      panel: legacyPanel,
      data: {
        cards: {
          id: cardsPanel.id,
          title: cardsPanel.title || 'Cards',
          items: cardsPanel.items,
        },
      },
    };
  }

  if (panel.type === 'markdown') {
    return {
      action,
      panel: legacyPanel,
      data: {
        content: panel.content,
      },
    };
  }

  if (panel.type === 'preview' && panel.content) {
    return {
      action,
      panel: legacyPanel,
      data: {
        content: panel.content,
      },
    };
  }

  return {
    action,
    panel: legacyPanel,
  };
}

export function toLegacyWorkspacePayload(args: {
  workspace: WorkspaceRecord;
  state: WorkspaceState;
  messages: UIMessage[];
  files: WorkspaceFileInfo[];
}) {
  const tables = args.state.panels
    .filter((panel): panel is TablePanel => panel.type === 'table')
    .map((panel) => ({
      id: panel.id,
      title: panel.title || 'Table',
      columns: panel.columns.map((column) => ({
        key: column.key,
        label: column.label,
        type: inferTableColumnType(panel.rows, column.key),
      })),
      data: panel.rows,
    }));

  const charts = Object.fromEntries(
    args.state.panels
      .filter((panel): panel is ChartPanel => panel.type === 'chart')
      .map((panel) => [
        panel.id,
        {
          id: panel.id,
          title: panel.title || 'Chart',
          type: panel.chartType,
          data: panel.data,
          config: inferChartConfig(panel),
        },
      ])
  );

  const cards = Object.fromEntries(
    args.state.panels
      .filter((panel): panel is CardsPanel => panel.type === 'cards')
      .map((panel) => [
        panel.id,
        {
          id: panel.id,
          title: panel.title || 'Cards',
          items: panel.items,
        },
      ])
  );

  return {
    workspace: args.workspace,
    tables,
    charts,
    cards,
    messages: toLegacyMessages(args.messages),
    uiState: {
      panels: args.state.panels.map(toLegacyPanel),
      viewport: args.state.viewport,
      groups: args.state.groups,
      connections: args.state.connections,
    },
    files: args.files.map(toLegacyFileInfo),
    downloads: [],
  };
}

export function toLegacyGalleryItem(item: GalleryItemFull) {
  const payload = toLegacyWorkspacePayload({
    workspace: {
      id: item.id,
      name: item.title,
      description: item.description,
      createdAt: item.publishedAt,
      updatedAt: item.publishedAt,
    },
    state: item.state,
    messages: [],
    files: [],
  });

  return {
    ...item,
    uiState: payload.uiState,
    tables: payload.tables,
    charts: payload.charts,
    cards: payload.cards,
  };
}
