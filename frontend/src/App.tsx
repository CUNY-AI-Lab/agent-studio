import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import {
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai';
import { toPng } from 'html-to-image';
import { cn } from './lib/utils';
import { HomePage } from './components/HomePage';
import { ThemeToggle } from './components/ThemeToggle';
import { ConnectionLines as LegacyConnectionLines } from './components/canvas/ConnectionLines';
import { ContextualChatPopover as LegacyContextualChatPopover } from './components/canvas/ContextualChatPopover';
import { DraggablePanel as LegacyDraggablePanel } from './components/canvas/DraggablePanel';
import { GroupBoundary as LegacyGroupBoundary } from './components/canvas/GroupBoundary';
import { SelectionBox as LegacySelectionBox } from './components/canvas/SelectionBox';
import { SelectionToolbar as LegacySelectionToolbar } from './components/canvas/SelectionToolbar';
import {
  X,
  Plus,
  Minus,
  RotateCcw,
  Send,
  MessageSquare,
  Download,
  Trash2,
  Maximize2,
  Upload,
  Play,
  Layout,
  FolderOpen,
  Sparkles,
} from 'lucide-react';
import {
  clearWorkspaceDownloads,
  cloneGalleryItem,
  createWorkspace,
  deleteWorkspace,
  deleteWorkspaceFile,
  executeWorkspaceRuntime,
  fetchGalleryItem,
  fetchGalleryItems,
  fetchWorkspaceDownloads,
  fetchWorkspaceObservability,
  fetchWorkspaceExport,
  fetchWorkspace,
  fetchWorkspaceFiles,
  fetchWorkspaces,
  getGalleryPanelPreviewUrl,
  getGalleryFileUrl,
  getWorkspacePanelPreviewUrl,
  getWorkspaceFileUrl,
  importWorkspaceBundle,
  publishWorkspace,
  unpublishGalleryItem,
  updateWorkspace,
  uploadWorkspaceFiles,
} from './api';
import type {
  DownloadRequest,
  GalleryItem,
  GalleryItemFull,
  WorkspaceAgentClient,
  WorkspaceObservabilitySnapshot,
  WorkspaceFileInfo,
  WorkspacePanel,
  WorkspaceResponse,
  WorkspaceRuntimeExecution,
  WorkspaceState,
} from './types';

const LazyChartPanelView = lazy(() => import('./components/panels/ChartPanelView'));
const LazyMarkdownRenderer = lazy(() => import('./components/renderers/MarkdownRenderer'));

function extractMessageText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .map((part) => {
      if (isTextUIPart(part)) return part.text;
      if (isToolUIPart(part)) return `[tool:${getToolName(part)}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function inferPanelLayout(panel: WorkspacePanel, index: number) {
  const width = panel.layout?.width ?? 360;
  const height = panel.layout?.height ?? (panel.type === 'table' ? 300 : 220);
  const x = panel.layout?.x ?? 32 + (index % 3) * 392;
  const y = panel.layout?.y ?? 32 + Math.floor(index / 3) * 252;
  return { x, y, width, height };
}

type CanvasPanelLayout = ReturnType<typeof inferPanelLayout>;
type LayoutMap = Record<string, CanvasPanelLayout>;

type ToolbarDownloadFormat = 'file' | 'csv' | 'json' | 'txt' | 'png';
const PANEL_GAP = 20;
const RUNTIME_EXAMPLE = `async () => {
  const entries = await state.readdir("/");
  console.log("Root entries", entries);
  return entries;
}`;

interface ContextualThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ContextualChatTarget {
  key: string;
  panelIds: string[];
  title: string;
  typeLabel: string;
}

function buildPanelLayouts(panels: WorkspacePanel[]): Record<string, CanvasPanelLayout> {
  return Object.fromEntries(
    panels.map((panel, index) => [panel.id, inferPanelLayout(panel, index)])
  );
}

function collectLayouts(layouts: Record<string, CanvasPanelLayout>, panelIds: Iterable<string>): LayoutMap {
  const visibleLayouts: LayoutMap = {};
  for (const panelId of panelIds) {
    const layout = layouts[panelId];
    if (layout) {
      visibleLayouts[panelId] = { ...layout };
    }
  }
  return visibleLayouts;
}

function hasOverlappingPanels(layouts: LayoutMap): boolean {
  const panelIds = Object.keys(layouts);
  for (let index = 0; index < panelIds.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
      const left = layouts[panelIds[index]];
      const right = layouts[panelIds[nextIndex]];
      const overlaps = !(
        left.x + left.width + PANEL_GAP <= right.x ||
        right.x + right.width + PANEL_GAP <= left.x ||
        left.y + left.height + PANEL_GAP <= right.y ||
        right.y + right.height + PANEL_GAP <= left.y
      );
      if (overlaps) return true;
    }
  }
  return false;
}

function resolveCollisions(layouts: LayoutMap, fixedPanelIds: Set<string>): LayoutMap {
  const panelIds = Object.keys(layouts);
  const rectsOverlap = (left: CanvasPanelLayout, right: CanvasPanelLayout) => !(
    left.x + left.width + PANEL_GAP <= right.x ||
    right.x + right.width + PANEL_GAP <= left.x ||
    left.y + left.height + PANEL_GAP <= right.y ||
    right.y + right.height + PANEL_GAP <= left.y
  );

  for (let iteration = 0; iteration < 15; iteration += 1) {
    let hadCollision = false;

    for (let index = 0; index < panelIds.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < panelIds.length; nextIndex += 1) {
        const leftId = panelIds[index];
        const rightId = panelIds[nextIndex];
        const left = layouts[leftId];
        const right = layouts[rightId];

        if (!rectsOverlap(left, right)) continue;
        if (fixedPanelIds.has(leftId) && fixedPanelIds.has(rightId)) continue;

        hadCollision = true;

        let movedId: string;
        let fixedId: string;
        if (fixedPanelIds.has(leftId)) {
          movedId = rightId;
          fixedId = leftId;
        } else if (fixedPanelIds.has(rightId)) {
          movedId = leftId;
          fixedId = rightId;
        } else if (right.y > left.y || (right.y === left.y && right.x > left.x)) {
          movedId = rightId;
          fixedId = leftId;
        } else {
          movedId = leftId;
          fixedId = rightId;
        }

        const fixed = layouts[fixedId];
        const moved = layouts[movedId];
        const fixedCenterX = fixed.x + fixed.width / 2;
        const fixedCenterY = fixed.y + fixed.height / 2;
        const movedCenterX = moved.x + moved.width / 2;
        const movedCenterY = moved.y + moved.height / 2;

        const pushRight = fixed.x + fixed.width + PANEL_GAP - moved.x;
        const pushLeft = moved.x + moved.width + PANEL_GAP - fixed.x;
        const pushDown = fixed.y + fixed.height + PANEL_GAP - moved.y;
        const pushUp = moved.y + moved.height + PANEL_GAP - fixed.y;
        const pushX = movedCenterX >= fixedCenterX ? pushRight : pushLeft;
        const pushY = movedCenterY >= fixedCenterY ? pushDown : pushUp;

        if (pushX > 0 && pushX <= pushY) {
          const dx = movedCenterX >= fixedCenterX ? pushRight : -pushLeft;
          layouts[movedId] = { ...moved, x: moved.x + dx };
        } else if (pushY > 0) {
          const dy = movedCenterY >= fixedCenterY ? pushDown : -pushUp;
          layouts[movedId] = { ...moved, y: moved.y + dy };
        }
      }
    }

    if (!hadCollision) break;
  }

  return layouts;
}

function resolveVisibleLayoutCollisions(
  layouts: Record<string, CanvasPanelLayout>,
  visiblePanelIds: Iterable<string>,
  fixedPanelIds: Set<string>
): LayoutMap {
  const visibleLayouts = collectLayouts(layouts, visiblePanelIds);
  return hasOverlappingPanels(visibleLayouts)
    ? resolveCollisions(visibleLayouts, fixedPanelIds)
    : visibleLayouts;
}

function getLayoutsBounds(layouts: CanvasPanelLayout[]) {
  if (layouts.length === 0) return null;
  const minX = Math.min(...layouts.map((layout) => layout.x));
  const minY = Math.min(...layouts.map((layout) => layout.y));
  const maxX = Math.max(...layouts.map((layout) => layout.x + layout.width));
  const maxY = Math.max(...layouts.map((layout) => layout.y + layout.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function getGroupBounds(
  group: WorkspaceState['groups'][number],
  layouts: LayoutMap,
  padding: number,
  excludedPanelId?: string
) {
  const groupLayouts = group.panelIds
    .filter((groupPanelId) => groupPanelId !== excludedPanelId)
    .map((groupPanelId) => layouts[groupPanelId])
    .filter(Boolean) as CanvasPanelLayout[];

  if (groupLayouts.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  groupLayouts.forEach((layout) => {
    minX = Math.min(minX, layout.x);
    minY = Math.min(minY, layout.y);
    maxX = Math.max(maxX, layout.x + layout.width);
    maxY = Math.max(maxY, layout.y + layout.height);
  });

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function layoutOverlapsBounds(
  layout: CanvasPanelLayout,
  bounds: { x: number; y: number; width: number; height: number }
) {
  return !(
    layout.x + layout.width < bounds.x ||
    layout.x > bounds.x + bounds.width ||
    layout.y + layout.height < bounds.y ||
    layout.y > bounds.y + bounds.height
  );
}

function makeClientId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getConnectionEdgePoint(
  sourceLayout: CanvasPanelLayout,
  targetLayout: CanvasPanelLayout,
  isSource: boolean
) {
  const layout = isSource ? sourceLayout : targetLayout;
  const otherLayout = isSource ? targetLayout : sourceLayout;
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  const otherCenterX = otherLayout.x + otherLayout.width / 2;
  const otherCenterY = otherLayout.y + otherLayout.height / 2;
  const dx = otherCenterX - centerX;
  const dy = otherCenterY - centerY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0
      ? { x: layout.x + layout.width, y: centerY, side: 'right' as const }
      : { x: layout.x, y: centerY, side: 'left' as const };
  }

  return dy > 0
    ? { x: centerX, y: layout.y + layout.height, side: 'bottom' as const }
    : { x: centerX, y: layout.y, side: 'top' as const };
}

function generateConnectionPath(
  source: ReturnType<typeof getConnectionEdgePoint>,
  target: ReturnType<typeof getConnectionEdgePoint>
) {
  const curvature = 80;
  let sourceControlX = source.x;
  let sourceControlY = source.y;
  let targetControlX = target.x;
  let targetControlY = target.y;

  if (source.side === 'right') sourceControlX += curvature;
  if (source.side === 'left') sourceControlX -= curvature;
  if (source.side === 'bottom') sourceControlY += curvature;
  if (source.side === 'top') sourceControlY -= curvature;
  if (target.side === 'right') targetControlX += curvature;
  if (target.side === 'left') targetControlX -= curvature;
  if (target.side === 'bottom') targetControlY += curvature;
  if (target.side === 'top') targetControlY -= curvature;

  return `M ${source.x} ${source.y} C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${target.x} ${target.y}`;
}

function CanvasConnections({
  layouts,
  connections,
}: {
  layouts: Record<string, CanvasPanelLayout>;
  connections: WorkspaceState['connections'];
}) {
  const paths = connections
    .map((connection) => {
      const sourceLayout = layouts[connection.sourceId];
      const targetLayout = layouts[connection.targetId];
      if (!sourceLayout || !targetLayout) return null;
      const source = getConnectionEdgePoint(sourceLayout, targetLayout, true);
      const target = getConnectionEdgePoint(sourceLayout, targetLayout, false);
      return {
        id: connection.id,
        path: generateConnectionPath(source, target),
        source,
        target,
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    path: string;
    source: ReturnType<typeof getConnectionEdgePoint>;
    target: ReturnType<typeof getConnectionEdgePoint>;
  }>;

  if (paths.length === 0) return null;

  return (
    <svg className="connection-lines" aria-hidden="true">
      {paths.map((path) => (
        <g key={path.id}>
          <path className="connection-line" d={path.path} />
          <circle className="connection-line" cx={path.source.x} cy={path.source.y} r="3" fill="currentColor" />
          <circle className="connection-line" cx={path.target.x} cy={path.target.y} r="3" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

function CanvasGroups({
  layouts,
  groups,
}: {
  layouts: Record<string, CanvasPanelLayout>;
  groups: WorkspaceState['groups'];
}) {
  const boundaries = groups
    .map((group) => {
      const groupLayouts = group.panelIds
        .map((panelId) => layouts[panelId])
        .filter(Boolean) as CanvasPanelLayout[];
      if (groupLayouts.length < 2) return null;

      const padding = 18;
      const minX = Math.min(...groupLayouts.map((layout) => layout.x));
      const minY = Math.min(...groupLayouts.map((layout) => layout.y));
      const maxX = Math.max(...groupLayouts.map((layout) => layout.x + layout.width));
      const maxY = Math.max(...groupLayouts.map((layout) => layout.y + layout.height));

      return {
        id: group.id,
        name: group.name || `${groupLayouts.length} tiles`,
        color: group.color,
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    name: string;
    color?: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;

  if (boundaries.length === 0) return null;

  return (
    <>
      {boundaries.map((group) => (
        <div
          key={group.id}
          className="group-boundary"
          style={{
            left: group.x,
            top: group.y,
            width: group.width,
            height: group.height,
            borderColor: group.color || undefined,
          }}
        >
          <span className="group-boundary-label">{group.name}</span>
        </div>
      ))}
    </>
  );
}

function SelectionBox({
  start,
  end,
}: {
  start: { x: number; y: number };
  end: { x: number; y: number };
}) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  if (width < 4 && height < 4) return null;

  return (
    <div
      className="selection-box"
      style={{
        left,
        top,
        width,
        height,
      }}
    />
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function formatFileSize(size?: number): string {
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(value?: string): string {
  if (!value) return 'Unknown time';
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs)) return 'Unknown time';
  const diffMinutes = Math.round(diffMs / 60000);
  if (Math.abs(diffMinutes) < 1) return 'Just now';
  if (Math.abs(diffMinutes) < 60) return `${Math.abs(diffMinutes)}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return `${Math.abs(diffHours)}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 7) return `${Math.abs(diffDays)}d ago`;
  return new Date(value).toLocaleDateString();
}

function formatRuntimeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseDelimitedLine(line: string, delimiter = ','): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === delimiter && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function parseCsvPreview(content: string, limit = 50) {
  const lines = content
    .split(/\r?\n/)
    .filter((line, index, source) => line.trim().length > 0 || (index === 0 && source.length === 1));

  if (lines.length === 0) {
    return { headers: [] as string[], rows: [] as string[][], truncated: false };
  }

  const headers = parseDelimitedLine(lines[0]);
  const rows = lines.slice(1, limit + 1).map((line) => parseDelimitedLine(line));
  return {
    headers,
    rows,
    truncated: lines.length > limit + 1,
  };
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function getFileExtension(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : '';
}

function getWorkspaceFilePanelId(filePath: string): string {
  return `file-${filePath.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function canOpenFileInPanel(filePath: string): boolean {
  return /\.(pdf|png|jpe?g|gif|webp|svg|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css|html?)$/i.test(filePath);
}

function canQueryFileInPanel(filePath: string): boolean {
  return /\.(pdf|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css|html?|svg)$/i.test(filePath);
}

function inferWorkspaceFilePanelType(filePath: string): 'pdf' | 'preview' | 'editor' {
  if (/\.pdf$/i.test(filePath)) return 'pdf';
  if (/\.(html?|svg)$/i.test(filePath)) return 'preview';
  return 'editor';
}

function getFileTypeBadge(filePath: string): string {
  const extension = getFileExtension(filePath).replace(/^\./, '');
  if (!extension) return 'FILE';
  if (extension.length <= 4) return extension.toUpperCase();
  return extension.slice(0, 4).toUpperCase();
}

function getFileTileLabel(filePath: string): string {
  const extension = getFileExtension(filePath);
  if (extension === '.pdf') return 'PDF';
  if (extension === '.csv' || extension === '.tsv') return 'CSV File';
  if (extension === '.md' || extension === '.markdown') return 'Markdown File';
  if (extension === '.html' || extension === '.htm') return 'HTML View';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(extension)) return 'Image';
  if (extension === '.json') return 'JSON File';
  if (extension === '.txt') return 'Text File';
  return 'File';
}

function getPanelTitle(panel: WorkspacePanel): string {
  if (panel.title) return panel.title;
  if ('filePath' in panel && panel.filePath) return getFileName(panel.filePath);
  if (panel.type === 'fileTree') return 'Workspace Files';
  return panel.id;
}

function getPanelTypeLabel(panel: WorkspacePanel): string {
  switch (panel.type) {
    case 'markdown':
      return 'Markdown';
    case 'table':
      return 'Table';
    case 'chart':
      return 'Chart';
    case 'cards':
      return 'Cards';
    case 'pdf':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'PDF';
    case 'preview':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'Web View';
    case 'editor':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'File';
    case 'file':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'File';
    case 'detail':
      return 'Detail';
    case 'fileTree':
      return 'Files';
    case 'chat':
      return 'Chat';
    default:
      return 'Panel';
  }
}

function isPanelContextualChatCapable(panel: WorkspacePanel): boolean {
  if (panel.type === 'table' || panel.type === 'chart' || panel.type === 'cards' || panel.type === 'markdown') {
    return true;
  }
  if (panel.type === 'fileTree') return true;
  if (panel.type === 'pdf') return true;
  if (panel.type === 'preview') {
    if (panel.filePath) return canQueryFileInPanel(panel.filePath);
    return !!panel.content;
  }
  if ((panel.type === 'editor' || panel.type === 'file') && 'filePath' in panel && panel.filePath) {
    return canQueryFileInPanel(panel.filePath);
  }
  return false;
}

function canExportPanelSnapshot(panel: WorkspacePanel): boolean {
  if (panel.type === 'table' || panel.type === 'chart' || panel.type === 'cards' || panel.type === 'markdown' || panel.type === 'fileTree') {
    return true;
  }

  if (panel.type === 'preview' && panel.content) {
    return true;
  }

  if ((panel.type === 'preview' || panel.type === 'editor' || panel.type === 'file') && 'filePath' in panel && panel.filePath) {
    return /\.(png|jpe?g|gif|webp|svg|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css)$/i.test(panel.filePath);
  }

  return false;
}

function getPanelDownloadFormats(panel: WorkspacePanel | null): ToolbarDownloadFormat[] {
  if (!panel) return [];

  const formats: ToolbarDownloadFormat[] = [];
  if ('filePath' in panel && panel.filePath) {
    formats.push('file');
  }

  switch (panel.type) {
    case 'table':
      formats.push('csv', 'json');
      break;
    case 'chart':
      formats.push('csv', 'json');
      break;
    case 'cards':
      formats.push('json');
      break;
    case 'markdown':
      formats.push('txt');
      break;
    default:
      break;
  }

  if (canExportPanelSnapshot(panel)) {
    formats.push('png');
  }

  return Array.from(new Set(formats));
}

function escapeCsvCell(value: unknown): string {
  const normalized = String(value ?? '');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function serializeTableAsCsv(panel: Extract<WorkspacePanel, { type: 'table' }>): string {
  const header = panel.columns.map((column) => escapeCsvCell(column.label)).join(',');
  const rows = panel.rows.map((row) =>
    panel.columns.map((column) => escapeCsvCell(row[column.key])).join(',')
  );
  return [header, ...rows].join('\n');
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensureDownloadFilename(filename: string, format: DownloadRequest['format']): string {
  const trimmed = filename.trim() || `download.${format}`;
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.${format}`;
}

function triggerQueuedDownload(download: DownloadRequest) {
  const filename = ensureDownloadFilename(download.filename, download.format);

  if (download.format === 'json') {
    downloadBlob(
      new Blob([JSON.stringify(download.data, null, 2)], { type: 'application/json;charset=utf-8' }),
      filename
    );
    return;
  }

  const content = typeof download.data === 'string'
    ? download.data
    : download.data == null
      ? ''
      : String(download.data);
  const contentType = download.format === 'csv'
    ? 'text/csv;charset=utf-8'
    : 'text/plain;charset=utf-8';
  downloadBlob(new Blob([content], { type: contentType }), filename);
}

function getContextualStatusLabel(status: string, assistantMessage: UIMessage | null): string | null {
  if (status === 'ready') return null;
  if (status === 'submitted') return 'Thinking...';
  if (status === 'error') return null;

  if (assistantMessage && Array.isArray(assistantMessage.parts)) {
    const hasRunningTool = assistantMessage.parts.some((part) =>
      isToolUIPart(part) &&
      part.state !== 'output-available' &&
      part.state !== 'output-error' &&
      part.state !== 'output-denied'
    );
    if (hasRunningTool) return 'Running tools...';
    if (extractMessageText(assistantMessage).trim()) return 'Responding...';
  }

  return 'Thinking...';
}

type FileSource =
  | { kind: 'workspace'; id: string }
  | { kind: 'gallery'; id: string };

function getFileUrl(source: FileSource, filePath: string): string {
  return source.kind === 'workspace'
    ? getWorkspaceFileUrl(source.id, filePath)
    : getGalleryFileUrl(source.id, filePath);
}

function withCacheKey(url: string, cacheKey?: string | null): string {
  if (!cacheKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(cacheKey)}`;
}

function getWorkspaceFileCacheKey(
  workspaceFiles: WorkspaceFileInfo[] | undefined,
  filePath: string
): string | null {
  const file = workspaceFiles?.find((entry) => !entry.isDirectory && entry.path === filePath);
  if (!file) return null;
  return file.etag || file.modifiedAt || file.uploadedAt || (typeof file.size === 'number' ? String(file.size) : null);
}

function FilePreview({
  fileSource,
  panel,
  cacheKey,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'pdf' | 'editor' | 'file' }>;
  cacheKey?: string | null;
}) {
  const url = withCacheKey(getFileUrl(fileSource, panel.filePath), cacheKey);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(panel.filePath);
  const isPdf = panel.type === 'pdf';
  const isHtml = /\.html?$/i.test(panel.filePath);

  if (isImage) {
    return <img key={url} className="panel-image" src={url} alt={panel.title || panel.filePath} />;
  }

  if (isPdf) {
    return <iframe key={url} className="panel-frame" src={url} title={panel.title || panel.filePath} />;
  }

  if (isHtml) {
    return (
      <iframe
        key={url}
        className="panel-frame"
        src={url}
        title={panel.title || panel.filePath}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    );
  }

  if (/\.(md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css)$/i.test(panel.filePath)) {
    return <TextFilePreview url={url} filePath={panel.filePath} />;
  }

  return (
    <div className="panel-file">
      <a href={url} target="_blank" rel="noreferrer">
        Open {panel.filePath}
      </a>
    </div>
  );
}

function PreviewPanelView({
  fileSource,
  panel,
  cacheKey,
}: {
  fileSource: FileSource;
  panel: Extract<WorkspacePanel, { type: 'preview' }>;
  cacheKey?: string | null;
}) {
  if (panel.filePath) {
    return (
      <FilePreview
        fileSource={fileSource}
        panel={{ ...panel, type: 'editor', filePath: panel.filePath }}
        cacheKey={cacheKey}
      />
    );
  }

  if (panel.content) {
    const previewUrl = fileSource.kind === 'workspace'
      ? getWorkspacePanelPreviewUrl(fileSource.id, panel.id)
      : getGalleryPanelPreviewUrl(fileSource.id, panel.id);
    return (
      <iframe
        className="panel-frame"
        src={previewUrl}
        title={panel.title || panel.id}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    );
  }

  return <div className="panel-empty">No preview content yet.</div>;
}

function DetailPanelView({
  panel,
  panels,
}: {
  panel: Extract<WorkspacePanel, { type: 'detail' }>;
  panels: WorkspacePanel[];
}) {
  const linkedPanel = panel.linkedTo
    ? panels.find((candidate) => candidate.id === panel.linkedTo)
    : null;

  if (!panel.linkedTo) {
    return <div className="panel-empty">No linked tile selected for this detail view.</div>;
  }

  if (!linkedPanel || linkedPanel.type !== 'table') {
    return <div className="panel-empty">The linked table for this detail view is unavailable.</div>;
  }

  if (linkedPanel.rows.length === 0) {
    return <div className="panel-empty">The linked table has no rows yet.</div>;
  }

  return (
    <div className="space-y-3 pr-1">
      {linkedPanel.rows.slice(0, 8).map((row, index) => (
        <article key={index} className="rounded-2xl border border-border/70 bg-background/90 p-4 shadow-sm">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Row {index + 1}
          </div>
          <dl className="space-y-2">
            {linkedPanel.columns.map((column) => (
              <div key={column.key} className="grid grid-cols-[minmax(0,140px)_1fr] gap-3 items-start">
                <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {column.label}
                </dt>
                <dd className="text-sm leading-relaxed break-words">
                  {row[column.key] == null || row[column.key] === ''
                    ? <span className="panel-muted">—</span>
                    : String(row[column.key])}
                </dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
      {linkedPanel.rows.length > 8 ? (
        <div className="panel-footnote">Showing the first 8 rows from the linked table.</div>
      ) : null}
    </div>
  );
}

function TablePanelView({ panel }: { panel: Extract<WorkspacePanel, { type: 'table' }> }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const sortedRows = useMemo(() => {
    if (!sortKey) return panel.rows;

    return [...panel.rows].sort((left, right) => {
      const leftValue = left[sortKey];
      const rightValue = right[sortKey];

      if (leftValue == null && rightValue == null) return 0;
      if (leftValue == null) return sortDirection === 'asc' ? 1 : -1;
      if (rightValue == null) return sortDirection === 'asc' ? -1 : 1;

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return sortDirection === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      }

      const leftString = String(leftValue).toLowerCase();
      const rightString = String(rightValue).toLowerCase();
      if (leftString < rightString) return sortDirection === 'asc' ? -1 : 1;
      if (leftString > rightString) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [panel.rows, sortDirection, sortKey]);

  if (panel.rows.length === 0) {
    return <div className="panel-empty">No table rows yet.</div>;
  }

  return (
    <div className="panel-table-wrap">
      <table className="panel-table">
        <thead>
          <tr>
            {panel.columns.map((column) => (
              <th key={column.key}>
                <button
                  className="panel-table-sort"
                  onClick={() => {
                    if (sortKey === column.key) {
                      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
                    } else {
                      setSortKey(column.key);
                      setSortDirection('asc');
                    }
                  }}
                >
                  <span>{column.label}</span>
                  {sortKey === column.key ? (
                    <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>
                  ) : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr key={index}>
              {panel.columns.map((column) => (
                <td key={column.key}>
                  {row[column.key] == null || row[column.key] === ''
                    ? <span className="panel-muted">—</span>
                    : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextFilePreview({ url, filePath }: { url: string; filePath: string }) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const extension = filePath.split('.').pop()?.toLowerCase() || '';

  useEffect(() => {
    let cancelled = false;
    setTextContent(null);
    setLoadError(null);

    fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load file (${response.status})`);
        }
        const text = await response.text();
        if (!cancelled) {
          setTextContent(text);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load file');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (loadError) {
    return <div className="panel-empty">{loadError}</div>;
  }

  if (textContent === null) {
    return <div className="panel-empty">Loading file…</div>;
  }

  if (extension === 'md') {
    return (
      <Suspense fallback={<div className="panel-richtext whitespace-pre-wrap">{textContent}</div>}>
        <LazyMarkdownRenderer
          className="panel-richtext"
          content={textContent}
        />
      </Suspense>
    );
  }

  if (extension === 'csv') {
    const preview = parseCsvPreview(textContent);
    if (preview.headers.length === 0) {
      return <div className="panel-empty">Empty CSV file.</div>;
    }
    return (
      <div className="panel-table-wrap">
        <table className="panel-table">
          <thead>
            <tr>
              {preview.headers.map((header, index) => (
                <th key={`${header}-${index}`}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {preview.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{row[cellIndex] || <span className="panel-muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {preview.truncated ? (
          <div className="panel-footnote">Showing the first 50 rows.</div>
        ) : null}
      </div>
    );
  }

  if (extension === 'json') {
    try {
      return (
        <pre className="panel-code-block">
          {JSON.stringify(JSON.parse(textContent), null, 2)}
        </pre>
      );
    } catch {
      return <pre className="panel-code-block">{textContent}</pre>;
    }
  }

  if (extension === 'yml' || extension === 'yaml' || extension === 'xml' || extension === 'txt' || extension === 'js' || extension === 'ts' || extension === 'tsx' || extension === 'jsx' || extension === 'css') {
    return <pre className="panel-code-block">{textContent}</pre>;
  }

  return <pre className="panel-code-block">{textContent}</pre>;
}

function FileTreePanelView({
  fileSource,
  files,
  highlightedPaths,
  getFileActionLabel,
  onOpenFile,
}: {
  fileSource: FileSource;
  files?: WorkspaceFileInfo[];
  highlightedPaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
}) {
  const entries = useMemo(
    () => [...(files || [])].sort((left, right) => left.path.localeCompare(right.path)),
    [files]
  );

  if (!files) {
    return <div className="panel-empty">File tree data is only available inside editable workspaces.</div>;
  }

  if (entries.length === 0) {
    return <div className="panel-empty">No workspace files yet.</div>;
  }

  return (
    <div className="p-3 space-y-1">
      {entries.map((file) => {
        const depth = Math.max(0, file.path.split('/').length - 1);
        const isHighlighted = highlightedPaths?.has(file.path) ?? false;
        const timestamp = file.modifiedAt ?? file.uploadedAt;
        return (
          <article
            className={cn(
              'rounded-lg border px-3 py-2',
              isHighlighted ? 'border-primary bg-primary/5' : 'border-border/60 bg-background/70'
            )}
            key={file.path}
            style={{ marginLeft: `${depth * 14}px` }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{file.isDirectory ? 'Folder' : 'File'}</span>
                  <span className="truncate text-sm font-medium">{file.name}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground mt-1">{file.path}</p>
              </div>
              {!file.isDirectory ? (
                <div className="flex items-center gap-2">
                  {fileSource.kind === 'workspace' && onOpenFile && canOpenFileInPanel(file.path) ? (
                    <button
                      onClick={() => onOpenFile(file)}
                      className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 transition-colors"
                    >
                      {getFileActionLabel?.(file.path) ?? 'Open'}
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      const anchor = document.createElement('a');
                      anchor.href = getFileUrl(fileSource, file.path);
                      anchor.download = file.name;
                      document.body.append(anchor);
                      anchor.click();
                      anchor.remove();
                    }}
                    className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 transition-colors"
                  >
                    Download File
                  </button>
                </div>
              ) : null}
            </div>
            {!file.isDirectory ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {formatFileSize(file.size)} · {formatRelativeTime(timestamp)}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PanelBody({
  fileSource,
  panel,
  allPanels,
  workspaceFiles,
  highlightedFilePaths,
  getFileActionLabel,
  onOpenFile,
}: {
  fileSource: FileSource;
  panel: WorkspacePanel;
  allPanels: WorkspacePanel[];
  workspaceFiles?: WorkspaceFileInfo[];
  highlightedFilePaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
}) {
  switch (panel.type) {
    case 'markdown':
      return (
        <Suspense fallback={<div className="panel-richtext whitespace-pre-wrap">{panel.content}</div>}>
          <LazyMarkdownRenderer
            className="panel-richtext"
            content={panel.content}
          />
        </Suspense>
      );
    case 'table':
      return <TablePanelView panel={panel} />;
    case 'chart':
      return (
        <Suspense fallback={<div className="panel-empty">Loading chart…</div>}>
          <LazyChartPanelView panel={panel} />
        </Suspense>
      );
    case 'cards':
      return (
        <div className="panel-cards">
          {panel.items.map((item, index) => (
            <article className="panel-card" key={item.id || index}>
              <h4>{item.title}</h4>
              {item.subtitle ? <p>{item.subtitle}</p> : null}
              {item.description ? <span>{item.description}</span> : null}
            </article>
          ))}
        </div>
      );
    case 'pdf':
    case 'editor':
    case 'file':
      return (
        <FilePreview
          fileSource={fileSource}
          panel={panel}
          cacheKey={fileSource.kind === 'workspace' ? getWorkspaceFileCacheKey(workspaceFiles, panel.filePath) : null}
        />
      );
    case 'preview':
      return (
        <PreviewPanelView
          fileSource={fileSource}
          panel={panel}
          cacheKey={fileSource.kind === 'workspace' && panel.filePath
            ? getWorkspaceFileCacheKey(workspaceFiles, panel.filePath)
            : null}
        />
      );
    case 'detail':
      return <DetailPanelView panel={panel} panels={allPanels} />;
    case 'fileTree':
      return (
        <FileTreePanelView
          fileSource={fileSource}
          files={workspaceFiles}
          highlightedPaths={highlightedFilePaths}
          getFileActionLabel={getFileActionLabel}
          onOpenFile={onOpenFile}
        />
      );
    default:
      return <div className="panel-file">Panel type not rendered yet.</div>;
  }
}

function ReadOnlyCanvas({
  galleryId,
  title,
  description,
  state,
}: {
  galleryId: string;
  title: string;
  description: string;
  state: WorkspaceState;
}) {
  const visiblePanels = state.panels.filter((panel) => panel.type !== 'chat');
  const panelLayouts = useMemo(() => buildPanelLayouts(visiblePanels), [visiblePanels]);
  const visiblePanelIds = useMemo(() => new Set(visiblePanels.map((panel) => panel.id)), [visiblePanels]);
  const panelTitles = useMemo(
    () => Object.fromEntries(visiblePanels.map((panel) => [panel.id, getPanelTitle(panel)])),
    [visiblePanels]
  );

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="canvas-header flex items-center gap-4 px-6 py-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-serif text-lg font-medium truncate">{title}</h2>
          <p className="text-sm text-muted-foreground truncate">{description}</p>
        </div>
      </header>

      <div className="canvas-bg flex-1 relative overflow-auto">
        {state.groups.map((group) => (
          <LegacyGroupBoundary
            key={group.id}
            group={group}
            panelLayouts={panelLayouts}
            existingPanelIds={visiblePanelIds}
            visiblePanelIds={visiblePanelIds}
            scale={1}
          />
        ))}
        <LegacyConnectionLines
          panelLayouts={panelLayouts}
          connections={state.connections.filter((connection) => visiblePanelIds.has(connection.sourceId) && visiblePanelIds.has(connection.targetId))}
          panelTitles={panelTitles}
        />
        {visiblePanels.length === 0 ? (
          <div className="canvas-empty">
            <Layout className="canvas-empty-icon" />
            <h3>No Panels</h3>
            <p>This gallery item has no visible panels yet.</p>
          </div>
        ) : null}
        {visiblePanels.map((panel, index) => {
          const layout = panelLayouts[panel.id] ?? inferPanelLayout(panel, index);
          return (
            <article
              key={panel.id}
              className="artifact-card absolute"
              style={{
                left: layout.x,
                top: layout.y,
                width: layout.width,
                height: layout.height,
              }}
            >
              <header className="artifact-header">
                <h3>{panel.title || panel.id}</h3>
                <span className="artifact-type">{panel.type}</span>
              </header>
              <div className="artifact-content">
                <PanelBody fileSource={{ kind: 'gallery', id: galleryId }} panel={panel} allPanels={visiblePanels} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CanvasZoomControls({ zoom, viewportX, viewportY }: { zoom: number; viewportX: number; viewportY: number }) {
  const { instance } = useControls();
  const showReset = Math.abs(zoom - 1) > 0.01 || Math.abs(viewportX) > 1 || Math.abs(viewportY) > 1;

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const { scale, positionX, positionY } = instance.transformState;
    const factor = direction === 'in' ? 1.2 : 1 / 1.2;
    const newScale = Math.min(3, Math.max(0.1, scale * factor));
    // Zoom toward the center of the viewport
    const wrapper = instance.wrapperComponent;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const newX = cx - (cx - positionX) * (newScale / scale);
      const newY = cy - (cy - positionY) * (newScale / scale);
      instance.setTransformState(newScale, newX, newY);
    } else {
      instance.setTransformState(newScale, positionX, positionY);
    }
  }, [instance]);

  return (
    <div className="fixed bottom-4 left-4 z-40 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur">
      <button
        onClick={() => handleZoom('out')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Zoom out"
      >
        <Minus size={14} />
      </button>
      <span className="w-12 text-center font-mono text-xs text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => handleZoom('in')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Zoom in"
      >
        <Plus size={14} />
      </button>
      {showReset ? (
        <button
          onClick={() => instance.setTransformState(1, 0, 0)}
          className="rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Reset viewport"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceShell({
  workspace,
  onWorkspaceRefresh,
  onGoHome,
  onDelete,
  initialPrompt,
  onInitialPromptConsumed,
}: {
  workspace: WorkspaceResponse;
  onWorkspaceRefresh: (workspaceId: string) => Promise<void>;
  onGoHome: () => void;
  onDelete: () => Promise<void>;
  initialPrompt?: string | null;
  onInitialPromptConsumed?: () => void;
}) {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(workspace.state);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileInfo[]>(workspace.files);
  const [composer, setComposer] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(workspace.workspace.name);
  const [workspaceDescription, setWorkspaceDescription] = useState(workspace.workspace.description);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishTitle, setPublishTitle] = useState(workspace.workspace.name);
  const [publishDescription, setPublishDescription] = useState(workspace.workspace.description);
  const [publishing, setPublishing] = useState(false);
  const [downloadingExport, setDownloadingExport] = useState(false);
  const [runtimeCode, setRuntimeCode] = useState('');
  const [runtimeRunning, setRuntimeRunning] = useState(false);
  const [runtimeExecution, setRuntimeExecution] = useState<(WorkspaceRuntimeExecution & {
    code: string;
    executedAt: string;
  }) | null>(null);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1440
  );
  const [chatOpen, setChatOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= 1400 : true
  );
  const [narrowActiveTab, setNarrowActiveTab] = useState<'canvas' | 'chat'>('canvas');
  const [fileShelfCollapsed, setFileShelfCollapsed] = useState(false);
  const [showCanvasHint, setShowCanvasHint] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);
  const [animatingPanelIds, setAnimatingPanelIds] = useState<Set<string>>(new Set());
  const [animatingConnectionIds, setAnimatingConnectionIds] = useState<Set<string>>(new Set());
  const [highlightedFilePaths, setHighlightedFilePaths] = useState<Set<string>>(new Set());
  const [activeFilePillPopover, setActiveFilePillPopover] = useState<string | null>(null);
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<string>>(new Set());
  const [hoveredPanelId, setHoveredPanelId] = useState<string | null>(null);
  const [hoveredToolbarPanelId, setHoveredToolbarPanelId] = useState<string | null>(null);
  const [isSelectingBox, setIsSelectingBox] = useState(false);
  const [spacePanning, setSpacePanning] = useState(false);
  const [selectionBoxStart, setSelectionBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionBoxEnd, setSelectionBoxEnd] = useState<{ x: number; y: number } | null>(null);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [minimizedPanelIds, setMinimizedPanelIds] = useState<Set<string>>(new Set());
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [contextualComposer, setContextualComposer] = useState('');
  const [contextualChatTarget, setContextualChatTarget] = useState<ContextualChatTarget | null>(null);
  const [contextualThreads, setContextualThreads] = useState<Record<string, ContextualThreadMessage[]>>({});
  const [contextualLoading, setContextualLoading] = useState<Record<string, boolean>>({});
  const [contextualStatus, setContextualStatus] = useState<Record<string, string | null>>({});
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const filesSectionRef = useRef<HTMLElement | null>(null);
  const fileCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const workspaceFilesRef = useRef(workspace.files);
  const viewportSaveTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const autoFocusTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const viewportRef = useRef(workspace.state.viewport);
  const panelLayoutsRef = useRef<Record<string, CanvasPanelLayout>>({});
  const panelSourceRef = useRef<Record<string, string>>({});
  const lastLayoutInteractionRef = useRef(Date.now());
  const clearFileHighlightTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoverClearTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoveredPanelIdRef = useRef<string | null>(null);
  const hoveredToolbarPanelIdRef = useRef<string | null>(null);
  const previousDockedChatRef = useRef<boolean | null>(null);
  const selectionPendingRef = useRef<{ x: number; y: number } | null>(null);
  const selectionSuppressClickRef = useRef(false);
  const selectionPointerIdRef = useRef<number | null>(null);
  const pendingAutoFocusRef = useRef<Set<string>>(new Set());
  const previousArtifactIdsRef = useRef<Set<string>>(new Set());
  const previousConnectionIdsRef = useRef<Set<string>>(new Set());
  const contextualAutoPanKeyRef = useRef<string | null>(null);
  const initialPromptSentRef = useRef(false);
  const contextualPendingRef = useRef<{
    scopeKey: string;
    previousAssistantId: string | null;
  } | null>(null);
  const panGestureRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const agent = useAgent<WorkspaceAgentClient, WorkspaceState>({
    agent: workspace.agent.className,
    name: workspace.agent.name,
    onStateUpdate: (state) => {
      setWorkspaceState(state);
    },
  });

  const dumpWorkspaceObservability = useCallback(async (): Promise<WorkspaceObservabilitySnapshot | null> => {
    try {
      const observability = await fetchWorkspaceObservability(workspace.workspace.id);
      console.error('Workspace observability snapshot', observability);
      return observability;
    } catch (observabilityError) {
      console.error('Failed to fetch workspace observability', observabilityError);
      return null;
    }
  }, [workspace.workspace.id]);

  const chat = useAgentChat<WorkspaceState>({
    agent,
    getInitialMessages: async () => workspace.messages,
    body: () => selectedPanelIds.size > 0
      ? { scopePanelIds: Array.from(selectedPanelIds) }
      : {},
    onError: (chatError) => {
      console.error('Workspace chat error', chatError);
      void dumpWorkspaceObservability();
    },
  });

  const clearContextualDraft = useCallback(() => {
    setContextualComposer('');
    contextualPendingRef.current = null;
  }, []);

  const closeContextualChat = useCallback(() => {
    setContextualChatTarget(null);
    clearContextualDraft();
  }, [clearContextualDraft]);

  const openContextualTarget = useCallback((target: ContextualChatTarget) => {
    setContextualChatTarget(target);
    setContextualComposer('');
  }, []);

  const sendChatMessage = useCallback((
    text: string,
    options?: Parameters<typeof chat.sendMessage>[1],
  ) => {
    chat.clearError();
    return chat.sendMessage({ text }, options);
  }, [chat]);

  useEffect(() => {
    setWorkspaceState(workspace.state);
    setWorkspaceFiles(workspace.files);
    workspaceFilesRef.current = workspace.files;
    setWorkspaceName(workspace.workspace.name);
    setWorkspaceDescription(workspace.workspace.description);
    setPublishModalOpen(false);
    setPublishTitle(workspace.workspace.name);
    setPublishDescription(workspace.workspace.description);
    setRuntimeCode('');
    setRuntimeExecution(null);
    setSelectedPanelIds(new Set());
    setHoveredPanelId(null);
    setHoveredToolbarPanelId(null);
    setHighlightedFilePaths(new Set());
    setActiveFilePillPopover(null);
    setToast(null);
    setAnimatingPanelIds(new Set());
    setAnimatingConnectionIds(new Set());
    setIsSelectingBox(false);
    setSelectionBoxStart(null);
    setSelectionBoxEnd(null);
    setFocusedPanelId(null);
    setEditingGroupId(null);
    setGroupNameInput('');
    setDraggingGroupId(null);
    setMinimizedPanelIds(new Set());
    setMaximizedPanelId(null);
    setOpenMenuId(null);
    closeContextualChat();
    setContextualThreads({});
    setContextualLoading({});
    setContextualStatus({});
    selectionPendingRef.current = null;
    selectionSuppressClickRef.current = false;
    selectionPointerIdRef.current = null;
    panGestureRef.current = null;
    panelSourceRef.current = {};
    previousArtifactIdsRef.current = new Set(
      workspace.state.panels.filter((panel) => panel.type !== 'chat').map((panel) => panel.id)
    );
    previousConnectionIdsRef.current = new Set(workspace.state.connections.map((connection) => connection.id));
    contextualAutoPanKeyRef.current = null;
    initialPromptSentRef.current = false;
    viewportRef.current = workspace.state.viewport;
    if (workspace.downloads && workspace.downloads.length > 0) {
      workspace.downloads.forEach((download) => {
        triggerQueuedDownload(download);
      });
      void clearWorkspaceDownloads(workspace.workspace.id);
    }
  }, [closeContextualChat, workspace]);

  const artifactPanels = useMemo(
    () => workspaceState.panels.filter((panel) => panel.type !== 'chat'),
    [workspaceState.panels]
  );
  const existingPanelIds = useMemo(
    () => new Set(artifactPanels.map((panel) => panel.id)),
    [artifactPanels]
  );
  const workspaceFileEntries = useMemo(
    () => workspaceFiles.filter((file) => !file.isDirectory),
    [workspaceFiles]
  );
  const publishablePanelCount = useMemo(
    () => artifactPanels.filter((panel) => panel.type !== 'fileTree' && !('filePath' in panel && panel.filePath)).length,
    [artifactPanels]
  );
  const publishableArtifactCount = publishablePanelCount + workspaceFileEntries.length;
  const getExistingFileTileId = useCallback((filePath: string) => (
    artifactPanels.find((panel) => ('filePath' in panel && panel.filePath === filePath) || panel.id === getWorkspaceFilePanelId(filePath))?.id ?? null
  ), [artifactPanels]);
  const getFileCanvasActionLabel = useCallback((filePath: string) => (
    getExistingFileTileId(filePath)
      ? 'Go to Tile'
      : 'Show on Canvas'
  ), [getExistingFileTileId]);
  const filesTileActionLabel = useMemo(() => (
    artifactPanels.some((panel) => panel.id === 'workspace_files')
      ? 'Go to Files Tile'
      : 'Show Files on Canvas'
  ), [artifactPanels]);
  const visiblePanels = useMemo(
    () => artifactPanels.filter((panel) => !minimizedPanelIds.has(panel.id)),
    [artifactPanels, minimizedPanelIds]
  );
  const visiblePanelIds = useMemo(
    () => new Set(visiblePanels.map((panel) => panel.id)),
    [visiblePanels]
  );
  const panelLayouts = useMemo(() => buildPanelLayouts(visiblePanels), [visiblePanels]);
  const visibleConnections = useMemo(
    () => workspaceState.connections.filter((connection) => visiblePanelIds.has(connection.sourceId) && visiblePanelIds.has(connection.targetId)),
    [visiblePanelIds, workspaceState.connections]
  );
  const panelTitles = useMemo(
    () => Object.fromEntries(visiblePanels.map((panel) => [panel.id, getPanelTitle(panel)])),
    [visiblePanels]
  );
  const selectedPanels = useMemo(
    () => visiblePanels.filter((panel) => selectedPanelIds.has(panel.id)),
    [selectedPanelIds, visiblePanels]
  );
  const singleSelectedPanel = selectedPanels.length === 1 ? selectedPanels[0] : null;
  const selectedGroup = useMemo(
    () =>
      workspaceState.groups.find(
        (group) =>
          group.panelIds.length === selectedPanelIds.size &&
          group.panelIds.every((panelId) => selectedPanelIds.has(panelId))
      ) || null,
    [selectedPanelIds, workspaceState.groups]
  );
  const singleSelectedPanelGroup = useMemo(
    () =>
      singleSelectedPanel
        ? workspaceState.groups.find((group) => group.panelIds.includes(singleSelectedPanel.id)) || null
        : null,
    [singleSelectedPanel, workspaceState.groups]
  );
  const selectedPanelsBounds = useMemo(() => {
    const layouts = selectedPanels
      .map((panel) => panelLayouts[panel.id])
      .filter(Boolean) as CanvasPanelLayout[];
    return getLayoutsBounds(layouts);
  }, [panelLayouts, selectedPanels]);
  const contextualAnchor = useMemo(() => {
    if (!contextualChatTarget) return null;
    const layouts = contextualChatTarget.panelIds
      .map((panelId) => panelLayouts[panelId])
      .filter(Boolean) as CanvasPanelLayout[];
    if (layouts.length === 0) return null;
    if (contextualChatTarget.typeLabel === 'Group') {
      let minX = Infinity;
      let minY = Infinity;
      layouts.forEach((layout) => {
        minX = Math.min(minX, layout.x);
        minY = Math.min(minY, layout.y);
      });
      return { x: minX, y: minY - 20, width: 100, height: 30 };
    }
    return getLayoutsBounds(layouts);
  }, [contextualChatTarget, panelLayouts]);
  const contextualMessages = useMemo(
    () => contextualChatTarget ? (contextualThreads[contextualChatTarget.key] ?? []) : [],
    [contextualChatTarget, contextualThreads]
  );
  const hoveredPanel = useMemo(() => {
    if (selectedPanelIds.size > 0) return null;
    const targetId = hoveredToolbarPanelId ?? hoveredPanelId;
    if (!targetId) return null;
    return visiblePanels.find((panel) => panel.id === targetId) || null;
  }, [hoveredPanelId, hoveredToolbarPanelId, selectedPanelIds, visiblePanels]);
  const hoveredPanelBounds = useMemo(() => {
    if (!hoveredPanel) return null;
    const layout = panelLayouts[hoveredPanel.id];
    if (!layout) return null;
    return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
  }, [hoveredPanel, panelLayouts]);
  const hoveredPanelGroup = useMemo(() => {
    if (!hoveredPanel) return null;
    return workspaceState.groups.find((group) => group.panelIds.includes(hoveredPanel.id)) || null;
  }, [hoveredPanel, workspaceState.groups]);
  const toolbarPanel = selectedPanelIds.size > 0 ? singleSelectedPanel : hoveredPanel;
  const toolbarBounds = selectedPanelIds.size > 0 ? selectedPanelsBounds : hoveredPanelBounds;
  const toolbarPanelIds = selectedPanelIds.size > 0
    ? selectedPanelIds
    : (hoveredPanel ? new Set([hoveredPanel.id]) : new Set<string>());
  const toolbarGroup = selectedPanelIds.size > 0 ? selectedGroup : null;
  const toolbarSinglePanelGroup = selectedPanelIds.size > 0 ? singleSelectedPanelGroup : hoveredPanelGroup;
  const toolbarCanChat = useMemo(() => {
    if (selectedPanelIds.size > 0) {
      return Array.from(selectedPanelIds)
        .map((panelId) => visiblePanels.find((panel) => panel.id === panelId))
        .some((panel) => (panel ? isPanelContextualChatCapable(panel) : false));
    }

    return toolbarPanel ? isPanelContextualChatCapable(toolbarPanel) : false;
  }, [selectedPanelIds, toolbarPanel, visiblePanels]);
  const toolbarDownloadFormats = getPanelDownloadFormats(toolbarPanel);
  const showToolbar = Boolean(toolbarBounds) && (selectedPanelIds.size > 0 || Boolean(hoveredPanel));
  const selectedScopeLabel = useMemo(() => {
    if (selectedPanels.length === 0) return null;
    if (selectedPanels.length === 1) return `Scoped to ${getPanelTitle(selectedPanels[0])}`;
    return `Scoped to ${selectedPanels.length} tiles`;
  }, [selectedPanels]);
  const lastUserMessage = useMemo(
    () => [...chat.messages].reverse().find((message) => message.role === 'user') || null,
    [chat.messages]
  );
  const lastUserPrompt = useMemo(
    () => lastUserMessage ? extractMessageText(lastUserMessage).trim() : '',
    [lastUserMessage]
  );
  const isDockedChatLayout = viewportWidth >= 1400;
  const isDrawerChatLayout = viewportWidth > 0 && !isDockedChatLayout;
  const isCompactHeaderLayout = viewportWidth > 0 && viewportWidth < 1500;
  const hasUnreadAssistant = chat.messages.length > 0 && chat.messages[chat.messages.length - 1]?.role === 'assistant';
  const shouldShowCanvasHint = showCanvasHint && visiblePanels.length > 0 && viewportWidth >= 640;

  useEffect(() => {
    panelLayoutsRef.current = panelLayouts;
  }, [panelLayouts]);

  useEffect(() => {
    const nextIds = new Set(artifactPanels.map((panel) => panel.id));
    const previousIds = previousArtifactIdsRef.current;
    const newPanels = artifactPanels.filter((panel) => !previousIds.has(panel.id));

    if (newPanels.length > 0) {
      newPanels.forEach((panel) => {
        pendingAutoFocusRef.current.add(panel.id);
        if (panel.sourcePanelId) {
          panelSourceRef.current[panel.id] = panel.sourcePanelId;
        }
      });

      setAnimatingPanelIds((current) => {
        const next = new Set(current);
        newPanels.forEach((panel) => next.add(panel.id));
        return next;
      });

      newPanels.forEach((panel) => {
        window.setTimeout(() => {
          setAnimatingPanelIds((current) => {
            if (!current.has(panel.id)) return current;
            const next = new Set(current);
            next.delete(panel.id);
            return next;
          });
        }, 400);
      });
    }

    previousArtifactIdsRef.current = nextIds;
  }, [artifactPanels]);

  useEffect(() => {
    const missingConnections = artifactPanels
      .filter((panel) => panel.sourcePanelId && panel.sourcePanelId !== panel.id)
      .map((panel) => ({
        id: `conn-${panel.sourcePanelId}-${panel.id}`,
        sourceId: panel.sourcePanelId as string,
        targetId: panel.id,
      }))
      .filter(
        (connection) =>
          !workspaceState.connections.some((current) => current.id === connection.id)
      );

    if (missingConnections.length === 0) return;

    const nextConnections = [...workspaceState.connections, ...missingConnections];
    setWorkspaceState((current) => ({
      ...current,
      connections: nextConnections,
    }));
    void agent.call('applyLayoutPatch', [{ connections: nextConnections }]);
  }, [agent, artifactPanels, workspaceState.connections]);

  useEffect(() => {
    const nextIds = new Set(workspaceState.connections.map((connection) => connection.id));
    const previousIds = previousConnectionIdsRef.current;
    const newIds = Array.from(nextIds).filter((connectionId) => !previousIds.has(connectionId));

    if (newIds.length > 0) {
      setAnimatingConnectionIds((current) => {
        const next = new Set(current);
        newIds.forEach((connectionId) => next.add(connectionId));
        return next;
      });

      newIds.forEach((connectionId) => {
        window.setTimeout(() => {
          setAnimatingConnectionIds((current) => {
            if (!current.has(connectionId)) return current;
            const next = new Set(current);
            next.delete(connectionId);
            return next;
          });
        }, 600);
      });
    }

    previousConnectionIdsRef.current = nextIds;
  }, [workspaceState.connections]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (draggingGroupId) return;
      if (Date.now() - lastLayoutInteractionRef.current < 1500) return;
      if (visiblePanelIds.size < 2) return;

      const visibleLayouts: LayoutMap = {};
      visiblePanelIds.forEach((panelId) => {
        const layout = panelLayoutsRef.current[panelId];
        if (layout) {
          visibleLayouts[panelId] = { ...layout };
        }
      });

      if (Object.keys(visibleLayouts).length < 2) return;
      if (!hasOverlappingPanels(visibleLayouts)) return;

      const resolved = resolveCollisions(visibleLayouts, new Set());
      const changed = Object.keys(resolved).some((panelId) => {
        const current = panelLayoutsRef.current[panelId];
        const next = resolved[panelId];
        return !current || current.x !== next.x || current.y !== next.y;
      });

      if (!changed) return;

      panelLayoutsRef.current = {
        ...panelLayoutsRef.current,
        ...resolved,
      };

      setWorkspaceState((current) => ({
        ...current,
        panels: current.panels.map((panel) => {
          const nextLayout = resolved[panel.id];
          if (!nextLayout) return panel;
          return {
            ...panel,
            layout: {
              ...panel.layout,
              ...nextLayout,
            },
          };
        }),
      }));

      void agent.call('applyLayoutPatch', [{ panels: resolved }]);
    }, 3000);

    return () => {
      clearInterval(intervalId);
    };
  }, [agent, draggingGroupId, visiblePanelIds]);

  useEffect(() => {
    if (selectedPanelIds.size > 0) {
      setHoveredPanelId(null);
      setHoveredToolbarPanelId(null);
    }
  }, [selectedPanelIds]);

  useEffect(() => {
    hoveredPanelIdRef.current = hoveredPanelId;
  }, [hoveredPanelId]);

  useEffect(() => {
    hoveredToolbarPanelIdRef.current = hoveredToolbarPanelId;
  }, [hoveredToolbarPanelId]);

  useEffect(() => {
    if (hoveredPanelId && !visiblePanelIds.has(hoveredPanelId)) {
      setHoveredPanelId(null);
    }
    if (hoveredToolbarPanelId && !visiblePanelIds.has(hoveredToolbarPanelId)) {
      setHoveredToolbarPanelId(null);
    }
  }, [hoveredPanelId, hoveredToolbarPanelId, visiblePanelIds]);

  useEffect(() => () => {
    if (hoverClearTimeoutRef.current) {
      clearTimeout(hoverClearTimeoutRef.current);
    }
  }, []);

  useEffect(() => () => {
    if (clearFileHighlightTimeoutRef.current) {
      clearTimeout(clearFileHighlightTimeoutRef.current);
    }
  }, []);

  useEffect(() => () => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
  }, []);

  useEffect(() => () => {
    if (autoFocusTimeoutRef.current) {
      clearTimeout(autoFocusTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const visibleIds = new Set(visiblePanels.map((panel) => panel.id));
    setSelectedPanelIds((current) => {
      const next = new Set(Array.from(current).filter((panelId) => visibleIds.has(panelId)));
      return next.size === current.size ? current : next;
    });
  }, [visiblePanels]);

  useEffect(() => {
    if (focusedPanelId && !visiblePanelIds.has(focusedPanelId)) {
      setFocusedPanelId(null);
    }
  }, [focusedPanelId, visiblePanelIds]);

  useEffect(() => {
    if (!activeFilePillPopover) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-file-pill-popover]') || target?.closest('[data-file-pill-trigger]')) return;
      setActiveFilePillPopover(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [activeFilePillPopover]);

  useEffect(() => {
    if (openMenuId && !visiblePanelIds.has(openMenuId)) {
      setOpenMenuId(null);
    }
  }, [openMenuId, visiblePanelIds]);

  useEffect(() => {
    if (editingGroupId && !workspaceState.groups.some((group) => group.id === editingGroupId)) {
      setEditingGroupId(null);
      setGroupNameInput('');
    }
  }, [editingGroupId, workspaceState.groups]);

  useEffect(() => {
    const artifactIds = new Set(artifactPanels.map((panel) => panel.id));
    setMinimizedPanelIds((current) => {
      const next = new Set(Array.from(current).filter((panelId) => artifactIds.has(panelId)));
      return next.size === current.size ? current : next;
    });
    if (maximizedPanelId && !artifactIds.has(maximizedPanelId)) {
      setMaximizedPanelId(null);
    }
  }, [artifactPanels, maximizedPanelId]);

  useEffect(() => {
    if (!contextualChatTarget) return;
    const visibleIds = new Set(visiblePanels.map((panel) => panel.id));
    if (!contextualChatTarget.panelIds.every((panelId) => visibleIds.has(panelId))) {
      closeContextualChat();
    }
  }, [closeContextualChat, contextualChatTarget, visiblePanels]);

  useEffect(() => {
    viewportRef.current = workspaceState.viewport;
  }, [workspaceState.viewport]);

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth);
    }

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const dismissed = window.localStorage.getItem('canvas-hint-dismissed');
    if (dismissed === 'true') {
      setShowCanvasHint(false);
    }
  }, []);

  useEffect(() => {
    if (viewportWidth === 0) return;

    const previousDocked = previousDockedChatRef.current;
    if (previousDocked === null) {
      previousDockedChatRef.current = isDockedChatLayout;
      setChatOpen(isDockedChatLayout);
      return;
    }

    if (previousDocked !== isDockedChatLayout) {
      previousDockedChatRef.current = isDockedChatLayout;
      setChatOpen(isDockedChatLayout);
    }
  }, [isDockedChatLayout, viewportWidth]);

  useEffect(() => () => {
    if (viewportSaveTimeoutRef.current) {
      clearTimeout(viewportSaveTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.panel-menu') || target?.closest('.panel-menu-trigger')) return;
      setOpenMenuId(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openMenuId]);

  useEffect(() => {
    if (!publishModalOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !publishing) {
        setPublishModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [publishModalOpen, publishing]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
        return;
      }
      if (event.code === 'Space' && !event.repeat) {
        setSpacePanning(true);
        event.preventDefault();
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') {
        setSpacePanning(false);
        event.preventDefault();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const getViewportRelativePoint = useCallback((clientX: number, clientY: number) => {
    const rect = canvasViewportRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const releaseCanvasPointerCapture = useCallback((pointerId?: number) => {
    const id = pointerId ?? selectionPointerIdRef.current ?? panGestureRef.current?.pointerId;
    if (id == null) return;

    const element = canvasViewportRef.current;
    if (element && element.hasPointerCapture(id)) {
      element.releasePointerCapture(id);
    }

    if (selectionPointerIdRef.current === id) {
      selectionPointerIdRef.current = null;
    }
    if (panGestureRef.current?.pointerId === id) {
      panGestureRef.current = null;
    }
  }, []);

  const persistViewport = useCallback((viewport: WorkspaceState['viewport']) => {
    if (viewportSaveTimeoutRef.current) {
      clearTimeout(viewportSaveTimeoutRef.current);
    }
    viewportSaveTimeoutRef.current = window.setTimeout(() => {
      void agent.call('applyLayoutPatch', [{ viewport }]);
    }, 180);
  }, [agent]);

  const updateViewport = useCallback((updater: WorkspaceState['viewport'] | ((current: WorkspaceState['viewport']) => WorkspaceState['viewport'])) => {
    setWorkspaceState((current) => {
      const nextViewport = typeof updater === 'function'
        ? updater(current.viewport)
        : updater;
      viewportRef.current = nextViewport;
      persistViewport(nextViewport);
      return {
        ...current,
        viewport: nextViewport,
      };
    });
  }, [persistViewport]);

  const focusCanvasBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    if (!canvasViewportRef.current) return;
    const viewportWidth = canvasViewportRef.current.clientWidth;
    const viewportHeight = canvasViewportRef.current.clientHeight;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    updateViewport((current) => ({
      ...current,
      x: viewportWidth / 2 - centerX * current.zoom,
      y: viewportHeight / 2 - centerY * current.zoom,
    }));
  }, [updateViewport]);

  useEffect(() => {
    if (!contextualChatTarget) {
      contextualAutoPanKeyRef.current = null;
      return;
    }

    if (contextualAutoPanKeyRef.current === contextualChatTarget.key) return;

    const layouts = contextualChatTarget.panelIds
      .map((panelId) => panelLayouts[panelId])
      .filter(Boolean) as CanvasPanelLayout[];
    const bounds = getLayoutsBounds(layouts);
    if (!bounds) return;

    contextualAutoPanKeyRef.current = contextualChatTarget.key;
    focusCanvasBounds(bounds);
  }, [contextualChatTarget, focusCanvasBounds, panelLayouts]);

  const selectPanel = useCallback((panelId: string, additive: boolean) => {
    setSelectedPanelIds((current) => {
      if (!additive) {
        if (current.size === 1 && current.has(panelId)) return current;
        return new Set([panelId]);
      }
      const next = new Set(current);
      if (next.has(panelId)) {
        next.delete(panelId);
      } else {
        next.add(panelId);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPanelIds(new Set());
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'info' = 'success') => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }

    setToast({ message, type });
    toastTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3000);
  }, []);

  const consumeDownloads = useCallback((downloads?: DownloadRequest[]) => {
    if (!downloads || downloads.length === 0) return;
    downloads.forEach((download) => {
      triggerQueuedDownload(download);
    });
  }, []);

  const drainWorkspaceDownloads = useCallback(async () => {
    const downloads = await fetchWorkspaceDownloads(workspace.workspace.id);
    if (downloads.length === 0) return;
    consumeDownloads(downloads);
    await clearWorkspaceDownloads(workspace.workspace.id);
  }, [consumeDownloads, workspace.workspace.id]);

  const focusTile = useCallback((panelId: string) => {
    setMinimizedPanelIds((current) => {
      if (!current.has(panelId)) return current;
      const next = new Set(current);
      next.delete(panelId);
      return next;
    });
    setFocusedPanelId(panelId);
    setSelectedPanelIds(new Set([panelId]));

    const panelIndex = artifactPanels.findIndex((panel) => panel.id === panelId);
    if (panelIndex < 0 || !canvasViewportRef.current) return;
    const panel = artifactPanels[panelIndex];
    const layout = inferPanelLayout(panel, panelIndex);
    const viewportWidth = canvasViewportRef.current.clientWidth;
    const viewportHeight = canvasViewportRef.current.clientHeight;
    const panelCenterX = layout.x + layout.width / 2;
    const panelCenterY = layout.y + layout.height / 2;

    updateViewport((current) => ({
      ...current,
      x: viewportWidth / 2 - panelCenterX * current.zoom,
      y: viewportHeight / 2 - panelCenterY * current.zoom,
    }));
  }, [artifactPanels, updateViewport]);

  const highlightWorkspaceFiles = useCallback((paths: string[], options?: { scroll?: boolean }) => {
    const uniquePaths = Array.from(new Set(paths)).filter(Boolean);
    if (uniquePaths.length === 0) return;

    setFileShelfCollapsed(false);
    setHighlightedFilePaths(new Set(uniquePaths));

    if (clearFileHighlightTimeoutRef.current) {
      clearTimeout(clearFileHighlightTimeoutRef.current);
    }
    clearFileHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedFilePaths(new Set());
    }, 4000);

    if (options?.scroll === false) return;

    filesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    requestAnimationFrame(() => {
      fileCardRefs.current[uniquePaths[0]]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    });
  }, []);

  const refreshWorkspaceFiles = useCallback(async (options?: { announceChanges?: boolean; scrollToChanged?: boolean }) => {
    const files = await fetchWorkspaceFiles(workspace.workspace.id);
    const previousFiles = workspaceFilesRef.current.filter((file) => !file.isDirectory);
    const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
    const nextFileEntries = files.filter((file) => !file.isDirectory);
    const createdPaths: string[] = [];
    const updatedPaths: string[] = [];

    for (const file of nextFileEntries) {
      const previous = previousByPath.get(file.path);
      if (!previous) {
        createdPaths.push(file.path);
        continue;
      }

      if (
        previous.size !== file.size ||
        previous.uploadedAt !== file.uploadedAt ||
        previous.etag !== file.etag
      ) {
        updatedPaths.push(file.path);
      }
    }

    setWorkspaceFiles(files);
    workspaceFilesRef.current = files;

    setHighlightedFilePaths((current) => {
      const validPaths = new Set(nextFileEntries.map((file) => file.path));
      const next = new Set(Array.from(current).filter((filePath) => validPaths.has(filePath)));
      return next.size === current.size ? current : next;
    });
    setActiveFilePillPopover((current) =>
      current && !nextFileEntries.some((file) => file.path === current) ? null : current
    );

    if (
      !options?.announceChanges ||
      (createdPaths.length === 0 && updatedPaths.length === 0)
    ) {
      return files;
    }

    const changedPaths = [...createdPaths, ...updatedPaths].slice(0, 6);
    highlightWorkspaceFiles(changedPaths, { scroll: options.scrollToChanged ?? false });

    const createdLabel = createdPaths.length > 0
      ? `created ${createdPaths.length} file${createdPaths.length !== 1 ? 's' : ''}`
      : '';
    const updatedLabel = updatedPaths.length > 0
      ? `updated ${updatedPaths.length} file${updatedPaths.length !== 1 ? 's' : ''}`
      : '';
    const summary = [createdLabel, updatedLabel].filter(Boolean).join(' and ');

    showToast(
      changedPaths.length === 1
        ? `${getFileName(changedPaths[0])} is ready in Workspace Files.`
        : `The agent ${summary}.`
    );

    return files;
  }, [highlightWorkspaceFiles, showToast, workspace.workspace.id]);

  useEffect(() => {
    if (chat.status !== 'ready') return;

    void (async () => {
      await refreshWorkspaceFiles({ announceChanges: true, scrollToChanged: false });
      await drainWorkspaceDownloads();
    })().catch(() => {
      // Ignore background refresh failures in the shell.
    });
  }, [chat.status, drainWorkspaceDownloads, refreshWorkspaceFiles]);

  useEffect(() => {
    if (!initialPrompt || initialPromptSentRef.current) return;
    if (chat.status !== 'ready') return;
    if (chat.messages.some((message) => message.role === 'user' || message.role === 'assistant')) {
      initialPromptSentRef.current = true;
      onInitialPromptConsumed?.();
      return;
    }

    initialPromptSentRef.current = true;
    void sendChatMessage(initialPrompt);
    onInitialPromptConsumed?.();
  }, [chat, initialPrompt, onInitialPromptConsumed, sendChatMessage]);

  const revealFileInWorkspace = useCallback((filePath: string) => {
    setActiveFilePillPopover(null);
    highlightWorkspaceFiles([filePath]);
  }, [highlightWorkspaceFiles]);

  const openContextualChatForPanel = useCallback((panelId: string) => {
    const panel = visiblePanels.find((entry) => entry.id === panelId);
    if (!panel) return;
    if (!isPanelContextualChatCapable(panel)) return;

    const targetKey = `panel:${panel.id}`;
    if (contextualChatTarget?.key === targetKey) {
      closeContextualChat();
      return;
    }

    openContextualTarget({
      key: targetKey,
      panelIds: [panel.id],
      title: getPanelTitle(panel),
      typeLabel: getPanelTypeLabel(panel),
    });
  }, [closeContextualChat, contextualChatTarget, openContextualTarget, visiblePanels]);

  const handleGroupClick = useCallback((groupId: string) => {
    const group = workspaceState.groups.find((entry) => entry.id === groupId);
    if (!group) return;
    setSelectedPanelIds(new Set(group.panelIds.filter((panelId) => visiblePanelIds.has(panelId))));
  }, [visiblePanelIds, workspaceState.groups]);

  const refreshWorkspace = useCallback(async () => {
    await onWorkspaceRefresh(workspace.workspace.id);
  }, [onWorkspaceRefresh, workspace.workspace.id]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await uploadWorkspaceFiles(workspace.workspace.id, files);
      await refreshWorkspaceFiles();
      showToast(`Uploaded ${files.length} file${files.length !== 1 ? 's' : ''}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [refreshWorkspaceFiles, showToast, workspace.workspace.id]);

  const openFileOnCanvas = useCallback(async (file: WorkspaceFileInfo) => {
    highlightWorkspaceFiles([file.path], { scroll: false });

    if (!canOpenFileInPanel(file.path)) {
      const anchor = document.createElement('a');
      anchor.href = getWorkspaceFileUrl(workspace.workspace.id, file.path);
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return;
    }

    const existingPanelId = getExistingFileTileId(file.path);
    if (existingPanelId) {
      focusTile(existingPanelId);
      return;
    }

    const panelType = inferWorkspaceFilePanelType(file.path);
    const panelId = getWorkspaceFilePanelId(file.path);
    await agent.call('addPanel', [{
      id: panelId,
      type: panelType,
      title: file.name,
      filePath: file.path,
    }]);
    setSelectedPanelIds(new Set([panelId]));
  }, [agent, focusTile, getExistingFileTileId, highlightWorkspaceFiles, workspace.workspace.id]);

  const openFilesPanel = useCallback(async () => {
    const existing = artifactPanels.find((panel) => panel.id === 'workspace_files');
    if (existing) {
      focusTile(existing.id);
      return;
    }

    await agent.call('addPanel', [{
      id: 'workspace_files',
      type: 'fileTree',
      title: 'Workspace Files',
    }]);
    setSelectedPanelIds(new Set(['workspace_files']));
  }, [agent, artifactPanels, focusTile]);

  const removePanel = useCallback(async (panelId: string) => {
    await agent.call('removePanel', [panelId]);
  }, [agent]);

  const saveGroups = useCallback(async (groups: WorkspaceState['groups']) => {
    setWorkspaceState((current) => ({
      ...current,
      groups,
    }));
    await agent.call('applyLayoutPatch', [{ groups }]);
  }, [agent]);

  const savePanelLayouts = useCallback(async (layouts: Record<string, { x: number; y: number; width?: number; height?: number }>) => {
    setWorkspaceState((current) => {
      let changed = false;
      const panels = current.panels.map((panel) => {
        const nextLayout = layouts[panel.id];
        if (!nextLayout) return panel;
        const mergedLayout = {
          ...panel.layout,
          ...nextLayout,
        };
        if (
          panel.layout?.x === mergedLayout.x &&
          panel.layout?.y === mergedLayout.y &&
          panel.layout?.width === mergedLayout.width &&
          panel.layout?.height === mergedLayout.height
        ) {
          return panel;
        }
        changed = true;
        return {
          ...panel,
          layout: mergedLayout,
        };
      });
      return changed ? { ...current, panels } : current;
    });
    await agent.call('applyLayoutPatch', [{ panels: layouts }]);
  }, [agent]);

  useEffect(() => {
    const gap = PANEL_GAP;
    const occupiedRects: CanvasPanelLayout[] = [];
    const addedLayouts: Record<string, { x: number; y: number; width: number; height: number }> = {};

    const overlaps = (x: number, y: number, width: number, height: number) =>
      occupiedRects.some((rect) => !(
        x + width + gap <= rect.x ||
        rect.x + rect.width + gap <= x ||
        y + height + gap <= rect.y ||
        rect.y + rect.height + gap <= y
      ));

    const findPosition = (width: number, height: number) => {
      const startX = 32;
      const startY = 32;

      if (occupiedRects.length === 0) {
        return { x: startX, y: startY };
      }

      for (let y = startY; y <= 4000; y += 48) {
        for (let x = startX; x <= 4000; x += 48) {
          if (!overlaps(x, y, width, height)) {
            return { x, y };
          }
        }
      }

      return {
        x: startX,
        y: Math.max(...occupiedRects.map((rect) => rect.y + rect.height), 0) + gap,
      };
    };

    visiblePanels.forEach((panel) => {
      if (panel.layout?.x === undefined || panel.layout?.y === undefined) return;
      const layout = panelLayouts[panel.id];
      if (!layout) return;
      occupiedRects.push(layout);
    });

    visiblePanels.forEach((panel) => {
      if (
        panel.layout?.x !== undefined &&
        panel.layout?.y !== undefined &&
        panel.layout?.width !== undefined &&
        panel.layout?.height !== undefined
      ) {
        return;
      }

      const defaultLayout = panelLayouts[panel.id];
      if (!defaultLayout) return;

      const width = defaultLayout.width;
      const height = defaultLayout.height;
      const sourceId = panel.sourcePanelId ?? panelSourceRef.current[panel.id];
      const sourceLayout = sourceId
        ? addedLayouts[sourceId] ?? panelLayouts[sourceId] ?? panelLayoutsRef.current[sourceId]
        : null;

      let x: number;
      let y: number;

      if (sourceLayout) {
        x = sourceLayout.x + sourceLayout.width + gap;
        y = sourceLayout.y;

        if (overlaps(x, y, width, height)) {
          x = sourceLayout.x;
          y = sourceLayout.y + sourceLayout.height + gap;

          if (overlaps(x, y, width, height)) {
            const position = findPosition(width, height);
            x = position.x;
            y = position.y;
          }
        }

        delete panelSourceRef.current[panel.id];
      } else {
        const position = findPosition(width, height);
        x = position.x;
        y = position.y;
      }

      const nextLayout = { x, y, width, height };
      addedLayouts[panel.id] = nextLayout;
      occupiedRects.push(nextLayout);
    });

    if (Object.keys(addedLayouts).length > 0) {
      void savePanelLayouts(addedLayouts);
    }
  }, [panelLayouts, savePanelLayouts, visiblePanels]);

  useEffect(() => {
    if (pendingAutoFocusRef.current.size === 0) return;
    if (!canvasViewportRef.current) return;

    if (autoFocusTimeoutRef.current) {
      clearTimeout(autoFocusTimeoutRef.current);
    }

    autoFocusTimeoutRef.current = window.setTimeout(() => {
      autoFocusTimeoutRef.current = null;
      const pendingIds = Array.from(pendingAutoFocusRef.current);
      if (pendingIds.length === 0) return;

      const readyLayouts = pendingIds
        .map((panelId) => panelLayouts[panelId])
        .filter(Boolean) as CanvasPanelLayout[];
      const missingIds = pendingIds.filter((panelId) => !panelLayouts[panelId]);

      pendingAutoFocusRef.current = new Set(missingIds);
      if (readyLayouts.length === 0) return;

      const bounds = getLayoutsBounds(readyLayouts);
      if (!bounds) return;
      focusCanvasBounds(bounds);
    }, 120);
  }, [focusCanvasBounds, panelLayouts]);

  const renameGroup = useCallback(async (groupId: string, newName: string) => {
    const trimmedName = newName.trim();
    const nextGroups = workspaceState.groups.map((group) =>
      group.id === groupId
        ? { ...group, name: trimmedName || undefined }
        : group
    );
    setEditingGroupId(null);
    setGroupNameInput('');
    await saveGroups(nextGroups);
    if (trimmedName) {
      showToast(`Group renamed to "${trimmedName}"`);
    }
  }, [saveGroups, showToast, workspaceState.groups]);

  const handlePanelLayoutChange = useCallback((panelId: string, layout: Partial<CanvasPanelLayout>) => {
    lastLayoutInteractionRef.current = Date.now();
    setWorkspaceState((current) => {
      const nextPanels = current.panels.map((panel, index) => {
        if (panel.id !== panelId) return panel;
        const baseLayout = panelLayoutsRef.current[panelId] ?? inferPanelLayout(panel, index);
        const nextLayout = { ...baseLayout, ...layout };
        panelLayoutsRef.current = {
          ...panelLayoutsRef.current,
          [panelId]: nextLayout,
        };
        return {
          ...panel,
          layout: nextLayout,
        };
      });
      return {
        ...current,
        panels: nextPanels,
      };
    });
  }, []);

  const handlePanelDragStart = useCallback((panelId: string) => {
    setFocusedPanelId(panelId);
  }, []);

  const handlePanelDragEnd = useCallback(async (panelId: string) => {
    const fixedPanelIds = new Set([panelId].filter((visiblePanelId) => visiblePanelIds.has(visiblePanelId)));
    const resolved = resolveVisibleLayoutCollisions(panelLayoutsRef.current, visiblePanelIds, fixedPanelIds);
    if (!resolved[panelId]) return;

    panelLayoutsRef.current = {
      ...panelLayoutsRef.current,
      ...resolved,
    };

    let nextGroups = workspaceState.groups;
    const movedLayout = resolved[panelId];

    if (movedLayout) {
      const currentGroup = workspaceState.groups.find((group) => group.panelIds.includes(panelId));
      let leaveGroupId: string | null = null;
      let joinGroupId: string | null = null;

      if (currentGroup) {
        const bounds = getGroupBounds(currentGroup, resolved, 100, panelId);
        if (bounds && !layoutOverlapsBounds(movedLayout, bounds)) {
          leaveGroupId = currentGroup.id;
        }
      }

      if (leaveGroupId || !currentGroup) {
        for (const group of workspaceState.groups) {
          if (group.id === currentGroup?.id) continue;
          const bounds = getGroupBounds(group, resolved, 16, panelId);
          if (bounds && layoutOverlapsBounds(movedLayout, bounds)) {
            joinGroupId = group.id;
            break;
          }
        }
      }

      if (leaveGroupId || joinGroupId) {
        nextGroups = workspaceState.groups
          .map((group) =>
            group.id === leaveGroupId
              ? { ...group, panelIds: group.panelIds.filter((groupPanelId) => groupPanelId !== panelId) }
              : group
          )
          .filter((group) => group.panelIds.length >= 2)
          .map((group) =>
            group.id === joinGroupId && !group.panelIds.includes(panelId)
              ? { ...group, panelIds: [...group.panelIds, panelId] }
              : group
          );
      }
    }

    await savePanelLayouts(resolved);
    if (nextGroups !== workspaceState.groups) {
      await saveGroups(nextGroups);
    }
  }, [saveGroups, savePanelLayouts, visiblePanelIds, workspaceState.groups]);

  const handleGroupDrag = useCallback((groupId: string, dx: number, dy: number) => {
    const group = workspaceState.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    setDraggingGroupId(groupId);
    lastLayoutInteractionRef.current = Date.now();
    const groupPanelIds = new Set(group.panelIds);

    setWorkspaceState((current) => {
      const nextLayouts = { ...panelLayoutsRef.current };
      const nextPanels = current.panels.map((panel, index) => {
        if (!groupPanelIds.has(panel.id)) return panel;
        const baseLayout = nextLayouts[panel.id] ?? inferPanelLayout(panel, index);
        const nextLayout = {
          ...baseLayout,
          x: baseLayout.x + dx,
          y: baseLayout.y + dy,
        };
        nextLayouts[panel.id] = nextLayout;
        return {
          ...panel,
          layout: nextLayout,
        };
      });
      panelLayoutsRef.current = nextLayouts;
      return {
        ...current,
        panels: nextPanels,
      };
    });
  }, [workspaceState.groups]);

  const handleGroupDragEnd = useCallback(async (groupId: string) => {
    setDraggingGroupId(null);
    const group = workspaceState.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    const fixedPanelIds = new Set(group.panelIds.filter((panelId) => visiblePanelIds.has(panelId)));
    const resolved = resolveVisibleLayoutCollisions(panelLayoutsRef.current, visiblePanelIds, fixedPanelIds);

    panelLayoutsRef.current = {
      ...panelLayoutsRef.current,
      ...resolved,
    };

    if (Object.keys(resolved).length > 0) {
      await savePanelLayouts(resolved);
    }
  }, [savePanelLayouts, visiblePanelIds, workspaceState.groups]);

  const removePanels = useCallback(async (panelIds: string[]) => {
    for (const panelId of panelIds) {
      await removePanel(panelId);
    }
  }, [removePanel]);

  const minimizePanels = useCallback((panelIds: string[]) => {
    if (panelIds.length === 0) return;
    const panelIdSet = new Set(panelIds);
    setMinimizedPanelIds((current) => {
      const next = new Set(current);
      panelIds.forEach((panelId) => next.add(panelId));
      return next;
    });
    setSelectedPanelIds((current) => new Set(Array.from(current).filter((panelId) => !panelIdSet.has(panelId))));
    setContextualChatTarget((current) => {
      if (!current) return null;
      return current.panelIds.some((panelId) => panelIdSet.has(panelId)) ? null : current;
    });
    clearContextualDraft();
    if (maximizedPanelId && panelIdSet.has(maximizedPanelId)) {
      setMaximizedPanelId(null);
    }
  }, [clearContextualDraft, maximizedPanelId]);

  const restorePanel = useCallback((panelId: string) => {
    setMinimizedPanelIds((current) => {
      if (!current.has(panelId)) return current;
      const next = new Set(current);
      next.delete(panelId);
      return next;
    });
  }, []);

  const restoreAllPanels = useCallback(() => {
    setMinimizedPanelIds(new Set());
  }, []);

  const createGroup = useCallback(async () => {
    if (selectedPanelIds.size < 2) return;
    const groupIds = Array.from(selectedPanelIds);
    const selectedSet = new Set(groupIds);

    const selectedLayouts = groupIds
      .map((panelId) => ({ id: panelId, layout: panelLayouts[panelId] }))
      .filter((entry): entry is { id: string; layout: CanvasPanelLayout } => Boolean(entry.layout));

    if (selectedLayouts.length >= 2) {
      let centerX = 0;
      let centerY = 0;

      selectedLayouts.forEach(({ layout }) => {
        centerX += layout.x + layout.width / 2;
        centerY += layout.y + layout.height / 2;
      });

      centerX /= selectedLayouts.length;
      centerY /= selectedLayouts.length;

      const rectsOverlap = (left: CanvasPanelLayout, right: CanvasPanelLayout, gap = 16) => !(
        left.x + left.width + gap <= right.x ||
        right.x + right.width + gap <= left.x ||
        left.y + left.height + gap <= right.y ||
        right.y + right.height + gap <= left.y
      );

      const pullFactors = [0.25, 0.15, 0.08, 0];
      let finalLayouts: Record<string, CanvasPanelLayout> | null = null;

      for (const pullFactor of pullFactors) {
        const testLayouts: Record<string, CanvasPanelLayout> = {};

        selectedLayouts.forEach(({ id, layout }) => {
          const panelCenterX = layout.x + layout.width / 2;
          const panelCenterY = layout.y + layout.height / 2;
          const dx = centerX - panelCenterX;
          const dy = centerY - panelCenterY;

          testLayouts[id] = {
            ...layout,
            x: layout.x + dx * pullFactor,
            y: layout.y + dy * pullFactor,
          };
        });

        let hasOverlap = false;
        const ids = Object.keys(testLayouts);
        outer: for (let index = 0; index < ids.length; index += 1) {
          for (let nextIndex = index + 1; nextIndex < ids.length; nextIndex += 1) {
            if (rectsOverlap(testLayouts[ids[index]], testLayouts[ids[nextIndex]])) {
              hasOverlap = true;
              break outer;
            }
          }
        }

        if (!hasOverlap) {
          finalLayouts = testLayouts;
          break;
        }
      }

      if (finalLayouts) {
        lastLayoutInteractionRef.current = Date.now();
        await savePanelLayouts(finalLayouts);
      }
    }

    const nextGroups = [
      ...workspaceState.groups
        .map((group) => ({
          ...group,
          panelIds: group.panelIds.filter((panelId) => !selectedSet.has(panelId)),
        }))
        .filter((group) => group.panelIds.length >= 2),
      {
        id: makeClientId('group'),
        name: `${groupIds.length} tiles`,
        panelIds: groupIds,
        color: ['#a47430', '#4c78a8', '#2d8f6f', '#9b5dc4'][workspaceState.groups.length % 4],
      },
    ];
    await saveGroups(nextGroups);
    showToast(`Grouped ${groupIds.length} tiles`);
  }, [saveGroups, selectedPanelIds, showToast, workspaceState.groups]);

  const ungroupSelection = useCallback(async () => {
    if (!selectedGroup) return;
    const groupName = selectedGroup.name || `${selectedGroup.panelIds.length} tiles`;
    await saveGroups(workspaceState.groups.filter((group) => group.id !== selectedGroup.id));
    showToast(`Ungrouped "${groupName}"`);
  }, [saveGroups, selectedGroup, showToast, workspaceState.groups]);

  const detachSelectedPanel = useCallback(async () => {
    if (!singleSelectedPanel || !singleSelectedPanelGroup) return;
    const nextGroups = workspaceState.groups.flatMap((group) => {
      if (group.id !== singleSelectedPanelGroup.id) return [group];
      const panelIds = group.panelIds.filter((panelId) => panelId !== singleSelectedPanel.id);
      return panelIds.length >= 2
        ? [{ ...group, panelIds }]
        : [];
    });
    await saveGroups(nextGroups);
    clearSelection();
  }, [clearSelection, saveGroups, singleSelectedPanel, singleSelectedPanelGroup, workspaceState.groups]);

  const removePanelFromGroup = useCallback(async (panelId: string) => {
    const currentGroup = workspaceState.groups.find((group) => group.panelIds.includes(panelId));
    if (!currentGroup) return;

    const nextGroups = workspaceState.groups.flatMap((group) => {
      if (group.id !== currentGroup.id) return [group];
      const panelIds = group.panelIds.filter((groupPanelId) => groupPanelId !== panelId);
      return panelIds.length >= 2
        ? [{ ...group, panelIds }]
        : [];
    });

    await saveGroups(nextGroups);
    setSelectedPanelIds((current) => new Set(Array.from(current).filter((selectedId) => selectedId !== panelId)));
    showToast('Removed from group');
  }, [saveGroups, showToast, workspaceState.groups]);

  const alignSelected = useCallback(async (mode: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => {
    if (selectedPanels.length < 2) return;
    const layouts = selectedPanels
      .map((panel) => ({ id: panel.id, layout: panelLayouts[panel.id] }))
      .filter((entry): entry is { id: string; layout: CanvasPanelLayout } => Boolean(entry.layout));
    if (layouts.length < 2) return;

    const minX = Math.min(...layouts.map((entry) => entry.layout.x));
    const maxX = Math.max(...layouts.map((entry) => entry.layout.x + entry.layout.width));
    const minY = Math.min(...layouts.map((entry) => entry.layout.y));
    const maxY = Math.max(...layouts.map((entry) => entry.layout.y + entry.layout.height));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const updates: Record<string, { x: number; y: number; width: number; height: number }> = {};
    layouts.forEach(({ id, layout }) => {
      let nextX = layout.x;
      let nextY = layout.y;
      if (mode === 'left') nextX = minX;
      if (mode === 'right') nextX = maxX - layout.width;
      if (mode === 'centerX') nextX = Math.round(centerX - layout.width / 2);
      if (mode === 'top') nextY = minY;
      if (mode === 'bottom') nextY = maxY - layout.height;
      if (mode === 'centerY') nextY = Math.round(centerY - layout.height / 2);

      updates[id] = {
        x: nextX,
        y: nextY,
        width: layout.width,
        height: layout.height,
      };
    });

    await savePanelLayouts(updates);
  }, [panelLayouts, savePanelLayouts, selectedPanels]);

  const distributeSelected = useCallback(async (axis: 'horizontal' | 'vertical') => {
    if (selectedPanels.length < 3) return;
    const layouts = selectedPanels
      .map((panel) => ({ id: panel.id, layout: panelLayouts[panel.id] }))
      .filter((entry): entry is { id: string; layout: CanvasPanelLayout } => Boolean(entry.layout));
    if (layouts.length < 3) return;

    const sorted = [...layouts].sort((left, right) => {
      const leftCenter = axis === 'horizontal'
        ? left.layout.x + left.layout.width / 2
        : left.layout.y + left.layout.height / 2;
      const rightCenter = axis === 'horizontal'
        ? right.layout.x + right.layout.width / 2
        : right.layout.y + right.layout.height / 2;
      return leftCenter - rightCenter;
    });

    const first = sorted[0].layout;
    const last = sorted[sorted.length - 1].layout;
    const start = axis === 'horizontal'
      ? first.x + first.width / 2
      : first.y + first.height / 2;
    const end = axis === 'horizontal'
      ? last.x + last.width / 2
      : last.y + last.height / 2;
    const step = (end - start) / (sorted.length - 1);

    const updates: Record<string, { x: number; y: number; width: number; height: number }> = {};
    sorted.forEach(({ id, layout }, index) => {
      if (index === 0 || index === sorted.length - 1) return;
      if (axis === 'horizontal') {
        updates[id] = {
          x: Math.round(start + step * index - layout.width / 2),
          y: layout.y,
          width: layout.width,
          height: layout.height,
        };
      } else {
        updates[id] = {
          x: layout.x,
          y: Math.round(start + step * index - layout.height / 2),
          width: layout.width,
          height: layout.height,
        };
      }
    });

    if (Object.keys(updates).length > 0) {
      await savePanelLayouts(updates);
    }
  }, [panelLayouts, savePanelLayouts, selectedPanels]);

  const openContextualChat = useCallback(() => {
    if (selectedGroup) {
      openContextualTarget({
        key: `group:${selectedGroup.id}`,
        panelIds: selectedGroup.panelIds,
        title: selectedGroup.name || `${selectedGroup.panelIds.length} tiles`,
        typeLabel: 'Group',
      });
      return;
    }

    if (selectedPanels.length === 1) {
      const panel = selectedPanels[0];
      openContextualTarget({
        key: `panel:${panel.id}`,
        panelIds: [panel.id],
        title: getPanelTitle(panel),
        typeLabel: getPanelTypeLabel(panel),
      });
      return;
    }

    if (selectedPanels.length > 1) {
      const panelIds = selectedPanels.map((panel) => panel.id).sort();
      openContextualTarget({
        key: `selection:${panelIds.join('|')}`,
        panelIds,
        title: `${panelIds.length} selected tiles`,
        typeLabel: 'Selection',
      });
    }
  }, [openContextualTarget, selectedGroup, selectedPanels]);

  const handlePanelClick = useCallback((panelId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (selectionSuppressClickRef.current) return;
    selectPanel(panelId, event.metaKey || event.ctrlKey || event.shiftKey);
  }, [selectPanel]);

  const handlePanelDoubleClick = useCallback((panelId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (selectionSuppressClickRef.current) return;
    clearSelection();
    openContextualChatForPanel(panelId);
  }, [clearSelection, openContextualChatForPanel]);

  const handleContextualSubmit = useCallback(() => {
    const next = contextualComposer.trim();
    if (!contextualChatTarget || !next) return;

    const previousAssistantId = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'assistant')?.id || null;

    setContextualThreads((current) => ({
      ...current,
      [contextualChatTarget.key]: [
        ...(current[contextualChatTarget.key] || []),
        {
          id: makeClientId('context-user'),
          role: 'user',
          content: next,
        },
      ],
    }));
    contextualPendingRef.current = {
      scopeKey: contextualChatTarget.key,
      previousAssistantId,
    };
    setContextualLoading((current) => ({
      ...current,
      [contextualChatTarget.key]: true,
    }));
    setContextualStatus((current) => ({
      ...current,
      [contextualChatTarget.key]: 'Thinking...',
    }));
    void sendChatMessage(next, {
      body: { scopePanelIds: contextualChatTarget.panelIds },
    });
    setContextualComposer('');
  }, [contextualChatTarget, contextualComposer, sendChatMessage]);

  const handleChatClear = useCallback(() => {
    chat.clearHistory();
    chat.clearError();
  }, [chat]);

  const handleChatRetry = useCallback(() => {
    if ('regenerate' in chat && typeof chat.regenerate === 'function') {
      chat.clearError();
      void chat.regenerate();
      return;
    }

    if (!lastUserPrompt) return;
    void sendChatMessage(lastUserPrompt);
  }, [chat, lastUserPrompt, sendChatMessage]);

  const downloadPanelAsPng = useCallback(async (panelId: string, title: string) => {
    const element = panelRefs.current[panelId];
    if (!element) {
      setError('Tile not found');
      return;
    }

    try {
      const backgroundColor = getComputedStyle(document.body).backgroundColor || '#ffffff';
      const dataUrl = await toPng(element, {
        backgroundColor,
        pixelRatio: 2,
        cacheBust: true,
        skipFonts: true,
        filter: (node) => {
          if (node instanceof Element) {
            const tagName = node.tagName?.toLowerCase();
            if (tagName === 'link' || tagName === 'style' || tagName === 'script') return false;
          }
          return true;
        },
      });
      const link = document.createElement('a');
      const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      link.download = `${safeTitle}.png`;
      link.href = dataUrl;
      link.click();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to export tile image');
    }
  }, []);

  const handlePanelDownload = useCallback((panel: WorkspacePanel, format: ToolbarDownloadFormat) => {
    if (format === 'png') {
      void downloadPanelAsPng(panel.id, getPanelTitle(panel));
      return;
    }

    const baseName = getPanelTitle(panel)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'panel';

    if (format === 'file' && 'filePath' in panel && panel.filePath) {
      const anchor = document.createElement('a');
      anchor.href = getWorkspaceFileUrl(workspace.workspace.id, panel.filePath);
      anchor.download = getFileName(panel.filePath);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return;
    }

    if (format === 'csv' && panel.type === 'table') {
      downloadBlob(new Blob([serializeTableAsCsv(panel)], { type: 'text/csv;charset=utf-8' }), `${baseName}.csv`);
      return;
    }

    if (format === 'csv' && panel.type === 'chart') {
      const rows = panel.data;
      if (rows.length === 0) return;
      const keys = Array.from(rows.reduce((set, row) => {
        Object.keys(row).forEach((key) => set.add(key));
        return set;
      }, new Set<string>()));
      const header = keys.map((key) => escapeCsvCell(key)).join(',');
      const body = rows.map((row) => keys.map((key) => escapeCsvCell(row[key])).join(','));
      downloadBlob(new Blob([[header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' }), `${baseName}.csv`);
      return;
    }

    if (format === 'json') {
      const payload =
        panel.type === 'table'
          ? panel.rows
          : panel.type === 'chart'
            ? panel.data
            : panel.type === 'cards'
              ? panel.items
              : null;
      if (payload) {
        downloadBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
          `${baseName}.json`
        );
      }
      return;
    }

    if (format === 'txt' && panel.type === 'markdown') {
      downloadBlob(new Blob([panel.content], { type: 'text/plain;charset=utf-8' }), `${baseName}.md`);
    }
  }, [downloadPanelAsPng, workspace.workspace.id]);

  const renderPanelMenuContent = useCallback((panel: WorkspacePanel) => (
    <>
      <button
        onClick={() => {
          openContextualChatForPanel(panel.id);
          setOpenMenuId(null);
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Ask About This Tile
      </button>
      {'filePath' in panel && panel.filePath ? (
        (() => {
          const filePath = panel.filePath;
          return (
        <>
          <button
            onClick={() => {
              revealFileInWorkspace(filePath);
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Show in Workspace Files
          </button>
          <button
            onClick={() => {
              handlePanelDownload(panel, 'file');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Download File
          </button>
          <button
            onClick={() => {
              window.open(getWorkspaceFileUrl(workspace.workspace.id, filePath), '_blank', 'noopener,noreferrer');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Open in New Tab
          </button>
        </>
          );
        })()
      ) : null}
      {panel.type === 'table' ? (
        <>
          <button
            onClick={() => {
              handlePanelDownload(panel, 'csv');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as CSV
          </button>
          <button
            onClick={() => {
              handlePanelDownload(panel, 'json');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'chart' ? (
        <>
          <button
            onClick={() => {
              handlePanelDownload(panel, 'csv');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as CSV
          </button>
          <button
            onClick={() => {
              handlePanelDownload(panel, 'json');
              setOpenMenuId(null);
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'cards' ? (
        <button
          onClick={() => {
            handlePanelDownload(panel, 'json');
            setOpenMenuId(null);
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Export Data as JSON
        </button>
      ) : null}
      {panel.type === 'markdown' ? (
        <button
          onClick={() => {
            handlePanelDownload(panel, 'txt');
            setOpenMenuId(null);
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Export Markdown (.md)
        </button>
      ) : null}
      {panel.type === 'preview' && panel.content && !panel.filePath ? (
        <button
          onClick={() => {
            const safeTitle = getPanelTitle(panel).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'preview';
            downloadBlob(new Blob([panel.content || ''], { type: 'text/html;charset=utf-8' }), `${safeTitle}.html`);
            setOpenMenuId(null);
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Download HTML Source
        </button>
      ) : null}
      {canExportPanelSnapshot(panel) ? (
        <button
          onClick={() => {
            handlePanelDownload(panel, 'png');
            setOpenMenuId(null);
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Save Snapshot as PNG
        </button>
      ) : null}
      <button
        onClick={() => {
          setMinimizedPanelIds((current) => new Set(current).add(panel.id));
          setSelectedPanelIds((current) => new Set(Array.from(current).filter((panelId) => panelId !== panel.id)));
          setContextualChatTarget((current) => {
            if (!current) return null;
            return current.panelIds.includes(panel.id) ? null : current;
          });
          clearContextualDraft();
          if (maximizedPanelId === panel.id) {
            setMaximizedPanelId(null);
          }
          setOpenMenuId(null);
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Minimize
      </button>
      <button
        onClick={() => {
          setMaximizedPanelId(panel.id);
          setOpenMenuId(null);
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Maximize
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={() => {
          void removePanel(panel.id);
          setOpenMenuId(null);
        }}
        className="w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
      >
        Remove
      </button>
    </>
  ), [
    handlePanelDownload,
    maximizedPanelId,
    openContextualChatForPanel,
    revealFileInWorkspace,
    removePanel,
    workspace.workspace.id,
  ]);

  const handleWorkspaceSave = useCallback(async () => {
    setSavingWorkspace(true);
    setError(null);
    try {
      await updateWorkspace(workspace.workspace.id, {
        name: workspaceName.trim() || workspace.workspace.name,
        description: workspaceDescription,
      });
      await refreshWorkspace();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to save workspace');
    } finally {
      setSavingWorkspace(false);
    }
  }, [refreshWorkspace, workspace.workspace.id, workspace.workspace.name, workspaceDescription, workspaceName]);

  const handleFileDelete = useCallback(async (file: WorkspaceFileInfo) => {
    setError(null);
    try {
      await deleteWorkspaceFile(workspace.workspace.id, file.path);
      await refreshWorkspaceFiles();
      showToast(`Deleted ${getFileName(file.path)}`, 'info');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete file');
    }
  }, [refreshWorkspaceFiles, showToast, workspace.workspace.id]);

  const handlePublish = useCallback(async () => {
    const nextTitle = workspaceName.trim() || publishTitle.trim();
    const nextDescription = workspaceDescription.trim() || publishDescription.trim();
    if (!nextTitle || !nextDescription) return;
    setPublishing(true);
    setError(null);
    try {
      await publishWorkspace(workspace.workspace.id, {
        title: nextTitle,
        description: nextDescription,
      });
      setPublishModalOpen(false);
      await refreshWorkspace();
      showToast('Published to gallery');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to publish workspace');
    } finally {
      setPublishing(false);
    }
  }, [publishDescription, publishTitle, refreshWorkspace, showToast, workspace.workspace.id, workspaceDescription, workspaceName]);

  const handleUnpublish = useCallback(async () => {
    if (!workspace.workspace.galleryId) return;
    setPublishing(true);
    setError(null);
    try {
      await unpublishGalleryItem(workspace.workspace.galleryId);
      await refreshWorkspace();
      showToast('Removed from gallery', 'info');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to unpublish workspace');
    } finally {
      setPublishing(false);
    }
  }, [refreshWorkspace, showToast, workspace.workspace.galleryId]);

  const handleExportDownload = useCallback(async () => {
    setDownloadingExport(true);
    setError(null);
    try {
      const { blob, filename } = await fetchWorkspaceExport(workspace.workspace.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to export workspace');
    } finally {
      setDownloadingExport(false);
    }
  }, [workspace.workspace.id]);

  const handleRuntimeExecute = useCallback(async () => {
    const code = runtimeCode.trim();
    if (!code || runtimeRunning) return;

    setRuntimeRunning(true);
    try {
      const execution = await executeWorkspaceRuntime(workspace.workspace.id, code);
      setRuntimeExecution({
        ...execution,
        code,
        executedAt: new Date().toISOString(),
      });
      await refreshWorkspaceFiles({ announceChanges: true, scrollToChanged: false });
      await drainWorkspaceDownloads();
    } catch (nextError) {
      setRuntimeExecution({
        result: undefined,
        error: nextError instanceof Error ? nextError.message : 'Runtime execution failed',
        logs: [],
        code,
        executedAt: new Date().toISOString(),
      });
    } finally {
      setRuntimeRunning(false);
    }
  }, [drainWorkspaceDownloads, refreshWorkspaceFiles, runtimeCode, runtimeRunning, workspace.workspace.id]);

  useEffect(() => {
    const pending = contextualPendingRef.current;
    if (!pending) return;

    const assistantMessage = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'assistant') || null;

    if (chat.status === 'error') {
      setContextualThreads((current) => {
        const thread = current[pending.scopeKey] || [];
        const lastMessage = thread[thread.length - 1];
        if (lastMessage?.role === 'assistant' && lastMessage.content === 'Sorry, there was an error processing your request.') {
          return current;
        }

        return {
          ...current,
          [pending.scopeKey]: [
            ...thread,
            {
              id: makeClientId('context-assistant'),
              role: 'assistant',
              content: 'Sorry, there was an error processing your request.',
            },
          ],
        };
      });
      setContextualLoading((current) => ({ ...current, [pending.scopeKey]: false }));
      setContextualStatus((current) => ({ ...current, [pending.scopeKey]: null }));
      contextualPendingRef.current = null;
      return;
    }

    setContextualLoading((current) => ({ ...current, [pending.scopeKey]: chat.status !== 'ready' }));
    setContextualStatus((current) => ({
      ...current,
      [pending.scopeKey]: getContextualStatusLabel(chat.status, assistantMessage),
    }));

    if (chat.status === 'ready' && (!assistantMessage || assistantMessage.id === pending.previousAssistantId)) {
      contextualPendingRef.current = null;
    }
  }, [chat.messages, chat.status]);

  useEffect(() => {
    const pending = contextualPendingRef.current;
    if (!pending) return;

    const assistantMessage = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'assistant');

    if (!assistantMessage || assistantMessage.id === pending.previousAssistantId) {
      return;
    }

    const content = extractMessageText(assistantMessage);
    if (!content.trim() && chat.status !== 'ready') return;

    setContextualThreads((current) => {
      const thread = current[pending.scopeKey] || [];
      const existingIndex = thread.findIndex((message) => message.id === assistantMessage.id);

      if (existingIndex >= 0) {
        const next = [...thread];
        next[existingIndex] = {
          ...next[existingIndex],
          content,
        };
        return {
          ...current,
          [pending.scopeKey]: next,
        };
      }

      return {
        ...current,
        [pending.scopeKey]: [
          ...thread,
          {
            id: assistantMessage.id,
            role: 'assistant',
            content,
          },
        ],
      };
    });

    if (chat.status === 'ready') {
      setContextualLoading((current) => ({ ...current, [pending.scopeKey]: false }));
      setContextualStatus((current) => ({ ...current, [pending.scopeKey]: null }));
      contextualPendingRef.current = null;
    }
  }, [chat.messages, chat.status]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
        return;
      }

      if (event.key === 'Escape') {
        if (maximizedPanelId) {
          setMaximizedPanelId(null);
          return;
        }
        if (contextualChatTarget) {
          closeContextualChat();
          return;
        }
        if (selectedPanelIds.size > 0) {
          clearSelection();
        }
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPanelIds.size > 0) {
        event.preventDefault();
        const panelIds = Array.from(selectedPanelIds);
        clearSelection();
        void removePanels(panelIds);
        return;
      }

      const isMeta = event.metaKey || event.ctrlKey;
      if (isMeta && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) {
          void ungroupSelection();
        } else {
          void createGroup();
        }
        return;
      }

      let dx = 0;
      let dy = 0;
      const step = event.shiftKey ? 20 : 5;
      if (event.key === 'ArrowLeft') dx = -step;
      if (event.key === 'ArrowRight') dx = step;
      if (event.key === 'ArrowUp') dy = -step;
      if (event.key === 'ArrowDown') dy = step;

      if ((dx !== 0 || dy !== 0) && selectedPanelIds.size > 0) {
        event.preventDefault();
        const updates: Record<string, { x: number; y: number; width: number; height: number }> = {};
        selectedPanelIds.forEach((panelId) => {
          const layout = panelLayouts[panelId];
          if (!layout) return;
          updates[panelId] = {
            x: layout.x + dx,
            y: layout.y + dy,
            width: layout.width,
            height: layout.height,
          };
        });
        if (Object.keys(updates).length > 0) {
          void savePanelLayouts(updates);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    clearSelection,
    closeContextualChat,
    contextualChatTarget,
    createGroup,
    maximizedPanelId,
    panelLayouts,
    removePanels,
    savePanelLayouts,
    selectedPanelIds,
    ungroupSelection,
  ]);

  const handleCanvasWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.artifact-content')) return;
    event.preventDefault();
    const relative = getViewportRelativePoint(event.clientX, event.clientY);
    if (!relative) return;

    const viewport = viewportRef.current;
    const nextZoom = clampNumber(
      event.deltaY < 0 ? viewport.zoom * 1.1 : viewport.zoom / 1.1,
      0.35,
      2.5
    );
    const canvasX = (relative.x - viewport.x) / viewport.zoom;
    const canvasY = (relative.y - viewport.y) / viewport.zoom;

    updateViewport({
      x: relative.x - canvasX * nextZoom,
      y: relative.y - canvasY * nextZoom,
      zoom: nextZoom,
    });
  }, [getViewportRelativePoint, updateViewport]);

  const handleCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only handle left mouse button for selection
    if (event.button !== 0) return;

    // If space-panning, let TransformWrapper handle it
    if (spacePanning) return;

    const target = event.target as HTMLElement;
    if (target.closest('.contextual-chat-popover')) return;
    if (target.closest('.group-boundary')) return;
    if (target.closest('button')) return;
    if (target.closest('.fixed')) return;
    if (target.closest('input')) return;
    if (target.closest('textarea')) return;
    if (target.closest('.panel-menu') || target.closest('.panel-menu-trigger')) return;

    const isPanel = Boolean(target.closest('.artifact-card'));

    closeContextualChat();

    const relative = getViewportRelativePoint(event.clientX, event.clientY);
    if (!relative) return;

    if (isPanel) {
      if (target.closest('.artifact-header') || target.closest('.resize-handle')) return;
      selectionPendingRef.current = { x: relative.x, y: relative.y };
      return;
    }

    event.stopPropagation();
    if (canvasViewportRef.current) {
      canvasViewportRef.current.setPointerCapture(event.pointerId);
      selectionPointerIdRef.current = event.pointerId;
    }
    selectionPendingRef.current = null;
    setIsSelectingBox(true);
    setSelectionBoxStart(relative);
    setSelectionBoxEnd(relative);
  }, [closeContextualChat, getViewportRelativePoint, spacePanning]);

  const handleCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {

    const relative = getViewportRelativePoint(event.clientX, event.clientY);
    if (!relative) return;

    if (isSelectingBox && selectionBoxStart) {
      event.preventDefault();
      setSelectionBoxEnd(relative);
      return;
    }

    const pending = selectionPendingRef.current;
    if (!pending) return;

    const dx = relative.x - pending.x;
    const dy = relative.y - pending.y;
    if (Math.hypot(dx, dy) < 6) return;

    selectionPendingRef.current = null;
    if (canvasViewportRef.current) {
      canvasViewportRef.current.setPointerCapture(event.pointerId);
      selectionPointerIdRef.current = event.pointerId;
    }
    setIsSelectingBox(true);
    setSelectionBoxStart({ x: pending.x, y: pending.y });
    setSelectionBoxEnd(relative);
  }, [getViewportRelativePoint, isSelectingBox, selectionBoxStart]);

  const handleCanvasPointerUp = useCallback((event?: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
    const pointerId = event && 'pointerId' in event ? event.pointerId : undefined;

    if (selectionPendingRef.current && !isSelectingBox) {
      selectionPendingRef.current = null;
      releaseCanvasPointerCapture(pointerId);
      return;
    }

    releaseCanvasPointerCapture(pointerId);

    if (!isSelectingBox || !selectionBoxStart || !selectionBoxEnd) {
      setIsSelectingBox(false);
      setSelectionBoxStart(null);
      setSelectionBoxEnd(null);
      selectionPendingRef.current = null;
      return;
    }

    const width = Math.abs(selectionBoxEnd.x - selectionBoxStart.x);
    const height = Math.abs(selectionBoxEnd.y - selectionBoxStart.y);
    const viewport = viewportRef.current;
    const left = (Math.min(selectionBoxStart.x, selectionBoxEnd.x) - viewport.x) / viewport.zoom;
    const top = (Math.min(selectionBoxStart.y, selectionBoxEnd.y) - viewport.y) / viewport.zoom;
    const right = (Math.max(selectionBoxStart.x, selectionBoxEnd.x) - viewport.x) / viewport.zoom;
    const bottom = (Math.max(selectionBoxStart.y, selectionBoxEnd.y) - viewport.y) / viewport.zoom;
    const isDragSelection = width > 10 && height > 10;

    if (isDragSelection) {
      const hits = visiblePanels
        .filter((panel) => {
          const layout = panelLayouts[panel.id];
          if (!layout) return false;
          return !(
            layout.x + layout.width < left ||
            layout.x > right ||
            layout.y + layout.height < top ||
            layout.y > bottom
          );
        })
        .map((panel) => panel.id);

      setSelectedPanelIds(new Set(hits));
    } else {
      clearSelection();
    }

    setIsSelectingBox(false);
    setSelectionBoxStart(null);
    setSelectionBoxEnd(null);
    selectionPendingRef.current = null;

    if (isDragSelection) {
      selectionSuppressClickRef.current = true;
      window.setTimeout(() => {
        selectionSuppressClickRef.current = false;
      }, 0);
    }
  }, [
    clearSelection,
    isSelectingBox,
    panelLayouts,
    releaseCanvasPointerCapture,
    selectionBoxEnd,
    selectionBoxStart,
    visiblePanels,
  ]);

  useEffect(() => {
    if (!isSelectingBox) return;

    const onWindowPointerUp = (event: PointerEvent) => {
      handleCanvasPointerUp(event);
    };

    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  }, [handleCanvasPointerUp, isSelectingBox]);

  const handleResetViewport = useCallback(() => {
    updateViewport({ x: 0, y: 0, zoom: 1 });
  }, [updateViewport]);

  const canvasViewportSize = canvasViewportRef.current
    ? {
      width: canvasViewportRef.current.clientWidth,
      height: canvasViewportRef.current.clientHeight,
    }
    : null;
  const minimizedPanels = artifactPanels.filter((panel) => minimizedPanelIds.has(panel.id));
  const maximizedPanel = maximizedPanelId
    ? artifactPanels.find((panel) => panel.id === maximizedPanelId) || null
    : null;
  const chatPanelContent = (
    <section className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h3 className="font-serif text-sm font-medium flex items-center gap-2">
          <MessageSquare size={14} className="text-accent" />Chat
        </h3>
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded',
            chat.status === 'ready'
              ? 'text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400'
              : chat.status === 'error'
                ? 'text-destructive bg-destructive/10'
                : 'text-accent bg-accent/10'
          )}>{chat.status}</span>
          <button className="text-xs text-muted-foreground hover:text-foreground transition-colors" onClick={handleChatClear}>Clear</button>
        </div>
      </div>
      {selectedScopeLabel ? (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-accent/20 text-xs">
          <span className="text-accent font-medium">{selectedScopeLabel}</span>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={clearSelection}>Clear Scope</button>
        </div>
      ) : null}
      {chat.status === 'error' ? (
        <div className="border-b border-destructive/20 bg-destructive/8 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">The last response failed before it finished.</p>
              <p className="text-xs text-muted-foreground">
                Retry the last turn or clear the thread and continue.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => {
                  void dumpWorkspaceObservability();
                }}
              >
                Dump Trace
              </button>
              <button
                className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleChatRetry}
                disabled={!lastUserPrompt}
              >
                Retry
              </button>
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleChatClear}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {chat.messages.map((message) => {
          if (message.role === 'user') {
            return (
              <article key={message.id} className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm p-3 self-end">
                <pre className="whitespace-pre-wrap font-sans text-sm">{extractMessageText(message)}</pre>
              </article>
            );
          }
          const textParts: string[] = [];
          const toolParts = Array.isArray(message.parts)
            ? message.parts
              .filter(isToolUIPart)
              .map((part) => ({
                name: getToolName(part),
                state: part.state,
              }))
            : [];
          if (Array.isArray(message.parts)) {
            for (const part of message.parts) {
              if (isTextUIPart(part) && part.text) {
                textParts.push(part.text);
              }
            }
          }
          return (
            <article key={message.id} className="max-w-[90%] self-start space-y-2">
              {toolParts.length > 0 && (
                <div className="rounded-2xl border border-border/60 bg-card/80 px-3 py-2">
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Tool Activity
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                  {toolParts.map((tool, index) => (
                    <span
                      key={`${message.id}-${tool.name}-${index}`}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono border',
                        tool.state === 'output-error' || tool.state === 'output-denied'
                          ? 'bg-destructive/10 text-destructive border border-destructive/20'
                          : tool.state === 'output-available'
                            ? 'bg-accent/10 text-accent border-accent/20'
                            : 'bg-secondary text-secondary-foreground border-border'
                      )}
                    >
                      {tool.name.replace(/^(ui_|tool_)/, '')}
                      <span className="opacity-60">{tool.state}</span>
                    </span>
                  ))}
                  </div>
                </div>
              )}
              {textParts.length > 0 && (
                <div className="bg-secondary text-secondary-foreground rounded-2xl rounded-bl-sm p-3">
                  <Suspense fallback={<div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{textParts.join('\n')}</div>}>
                    <LazyMarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={textParts.join('\n')}
                    />
                  </Suspense>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <form
        className="flex gap-2 p-3 border-t border-border"
        onSubmit={(event) => {
          event.preventDefault();
          const next = composer.trim();
          if (!next) return;
          void sendChatMessage(next);
          setComposer('');
        }}
      >
        <textarea
          className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm resize-none focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all placeholder:text-muted-foreground"
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          placeholder={selectedScopeLabel ? 'Ask about the selected tile scope.' : 'Ask the agent to create files and panels.'}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              const next = composer.trim();
              if (!next) return;
              void sendChatMessage(next);
              setComposer('');
            }
          }}
        />
        <button className="bg-primary text-primary-foreground rounded-xl px-3 py-2 hover:opacity-90 transition-opacity self-end" type="submit">
          <Send size={16} />
        </button>
      </form>
    </section>
  );

  const fileShelf = (
    <section ref={filesSectionRef} className="flex-shrink-0 border-b border-border/50 bg-card/60 backdrop-blur-sm overflow-visible relative z-10">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <button
          onClick={() => setFileShelfCollapsed((current) => !current)}
          className="flex items-center gap-2 text-xs font-medium text-foreground/70 hover:text-foreground transition-colors"
        >
          <svg className={`w-3 h-3 transition-transform duration-200 ${fileShelfCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
          <span>Files</span>
          {workspaceFileEntries.length > 0 ? (
            <span className="text-[10px] text-foreground/50 tabular-nums">{workspaceFileEntries.length}</span>
          ) : null}
        </button>
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-primary/80 hover:text-primary transition-colors cursor-pointer">
            {uploading ? 'Uploading…' : 'Upload'}
            <input
              className="hidden"
              type="file"
              multiple
              onChange={(event) => {
                void handleUpload(event.target.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button
            onClick={() => void openFilesPanel()}
            className="text-[11px] font-medium text-primary/80 hover:text-primary transition-colors"
          >
            {filesTileActionLabel}
          </button>
        </div>
      </div>
      {!fileShelfCollapsed ? (
        <div className="px-4 pb-2.5">
          {workspaceFileEntries.length === 0 ? (
            <p className="text-[11px] text-foreground/40 italic">No files yet</p>
          ) : (
            <div className="flex gap-1.5 flex-wrap">
              {workspaceFileEntries.map((file) => (
                <div
                  key={file.path}
                  ref={(node) => {
                    fileCardRefs.current[file.path] = node;
                  }}
                  className="relative"
                >
                  <button
                    type="button"
                    data-file-pill-trigger
                    onClick={() => setActiveFilePillPopover((current) => current === file.path ? null : file.path)}
                    className={cn(
                      'flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] transition-all hover:bg-muted/80',
                      highlightedFilePaths.has(file.path)
                        ? 'border-primary/40 bg-primary/5 text-foreground shadow-sm shadow-primary/10'
                        : 'border-border/50 bg-background/80 text-foreground/80',
                      activeFilePillPopover === file.path && 'ring-1 ring-primary/30'
                    )}
                    title={`${file.name} (${formatFileSize(file.size)})`}
                  >
                    <span className="text-[10px] leading-none opacity-60">{getFileTypeBadge(file.path)}</span>
                    <span className="font-medium truncate max-w-[160px]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px' }}>
                      {getFileName(file.path)}
                    </span>
                    <span className="text-foreground/35 tabular-nums" style={{ fontSize: '10px' }}>
                      {formatFileSize(file.size)}
                    </span>
                    {highlightedFilePaths.has(file.path) ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                    ) : null}
                  </button>
                  {activeFilePillPopover === file.path ? (
                    <div
                      data-file-pill-popover
                      className="absolute top-full left-0 z-50 mt-1 flex gap-1 rounded-lg border border-border/70 bg-card p-1 shadow-lg"
                    >
                      {canOpenFileInPanel(file.path) ? (
                        <button
                          onClick={() => {
                            void openFileOnCanvas(file);
                            setActiveFilePillPopover(null);
                          }}
                          className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 hover:bg-muted transition-colors"
                        >
                          {getFileCanvasActionLabel(file.path)}
                        </button>
                      ) : null}
                      <button
                        onClick={() => {
                          const anchor = document.createElement('a');
                          anchor.href = getWorkspaceFileUrl(workspace.workspace.id, file.path);
                          anchor.download = file.name;
                          document.body.append(anchor);
                          anchor.click();
                          anchor.remove();
                          setActiveFilePillPopover(null);
                        }}
                        className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 hover:bg-muted transition-colors"
                      >
                        Download
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );

  return (
    <div className="flex-1 flex min-h-0">
      <div className={`flex-1 min-w-0 flex flex-col transition-[margin] duration-300 ${chatOpen && isDockedChatLayout ? 'mr-[400px]' : ''} ${isDrawerChatLayout && narrowActiveTab !== 'canvas' ? 'hidden' : ''}`}>
        <header className="canvas-header flex items-center gap-4 px-6 py-3">
          <button
            onClick={onGoHome}
            className="shrink-0 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Back to home"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <input
              className="font-serif text-lg font-medium bg-transparent border-none outline-none w-full text-foreground placeholder:text-muted-foreground"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
            />
            <textarea
              className="text-sm text-muted-foreground bg-transparent border-none outline-none w-full resize-none placeholder:text-muted-foreground"
              value={workspaceDescription}
              onChange={(event) => setWorkspaceDescription(event.target.value)}
              placeholder="Describe this workspace."
              rows={1}
            />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground font-mono mr-2">
              {workspaceState.panels.filter((p) => p.type !== 'chat').length}T · {workspaceFileEntries.length}F
            </span>
            <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={refreshWorkspace} title="Refresh">
              <RotateCcw size={16} />
            </button>
            {!isCompactHeaderLayout ? (
              workspace.workspace.galleryId ? (
                <button
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  onClick={() => void handleUnpublish()}
                  disabled={publishing}
                >
                  {publishing ? 'Updating…' : 'Unpublish'}
                </button>
              ) : publishableArtifactCount > 0 ? (
                <button
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  onClick={() => setPublishModalOpen(true)}
                  disabled={publishing}
                >
                  Publish
                </button>
              ) : null
            ) : null}
            <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => void handleExportDownload()} title="Export">
              <Download size={16} />
            </button>
            <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => void onDelete()} title="Delete workspace">
              <Trash2 size={16} />
            </button>
            <button className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity" onClick={() => void handleWorkspaceSave()}>
              {savingWorkspace ? 'Saving…' : 'Save'}
            </button>
            <ThemeToggle />
            {isDockedChatLayout ? (
              <button
                onClick={() => setChatOpen((current) => !current)}
                className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title={chatOpen ? 'Hide chat' : 'Show chat'}
              >
                <MessageSquare size={16} />
              </button>
            ) : null}
          </div>
        </header>

        {error ? (
          <div className="px-6 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive animate-fade-in">
            {error}
          </div>
        ) : null}

        {isDrawerChatLayout ? (
          <div className="flex-shrink-0 flex items-center gap-1 px-4 py-1.5 border-b border-border/50 bg-card/40 backdrop-blur-sm">
            <div className="inline-flex rounded-lg bg-muted/60 p-0.5">
              <button
                onClick={() => setNarrowActiveTab('canvas')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  narrowActiveTab === 'canvas'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground/50 hover:text-foreground/70'
                }`}
              >
                Canvas
              </button>
              <button
                onClick={() => setNarrowActiveTab('chat')}
                className={`relative px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  narrowActiveTab === 'chat'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground/50 hover:text-foreground/70'
                }`}
              >
                Chat
                {narrowActiveTab !== 'chat' && hasUnreadAssistant ? (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary" />
                ) : null}
              </button>
            </div>
          </div>
        ) : null}

        {fileShelf}

        <div className="flex-1 flex flex-col min-h-0 relative">
          <div className="canvas-header flex items-center justify-between px-4 py-2 z-10">
            <div />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {minimizedPanels.length > 0 ? (
                <span className="font-mono">{minimizedPanels.length} docked</span>
              ) : null}
              {selectedPanelIds.size > 0 ? (
                <button className="px-2 py-1 rounded-md border border-accent/30 text-accent hover:bg-accent/10 transition-colors" onClick={clearSelection}>
                  {selectedPanelIds.size} selected
                </button>
              ) : null}
            </div>
          </div>

          {shouldShowCanvasHint ? (
            <div className="canvas-hint fixed top-20 left-1/2 z-40 -translate-x-1/2">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur">
                <span className="text-muted-foreground">
                  <strong className="text-foreground">Drag</strong> to select
                  <span className="mx-2 text-border">|</span>
                  <strong className="text-foreground">Space + drag</strong> to pan
                  <span className="mx-2 text-border">|</span>
                  <strong className="text-foreground">Scroll</strong> to zoom
                </span>
                <button
                  onClick={() => {
                    setShowCanvasHint(false);
                    window.localStorage.setItem('canvas-hint-dismissed', 'true');
                  }}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Dismiss hint"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ) : null}

          <div
            ref={canvasViewportRef}
            className="canvas-bg canvas-wrapper flex-1"
            onPointerDownCapture={handleCanvasPointerDown}
            onPointerMoveCapture={handleCanvasPointerMove}
            onPointerUpCapture={handleCanvasPointerUp}
            onPointerCancelCapture={handleCanvasPointerUp}
          >
            <TransformWrapper
              initialScale={workspaceState.viewport.zoom}
              initialPositionX={workspaceState.viewport.x}
              initialPositionY={workspaceState.viewport.y}
              minScale={0.1}
              maxScale={3}
              limitToBounds={false}
              centerZoomedOut={false}
              disabled={isSelectingBox}
              wheel={{ step: 0.1, excluded: ['no-zoom-scroll'] }}
              panning={{ velocityDisabled: true, allowLeftClickPan: spacePanning, allowMiddleClickPan: true }}
              doubleClick={{ disabled: true }}
              onTransformed={(_ref, state) => {
                const nextViewport = {
                  x: state.positionX,
                  y: state.positionY,
                  zoom: state.scale,
                };
                viewportRef.current = nextViewport;
                setWorkspaceState((current) => ({
                  ...current,
                  viewport: nextViewport,
                }));
                persistViewport(nextViewport);
              }}
            >
              <CanvasZoomControls zoom={workspaceState.viewport.zoom} viewportX={workspaceState.viewport.x} viewportY={workspaceState.viewport.y} />
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: '8000px', height: '8000px' }}
              >
                <div className="canvas-content relative">

              {workspaceState.groups.map((group) => (
                <LegacyGroupBoundary
                  key={group.id}
                  group={group}
                  panelLayouts={panelLayouts}
                  existingPanelIds={existingPanelIds}
                  visiblePanelIds={visiblePanelIds}
                  scale={workspaceState.viewport.zoom}
                  isActive={selectedGroup?.id === group.id}
                  onGroupClick={handleGroupClick}
                  onGroupRename={(groupId, newName) => {
                    void renameGroup(groupId, newName);
                  }}
                  onGroupDrag={handleGroupDrag}
                  onGroupDragEnd={(groupId) => {
                    void handleGroupDragEnd(groupId);
                  }}
                  isEditing={editingGroupId === group.id}
                  editValue={editingGroupId === group.id ? groupNameInput : group.name || ''}
                  onEditChange={setGroupNameInput}
                  onEditStart={(groupId) => {
                    const nextGroup = workspaceState.groups.find((entry) => entry.id === groupId);
                    setEditingGroupId(groupId);
                    setGroupNameInput(nextGroup?.name || '');
                  }}
                />
              ))}
              <LegacyConnectionLines
                panelLayouts={panelLayouts}
                connections={visibleConnections}
                animatingConnectionIds={animatingConnectionIds}
                panelTitles={panelTitles}
              />
              {visiblePanels.length === 0 ? (
                <div className="canvas-empty">
                  <Sparkles className="canvas-empty-icon" />
                  <h3>{minimizedPanels.length > 0 ? 'All Minimized' : 'Empty Canvas'}</h3>
                  <p>
                    {minimizedPanels.length > 0
                      ? 'All visible tiles are minimized. Restore them from the dock to continue.'
                      : 'Ask the agent to create files, markdown, tables, charts, and previews.'}
                  </p>
                </div>
              ) : null}
              {visiblePanels.map((panel, index) => {
                const layout = panelLayouts[panel.id] ?? inferPanelLayout(panel, index);
                return (
                  <LegacyDraggablePanel
                    key={panel.id}
                    id={panel.id}
                    layout={layout}
                    title={getPanelTitle(panel)}
                    type={getPanelTypeLabel(panel)}
                    scale={workspaceState.viewport.zoom}
                    zIndex={focusedPanelId === panel.id ? 40 : selectedPanelIds.has(panel.id) ? 30 : 1}
                    onLayoutChange={handlePanelLayoutChange}
                    onDragStart={handlePanelDragStart}
                    onDragEnd={(panelId) => {
                      void handlePanelDragEnd(panelId);
                    }}
                    onFocus={setFocusedPanelId}
                    onOpenMenu={setOpenMenuId}
                    isMenuOpen={openMenuId === panel.id}
                    menuContent={renderPanelMenuContent(panel)}
                    isSelected={selectedPanelIds.has(panel.id)}
                    isAnimating={animatingPanelIds.has(panel.id)}
                    onPanelClick={handlePanelClick}
                    onPanelDoubleClick={(panelId, event) => {
                      handlePanelDoubleClick(panelId, event);
                    }}
                    isInDraggingGroup={draggingGroupId !== null && workspaceState.groups.find((group) => group.id === draggingGroupId)?.panelIds.includes(panel.id)}
                    onHoverChange={(panelId) => {
                      if (selectedPanelIds.size > 0) return;
                      if (hoverClearTimeoutRef.current) {
                        clearTimeout(hoverClearTimeoutRef.current);
                        hoverClearTimeoutRef.current = null;
                      }
                      if (panelId) {
                        hoveredPanelIdRef.current = panelId;
                        setHoveredPanelId(panelId);
                        return;
                      }
                      const lastPanelId = hoveredPanelIdRef.current;
                      hoverClearTimeoutRef.current = setTimeout(() => {
                        if (hoveredToolbarPanelIdRef.current === lastPanelId) return;
                        hoveredPanelIdRef.current = null;
                        setHoveredPanelId(null);
                      }, 120);
                    }}
                  >
                    <div
                      ref={(node) => {
                        panelRefs.current[panel.id] = node;
                      }}
                      className="h-full"
                    >
                      <PanelBody
                        fileSource={{ kind: 'workspace', id: workspace.workspace.id }}
                        panel={panel}
                        allPanels={workspaceState.panels}
                        workspaceFiles={workspaceFiles}
                        highlightedFilePaths={highlightedFilePaths}
                        getFileActionLabel={getFileCanvasActionLabel}
                        onOpenFile={(file) => {
                          void openFileOnCanvas(file);
                        }}
                      />
                    </div>
                  </LegacyDraggablePanel>
                );
              })}
                </div>
              </TransformComponent>
            </TransformWrapper>
            {isSelectingBox && selectionBoxStart && selectionBoxEnd ? (
              <LegacySelectionBox start={selectionBoxStart} end={selectionBoxEnd} />
            ) : null}
            {showToolbar ? (
              <LegacySelectionToolbar
                selectedPanelId={selectedPanelIds.size > 0 ? (singleSelectedPanel && !selectedGroup ? singleSelectedPanel.id : null) : (toolbarPanel?.id ?? null)}
                selectedGroupId={selectedPanelIds.size > 0 ? (selectedGroup?.id ?? null) : null}
                selectedPanelIds={toolbarPanelIds}
                panelTitle={toolbarPanel ? getPanelTitle(toolbarPanel) : undefined}
                groupName={toolbarGroup?.name}
                selectionBounds={toolbarBounds}
                canvasScale={workspaceState.viewport.zoom}
                viewportOffset={{ x: workspaceState.viewport.x, y: workspaceState.viewport.y }}
                viewportSize={canvasViewportSize}
                canChat={toolbarCanChat}
                onChat={selectedPanelIds.size > 0
                  ? openContextualChat
                  : (toolbarPanel ? () => openContextualChatForPanel(toolbarPanel.id) : undefined)}
                canDownload={Boolean(toolbarPanel && toolbarDownloadFormats.length > 0)}
                downloadFormats={toolbarDownloadFormats}
                onDownload={toolbarPanel ? (format) => handlePanelDownload(toolbarPanel, format) : undefined}
                onAlign={selectedPanels.length >= 2 ? (mode) => void alignSelected(mode) : undefined}
                onDistribute={selectedPanels.length >= 3 ? (axis) => void distributeSelected(axis) : undefined}
                onMinimize={selectedPanelIds.size > 0
                  ? () => minimizePanels(selectedPanels.map((panel) => panel.id))
                  : (toolbarPanel ? () => minimizePanels([toolbarPanel.id]) : undefined)}
                onMaximize={toolbarPanel ? () => setMaximizedPanelId(toolbarPanel.id) : undefined}
                onGroup={selectedPanelIds.size >= 2 && !selectedGroup ? () => void createGroup() : undefined}
                onUngroup={selectedGroup ? () => void ungroupSelection() : undefined}
                isInGroup={Boolean(toolbarSinglePanelGroup)}
                onRemoveFromGroup={toolbarSinglePanelGroup && toolbarPanel ? () => void removePanelFromGroup(toolbarPanel.id) : undefined}
                onRemove={selectedPanelIds.size > 0 ? () => {
                  const panelIds = selectedPanels.map((panel) => panel.id);
                  clearSelection();
                  void removePanels(panelIds);
                } : (toolbarPanel ? () => {
                  void removePanel(toolbarPanel.id);
                } : undefined)}
                onHoverChange={(hovering) => {
                  if (selectedPanelIds.size > 0 || !hoveredPanel) return;
                  if (hovering) {
                    hoveredToolbarPanelIdRef.current = hoveredPanel.id;
                    setHoveredToolbarPanelId(hoveredPanel.id);
                  } else {
                    hoveredToolbarPanelIdRef.current = null;
                    setHoveredToolbarPanelId(null);
                  }
                }}
              />
            ) : null}
            {contextualChatTarget && contextualAnchor ? (
              <LegacyContextualChatPopover
                anchor={contextualAnchor}
                viewport={workspaceState.viewport}
                viewportSize={canvasViewportSize}
                title={contextualChatTarget.title}
                typeLabel={contextualChatTarget.typeLabel}
                messages={contextualMessages}
                input={contextualComposer}
                statusLabel={contextualStatus[contextualChatTarget.key] || null}
                isLoading={!!contextualLoading[contextualChatTarget.key]}
                onInputChange={setContextualComposer}
                onSubmit={handleContextualSubmit}
                onClose={closeContextualChat}
              />
            ) : null}
          </div>
          {minimizedPanels.length > 0 ? (
            <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card/90 p-2 shadow-lg backdrop-blur">
              <button
                className="rounded-md px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
                onClick={restoreAllPanels}
              >
                Restore All
              </button>
              <div className="flex flex-wrap items-center gap-1.5">
                {minimizedPanels.map((panel) => (
                  <button
                    key={panel.id}
                    className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-sm transition-colors hover:bg-muted/80"
                    onClick={() => restorePanel(panel.id)}
                    title={`Restore ${getPanelTitle(panel)}`}
                  >
                    <span className="max-w-[120px] truncate">{getPanelTitle(panel)}</span>
                    <span className="text-xs text-muted-foreground">{getPanelTypeLabel(panel)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {isDrawerChatLayout && narrowActiveTab === 'chat' ? (
        <div className="flex-1 min-h-0 chat-panel flex flex-col">
          {chatPanelContent}
        </div>
      ) : null}
      {isDockedChatLayout ? (
        <aside className={`fixed z-30 max-w-full chat-panel flex flex-col transition-transform duration-300 top-[73px] right-0 bottom-0 left-auto w-[400px] ${chatOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          {chatPanelContent}
        </aside>
      ) : null}
      {isDockedChatLayout && !chatOpen ? (
        <button
          onClick={() => setChatOpen(true)}
          className="chat-toggle"
        >
          <MessageSquare size={18} />
        </button>
      ) : null}
      {toast ? (
        <div className="toast-notification fixed top-20 right-4 z-50">
          <div
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm shadow-lg',
              toast.type === 'success'
                ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
                : 'border border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400'
            )}
          >
            {toast.type === 'success' ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      ) : null}
      {publishModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            if (!publishing) {
              setPublishModalOpen(false);
            }
          }}
        >
          <div
            className="mx-4 w-full max-w-md rounded-2xl bg-card p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold">Publish to Gallery</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Title</label>
                <input
                  type="text"
                  value={publishTitle}
                  onChange={(event) => setPublishTitle(event.target.value)}
                  placeholder="Give your workspace a name..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Description</label>
                <textarea
                  value={publishDescription}
                  onChange={(event) => setPublishDescription(event.target.value)}
                  placeholder="Describe what this workspace does..."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                This will share {publishablePanelCount} tile view{publishablePanelCount !== 1 ? 's' : ''} and {workspaceFileEntries.length} file{workspaceFileEntries.length !== 1 ? 's' : ''} to the public gallery.
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setPublishModalOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                disabled={publishing}
              >
                Cancel
              </button>
              <button
                onClick={() => void handlePublish()}
                disabled={publishing || !publishTitle.trim() || !publishDescription.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {publishing ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {maximizedPanel ? (
        <div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
            <div className="flex items-center gap-3">
              <strong className="font-serif text-lg font-medium">{getPanelTitle(maximizedPanel)}</strong>
              <span className="artifact-type">{getPanelTypeLabel(maximizedPanel)}</span>
            </div>
            <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setMaximizedPanelId(null)}>
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-4xl mx-auto">
              <PanelBody
                fileSource={{ kind: 'workspace', id: workspace.workspace.id }}
                panel={maximizedPanel}
                allPanels={workspaceState.panels}
                workspaceFiles={workspaceFiles}
                highlightedFilePaths={highlightedFilePaths}
                getFileActionLabel={getFileCanvasActionLabel}
                onOpenFile={(file) => {
                  void openFileOnCanvas(file);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const initialWorkspaceId = typeof window !== 'undefined'
    ? new URL(window.location.href).searchParams.get('workspace')
    : null;
  const initialGalleryId = typeof window !== 'undefined'
    ? new URL(window.location.href).searchParams.get('gallery')
    : null;
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse['workspace'][]>([]);
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(initialWorkspaceId);
  const [selectedGalleryId, setSelectedGalleryId] = useState<string | null>(initialGalleryId);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceResponse | null>(null);
  const [selectedGallery, setSelectedGallery] = useState<GalleryItemFull | null>(null);
  const [loading, setLoading] = useState(!!initialWorkspaceId || !!initialGalleryId);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingInitialPrompt, setPendingInitialPrompt] = useState<{ workspaceId: string; prompt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const items = await fetchWorkspaces();
    setWorkspaces(items);
  }, []);

  const loadGallery = useCallback(async () => {
    const items = await fetchGalleryItems();
    setGalleryItems(items);
  }, []);

  const loadWorkspace = useCallback(async (workspaceId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWorkspace(workspaceId);
      setSelectedWorkspace(response);
      setSelectedWorkspaceId(workspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
    void loadGallery();
  }, [loadGallery, loadWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('workspace');
      if (selectedGalleryId) {
        url.searchParams.set('gallery', selectedGalleryId);
      } else {
        url.searchParams.delete('gallery');
      }
      window.history.replaceState({}, '', url);
      setSelectedWorkspace(null);
      setLoading(false);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('workspace', selectedWorkspaceId);
    url.searchParams.delete('gallery');
    window.history.replaceState({}, '', url);
    void loadWorkspace(selectedWorkspaceId);
  }, [loadWorkspace, selectedGalleryId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedGalleryId || selectedWorkspaceId) {
      if (!selectedWorkspaceId) {
        setSelectedGallery(null);
      }
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('gallery', selectedGalleryId);
    url.searchParams.delete('workspace');
    window.history.replaceState({}, '', url);

    void fetchGalleryItem(selectedGalleryId)
      .then((item) => {
        setSelectedGallery(item);
        setLoading(false);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : 'Failed to load gallery item');
        setLoading(false);
      });
  }, [selectedGalleryId, selectedWorkspaceId]);

  const handleDeleteWorkspace = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(selectedWorkspaceId);
      const remaining = await fetchWorkspaces();
      setWorkspaces(remaining);
      const nextId = remaining[0]?.id ?? null;
      setSelectedWorkspaceId(nextId);
      if (!nextId) {
        setSelectedWorkspace(null);
        setLoading(false);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete workspace');
    } finally {
      setDeleting(false);
    }
  }, [selectedWorkspaceId]);

  const handleCloneGalleryItem = useCallback(async (galleryId: string) => {
    setError(null);
    try {
      const result = await cloneGalleryItem(galleryId);
      await loadWorkspaces();
      await loadGallery();
      setPendingInitialPrompt(null);
      setSelectedGalleryId(null);
      setSelectedWorkspaceId(result.workspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to clone gallery item');
    }
  }, [loadGallery, loadWorkspaces]);

  const handleImportBundle = useCallback(async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    setError(null);
    setLoading(true);
    try {
      const result = await importWorkspaceBundle(file);
      await loadWorkspaces();
      setPendingInitialPrompt(null);
      setSelectedGalleryId(null);
      setSelectedWorkspaceId(result.workspaceId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to import workspace');
      setLoading(false);
    } finally {
      setImporting(false);
    }
  }, [loadWorkspaces]);

  const handleCreateFromPrompt = useCallback(async (prompt: string) => {
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace({ name: 'New Workspace' });
      await loadWorkspaces();
      setPendingInitialPrompt({ workspaceId: workspace.id, prompt });
      setSelectedGalleryId(null);
      setSelectedWorkspaceId(workspace.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }, [loadWorkspaces]);

  const handleStartBlank = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace({ name: 'New Workspace' });
      await loadWorkspaces();
      setPendingInitialPrompt(null);
      setSelectedGalleryId(null);
      setSelectedWorkspaceId(workspace.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }, [loadWorkspaces]);

  const handleGoHome = useCallback(() => {
    setPendingInitialPrompt(null);
    setSelectedWorkspaceId(null);
    setSelectedGalleryId(null);
    setSelectedWorkspace(null);
    setSelectedGallery(null);
    setError(null);
  }, []);

  // Loading state
  if (loading && (selectedWorkspaceId || selectedGalleryId)) {
    return (
      <div className="grain h-screen flex items-center justify-center canvas-bg">
        <div className="text-center animate-fade-in">
          <div className="animate-subtle-pulse text-muted-foreground text-sm">Loading workspace…</div>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !selectedWorkspace && !selectedGallery) {
    return (
      <div className="grain h-screen flex flex-col canvas-bg">
        <div className="px-6 py-3 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive animate-fade-in">
          {error}
          <button className="ml-4 underline" onClick={handleGoHome}>Go home</button>
        </div>
      </div>
    );
  }

  // Gallery view
  if (!selectedWorkspace && selectedGallery) {
    return (
      <div className="grain h-screen flex flex-col">
        <ReadOnlyCanvas
          galleryId={selectedGallery.id}
          title={selectedGallery.title}
          description={selectedGallery.description}
          state={selectedGallery.state}
        />
      </div>
    );
  }

  // Workspace view
  if (selectedWorkspace) {
    return (
      <div className="grain h-screen flex flex-col">
        {error ? (
          <div className="px-6 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive animate-fade-in">{error}</div>
        ) : null}
        {!loading && selectedWorkspace ? (
          <WorkspaceShell
            key={selectedWorkspace.workspace.id}
            workspace={selectedWorkspace}
            initialPrompt={pendingInitialPrompt?.workspaceId === selectedWorkspace.workspace.id ? pendingInitialPrompt.prompt : null}
            onInitialPromptConsumed={() => {
              setPendingInitialPrompt((current) => (
                current?.workspaceId === selectedWorkspace.workspace.id ? null : current
              ));
            }}
            onGoHome={handleGoHome}
            onDelete={async () => {
              await handleDeleteWorkspace();
              handleGoHome();
            }}
            onWorkspaceRefresh={async (workspaceId) => {
              await loadWorkspace(workspaceId);
              await loadWorkspaces();
              await loadGallery();
            }}
          />
        ) : null}
      </div>
    );
  }

  // Home page (default)
  return (
    <HomePage
      workspaces={workspaces}
      galleryItems={galleryItems}
      onCreateWorkspace={handleCreateFromPrompt}
      onSelectWorkspace={(id) => {
        setPendingInitialPrompt(null);
        setSelectedGalleryId(null);
        setSelectedWorkspaceId(id);
      }}
      onCloneGalleryItem={handleCloneGalleryItem}
      onStartBlank={handleStartBlank}
      creating={creating}
    />
  );
}
