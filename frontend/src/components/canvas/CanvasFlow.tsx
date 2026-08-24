import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  BaseEdge,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Minus, Plus } from 'lucide-react';
import { CANVAS_LARGE_STEP, CANVAS_RESIZE_STEP, CANVAS_STEP } from '../../lib/keyboardMap';
import { buildPanelLayouts, getGroupBounds, type CanvasPanelLayout, type LayoutMap } from '../../lib/panelLayout';
import { getPanelTitle, getPanelTypeLabel } from '../../lib/panelFiles';
import { PanelBody } from '../panels/PanelBody';
import type {
  PanelGroup,
  PanelConnection,
  PanelLayout,
  WorkspaceFileInfo,
  WorkspacePanel,
  WorkspaceViewport,
} from '../../types';

const MIN_NODE_WIDTH = 200;
const MIN_NODE_HEIGHT = 150;
const SOURCE_HANDLE_ID = 'association-source';
const TARGET_HANDLE_ID = 'association-target';
const PAN_ON_DRAG = [1];
const MULTI_SELECTION_KEY_CODE = ['Meta', 'Control', 'Shift'];
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };
const EMPTY_SELECTION = new Set<string>();
const EMPTY_WORKSPACE_FILES: WorkspaceFileInfo[] = [];

type PanelNodeData = {
  panel: WorkspacePanel;
  allPanels: WorkspacePanel[];
  workspaceFiles: WorkspaceFileInfo[];
  fileSource: { kind: 'workspace' | 'gallery'; id: string };
  highlightedFilePaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
  onPanelRef?: (panelId: string, element: HTMLElement | null) => void;
  onOpenMenu?: (panelId: string) => void;
  isMenuOpen?: boolean;
  menuContent?: React.ReactNode;
  onResizeEnd?: (panelId: string) => void;
  readOnly?: boolean;
};

type GroupNodeData = {
  group: PanelGroup;
  validPanelCount: number;
  isActive: boolean;
  isEditing: boolean;
  editValue: string;
  onGroupRename?: (groupId: string, value: string) => void;
  onEditChange?: (value: string) => void;
  onEditStart?: (groupId: string) => void;
};

type AssociationEdgeData = {
  connection: PanelConnection;
  sourceTitle: string;
  targetTitle: string;
};

type PanelFlowNode = Node<PanelNodeData, 'panel'>;
type GroupFlowNode = Node<GroupNodeData, 'groupBoundary'>;
type CanvasNode = PanelFlowNode | GroupFlowNode;
type AssociationFlowEdge = Edge<AssociationEdgeData, 'association'>;
type PanelScalar = string | number | boolean | null;

function scalarRecordMatches(
  left: Record<string, PanelScalar>,
  right: Record<string, PanelScalar>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function stringRecordMatches(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function scalarRecordsMatch(
  left: Record<string, PanelScalar>[],
  right: Record<string, PanelScalar>[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((record, index) => scalarRecordMatches(record, right[index]));
}

function panelLayoutMatches(left: PanelLayout | undefined, right: PanelLayout | undefined): boolean {
  return left?.x === right?.x &&
    left?.y === right?.y &&
    left?.width === right?.width &&
    left?.height === right?.height;
}

function panelColumnsMatch(
  left: Array<{ key: string; label: string }>,
  right: Array<{ key: string; label: string }>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((column, index) => {
    const next = right[index];
    return column.key === next.key && column.label === next.label;
  });
}

function cardItemsMatch(
  left: Array<{
    id?: string;
    title: string;
    subtitle?: string;
    description?: string;
    badge?: string;
    metadata?: Record<string, string>;
  }>,
  right: Array<{
    id?: string;
    title: string;
    subtitle?: string;
    description?: string;
    badge?: string;
    metadata?: Record<string, string>;
  }>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((card, index) => {
    const next = right[index];
    return card.id === next.id &&
      card.title === next.title &&
      card.subtitle === next.subtitle &&
      card.description === next.description &&
      card.badge === next.badge &&
      stringRecordMatches(card.metadata, next.metadata);
  });
}

function panelBaseMatches(left: WorkspacePanel, right: WorkspacePanel): boolean {
  return left.id === right.id &&
    left.type === right.type &&
    left.title === right.title &&
    left.sourcePanelId === right.sourcePanelId &&
    panelLayoutMatches(left.layout, right.layout);
}

function panelsMatch(left: WorkspacePanel, right: WorkspacePanel): boolean {
  if (!panelBaseMatches(left, right)) return false;

  switch (left.type) {
    case 'chat':
    case 'fileTree':
      return true;
    case 'markdown':
      return right.type === 'markdown' && left.content === right.content;
    case 'table':
      return right.type === 'table' &&
        panelColumnsMatch(left.columns, right.columns) &&
        scalarRecordsMatch(left.rows, right.rows);
    case 'chart':
      return right.type === 'chart' &&
        left.chartType === right.chartType &&
        scalarRecordsMatch(left.data, right.data);
    case 'cards':
      return right.type === 'cards' && cardItemsMatch(left.items, right.items);
    case 'pdf':
    case 'editor':
    case 'file':
      return right.type === left.type && left.filePath === right.filePath;
    case 'preview':
      return right.type === 'preview' &&
        left.filePath === right.filePath &&
        left.content === right.content;
    case 'detail':
      return right.type === 'detail' && left.linkedTo === right.linkedTo;
  }
}

function panelsCollectionMatches(left: WorkspacePanel[], right: WorkspacePanel[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((panel, index) => panelsMatch(panel, right[index]));
}

function workspaceFilesMatch(left: WorkspaceFileInfo[], right: WorkspaceFileInfo[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const next = right[index];
    return file.name === next.name &&
      file.path === next.path &&
      file.isDirectory === next.isDirectory &&
      file.size === next.size &&
      file.uploadedAt === next.uploadedAt &&
      file.modifiedAt === next.modifiedAt &&
      file.etag === next.etag;
  });
}

function highlightedPathsMatch(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const path of left) {
    if (!right.has(path)) return false;
  }
  return true;
}

function panelGroupsMatch(left: PanelGroup, right: PanelGroup): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.color === right.color &&
    left.panelIds.length === right.panelIds.length &&
    left.panelIds.every((panelId, index) => panelId === right.panelIds[index]);
}

function sharedPanelDataMatches(left: PanelNodeData, right: PanelNodeData): boolean {
  return panelsCollectionMatches(left.allPanels, right.allPanels) &&
    workspaceFilesMatch(left.workspaceFiles, right.workspaceFiles) &&
    highlightedPathsMatch(left.highlightedFilePaths, right.highlightedFilePaths);
}

export function flowNodesMatch(left: CanvasNode[], right: CanvasNode[]): boolean {
  if (left.length !== right.length) return false;
  const leftShared = left.find((node): node is PanelFlowNode => node.type === 'panel')?.data;
  const rightShared = right.find((node): node is PanelFlowNode => node.type === 'panel')?.data;
  if ((leftShared === undefined) !== (rightShared === undefined)) return false;
  if (leftShared && rightShared && !sharedPanelDataMatches(leftShared, rightShared)) return false;

  return left.every((node, index) => {
    const next = right[index];
    if (
      node.id !== next.id ||
      node.type !== next.type ||
      node.position.x !== next.position.x ||
      node.position.y !== next.position.y ||
      node.style?.width !== next.style?.width ||
      node.style?.height !== next.style?.height ||
      node.zIndex !== next.zIndex ||
      node.draggable !== next.draggable ||
      node.focusable !== next.focusable ||
      node.selected !== next.selected ||
      node.ariaLabel !== next.ariaLabel
    ) return false;

    if (node.type === 'panel' && next.type === 'panel') {
      if (!leftShared || !rightShared ||
        node.data.allPanels !== leftShared.allPanels ||
        node.data.workspaceFiles !== leftShared.workspaceFiles ||
        node.data.highlightedFilePaths !== leftShared.highlightedFilePaths ||
        next.data.allPanels !== rightShared.allPanels ||
        next.data.workspaceFiles !== rightShared.workspaceFiles ||
        next.data.highlightedFilePaths !== rightShared.highlightedFilePaths) {
        return false;
      }
      return panelsMatch(node.data.panel, next.data.panel) &&
        node.data.fileSource.kind === next.data.fileSource.kind &&
        node.data.fileSource.id === next.data.fileSource.id &&
        node.data.isMenuOpen === next.data.isMenuOpen &&
        node.data.readOnly === next.data.readOnly;
    }

    if (node.type === 'groupBoundary' && next.type === 'groupBoundary') {
      return panelGroupsMatch(node.data.group, next.data.group) &&
        node.data.isEditing === next.data.isEditing &&
        node.data.editValue === next.data.editValue;
    }

    return false;
  });
}

function preserveNodeMeasurements(next: CanvasNode[], current: CanvasNode[]): CanvasNode[] {
  const measuredById = new Map(current.map((node) => [node.id, node.measured]));
  return next.map((node) => {
    const measured = measuredById.get(node.id);
    return measured ? { ...node, measured } : node;
  });
}

function panelIdSetsMatch(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && Array.from(left).every((panelId) => right.has(panelId));
}

function connectionsMatch(left: PanelConnection | undefined, right: PanelConnection | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id &&
    left.sourceId === right.sourceId &&
    left.targetId === right.targetId;
}

export function flowEdgesMatch(left: AssociationFlowEdge[], right: AssociationFlowEdge[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((edge, index) => {
    const next = right[index];
    return edge.id === next.id &&
      edge.type === next.type &&
      edge.source === next.source &&
      edge.target === next.target &&
      edge.selected === next.selected &&
      edge.data?.sourceTitle === next.data?.sourceTitle &&
      edge.data?.targetTitle === next.data?.targetTitle &&
      connectionsMatch(edge.data?.connection, next.data?.connection);
  });
}

function PanelNode({ data, selected }: NodeProps<PanelFlowNode>) {
  const panelTitle = getPanelTitle(data.panel);
  const panelType = getPanelTypeLabel(data.panel);

  return (
    <>
      {!data.readOnly ? (
        <NodeResizer
          isVisible={selected}
          minWidth={MIN_NODE_WIDTH}
          minHeight={MIN_NODE_HEIGHT}
          lineClassName="canvas-node-resize-line"
          handleClassName="canvas-node-resize-handle"
          onResizeEnd={() => data.onResizeEnd?.(data.panel.id)}
        />
      ) : null}
      <Handle
        id={SOURCE_HANDLE_ID}
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="canvas-hidden-handle"
        aria-hidden="true"
      />
      <Handle
        id={TARGET_HANDLE_ID}
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="canvas-hidden-handle"
        aria-hidden="true"
      />
      <div
        ref={(element) => data.onPanelRef?.(data.panel.id, element)}
        className="artifact-card flex h-full w-full flex-col"
        data-panel-id={data.panel.id}
      >
        <div className="artifact-header drag-handle">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h3 className="truncate" title={panelTitle}>{panelTitle}</h3>
            <span className="artifact-type flex-shrink-0">{panelType}</span>
          </div>
          {!data.readOnly && data.onOpenMenu ? (
            <div className="relative flex-shrink-0">
              <button
                type="button"
                aria-label={`Open menu for ${panelTitle}`}
                aria-haspopup="menu"
                aria-expanded={data.isMenuOpen}
                className="panel-menu-trigger nodrag nopan inline-flex h-8 w-8 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => {
                  event.stopPropagation();
                  data.onOpenMenu?.(data.isMenuOpen ? '' : data.panel.id);
                }}
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </button>
              {data.isMenuOpen && data.menuContent ? (
                <div
                  role="menu"
                  aria-label={`Actions for ${panelTitle}`}
                  className="panel-menu nopan nodrag absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  {data.menuContent}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="artifact-content nodrag nopan nowheel min-h-0 flex-1 overflow-auto">
          <PanelBody
            fileSource={data.fileSource}
            panel={data.panel}
            allPanels={data.allPanels}
            workspaceFiles={data.workspaceFiles}
            highlightedFilePaths={data.highlightedFilePaths}
            getFileActionLabel={data.getFileActionLabel}
            onOpenFile={data.onOpenFile}
          />
        </div>
      </div>
    </>
  );
}

function GroupNode({ data, selected }: NodeProps<GroupFlowNode>) {
  const { group } = data;
  const isActive = selected || data.isActive;

  return (
    <div
      className={`group-boundary h-full w-full ${isActive ? 'active' : ''}`}
      aria-label={`${group.name || `${data.validPanelCount} tiles`} group${isActive ? ', selected' : ''}`}
    >
      <div className="group-boundary-label">
        {data.isEditing ? (
          <input
            autoFocus
            type="text"
            value={data.editValue}
            onChange={(event) => data.onEditChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault();
                data.onGroupRename?.(group.id, event.key === 'Escape' ? group.name || '' : data.editValue);
              }
            }}
            onBlur={() => data.onGroupRename?.(group.id, data.editValue)}
            onClick={(event) => event.stopPropagation()}
            className="group-name-input nodrag nopan nowheel"
            placeholder="Group name..."
            aria-label="Group name"
          />
        ) : (
          <span className="group-name-text" title="Double-click to rename">
            {group.name || `${data.validPanelCount} tiles`}
          </span>
        )}
      </div>
    </div>
  );
}

function AssociationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<AssociationFlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.25,
  });
  const label = data
    ? `Association between ${data.sourceTitle} and ${data.targetTitle}`
    : 'Tile association';

  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={24}
      className={`canvas-association-edge ${selected ? 'selected' : ''}`}
      aria-label={label}
    >
      <title>{label}</title>
    </BaseEdge>
  );
}

const nodeTypes = {
  panel: PanelNode,
  groupBoundary: GroupNode,
};

const edgeTypes = {
  association: AssociationEdge,
};

interface CanvasFlowProps {
  panels: WorkspacePanel[];
  allPanels?: WorkspacePanel[];
  groups: PanelGroup[];
  connections: PanelConnection[];
  viewport: WorkspaceViewport;
  workspaceFiles?: WorkspaceFileInfo[];
  fileSource: { kind: 'workspace' | 'gallery'; id: string };
  selectedPanelIds?: Set<string>;
  selectedConnectionIds?: Set<string>;
  focusedPanelId?: string | null;
  existingPanelIds?: Set<string>;
  openMenuId?: string | null;
  renderPanelMenu?: (panel: WorkspacePanel) => React.ReactNode;
  highlightedFilePaths?: Set<string>;
  getFileActionLabel?: (filePath: string) => string;
  onOpenFile?: (file: WorkspaceFileInfo) => void;
  onPanelRef?: (panelId: string, element: HTMLElement | null) => void;
  onOpenMenu?: (panelId: string) => void;
  onPanelLayoutChange?: (panelId: string, layout: Partial<CanvasPanelLayout>) => void;
  onPanelDragStart?: (panelId: string) => void;
  onPanelDragEnd?: (panelId: string) => void;
  onPanelDelete?: (panelIds: string[]) => void;
  onConnectionDelete?: (connectionId: string) => void;
  onConnectionClick?: (connection: PanelConnection) => void;
  onSelectionChange?: (panelIds: string[]) => void;
  onPaneClick?: () => void;
  onNodeDoubleClick?: (panelId: string) => void;
  onNodeFocus?: (panelId: string) => void;
  onNodeHover?: (panelId: string | null) => void;
  onGroupClick?: (groupId: string) => void;
  onGroupRename?: (groupId: string, value: string) => void;
  onGroupDrag?: (groupId: string, dx: number, dy: number) => void;
  onGroupDragEnd?: (groupId: string) => void;
  editingGroupId?: string | null;
  groupNameInput?: string;
  onGroupNameInputChange?: (value: string) => void;
  onEditGroupStart?: (groupId: string) => void;
  onViewportChange?: (viewport: WorkspaceViewport) => void;
  onOpenShortcuts?: () => void;
  readOnly?: boolean;
  emptyState?: React.ReactNode;
  children?: React.ReactNode;
  viewportRef?: React.RefObject<HTMLDivElement | null>;
}

function CanvasZoomControls({ viewport, onViewportChange }: { viewport: WorkspaceViewport; onViewportChange: (viewport: WorkspaceViewport) => void }) {
  const reactFlow = useReactFlow<CanvasNode, AssociationFlowEdge>();
  const showReset = Math.abs(viewport.zoom - 1) > 0.01 || Math.abs(viewport.x) > 1 || Math.abs(viewport.y) > 1;

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    const promise = direction === 'in' ? reactFlow.zoomIn({ duration: 160 }) : reactFlow.zoomOut({ duration: 160 });
    void promise.then(() => {
      const nextViewport = reactFlow.getViewport();
      onViewportChange({ x: nextViewport.x, y: nextViewport.y, zoom: nextViewport.zoom });
    });
  }, [onViewportChange, reactFlow]);

  const handleReset = useCallback(() => {
    void reactFlow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 160 }).then(() => {
      onViewportChange({ x: 0, y: 0, zoom: 1 });
    });
  }, [onViewportChange, reactFlow]);

  return (
    <div className="fixed bottom-4 left-4 z-40 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur" role="group" aria-label="Canvas zoom">
      <button
        type="button"
        onClick={() => handleZoom('out')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <span className="w-12 text-center font-mono text-xs text-muted-foreground" aria-live="polite" aria-label={`Zoom ${Math.round(viewport.zoom * 100)} percent`}>
        {Math.round(viewport.zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={() => handleZoom('in')}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {showReset ? (
        <button
          type="button"
          onClick={handleReset}
          className="rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Reset view"
          aria-label="Reset zoom and position"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}

function CanvasFlowInner({
  panels,
  allPanels = panels,
  groups,
  connections,
  viewport,
  workspaceFiles = EMPTY_WORKSPACE_FILES,
  fileSource,
  selectedPanelIds = EMPTY_SELECTION,
  selectedConnectionIds = EMPTY_SELECTION,
  focusedPanelId,
  openMenuId,
  renderPanelMenu,
  highlightedFilePaths,
  getFileActionLabel,
  onOpenFile,
  onPanelRef,
  onOpenMenu,
  onPanelLayoutChange,
  onPanelDragStart,
  onPanelDragEnd,
  onPanelDelete,
  onConnectionDelete,
  onConnectionClick,
  onSelectionChange,
  onPaneClick,
  onNodeDoubleClick,
  onNodeFocus,
  onNodeHover,
  onGroupClick,
  onGroupRename,
  onGroupDrag,
  onGroupDragEnd,
  editingGroupId,
  groupNameInput = '',
  onGroupNameInputChange,
  onEditGroupStart,
  onViewportChange,
  onOpenShortcuts,
  readOnly = false,
  emptyState,
  children,
  viewportRef,
}: CanvasFlowProps) {
  const panelLayouts = useMemo<LayoutMap>(() => buildPanelLayouts(panels), [panels]);

  const groupNodes = useMemo<GroupFlowNode[]>(() => groups.flatMap((group) => {
    const validPanelIds = group.panelIds.filter((panelId) => panelLayouts[panelId]);
    if (validPanelIds.length < 2) return [];
    const bounds = getGroupBounds(group, panelLayouts, 16);
    if (!bounds) return [];
    const isActive = validPanelIds.every((panelId) => selectedPanelIds.has(panelId));
    return [{
      id: `group:${group.id}`,
      type: 'groupBoundary',
      position: { x: bounds.x, y: bounds.y },
      className: 'group-boundary-node',
      style: { width: bounds.width, height: bounds.height },
      width: bounds.width,
      height: bounds.height,
      zIndex: 0,
      draggable: !readOnly,
      selectable: false,
      deletable: false,
      focusable: true,
      ariaRole: 'group',
      ariaLabel: `${group.name || `${validPanelIds.length} tiles`} group${isActive ? ', selected' : ''}`,
      data: {
        group,
        validPanelCount: validPanelIds.length,
        isActive,
        isEditing: editingGroupId === group.id,
        editValue: editingGroupId === group.id ? groupNameInput : group.name || '',
        onGroupRename,
        onEditChange: onGroupNameInputChange,
        onEditStart: onEditGroupStart,
      },
    }];
  }), [editingGroupId, groupNameInput, groups, onEditGroupStart, onGroupNameInputChange, onGroupRename, panelLayouts, readOnly, selectedPanelIds]);

  const flowNodes = useMemo<CanvasNode[]>(() => [
    ...groupNodes,
    ...panels.map((panel) => {
      const layout = panelLayouts[panel.id];
      return {
        id: panel.id,
        type: 'panel',
        position: { x: layout.x, y: layout.y },
        style: { width: layout.width, height: layout.height },
        width: layout.width,
        height: layout.height,
        selected: selectedPanelIds.has(panel.id),
        zIndex: focusedPanelId === panel.id ? 40 : selectedPanelIds.has(panel.id) ? 30 : 1,
        draggable: !readOnly,
        selectable: true,
        connectable: false,
        deletable: !readOnly,
        focusable: true,
        dragHandle: '.drag-handle',
        ariaRole: 'group',
        ariaLabel: `${getPanelTitle(panel)} (${panel.type} tile)${selectedPanelIds.has(panel.id) ? ', selected' : ''}`,
        data: {
          panel,
          allPanels,
          workspaceFiles,
          fileSource,
          highlightedFilePaths,
          getFileActionLabel,
          onOpenFile,
          onPanelRef,
          onOpenMenu,
          isMenuOpen: openMenuId === panel.id,
          menuContent: renderPanelMenu?.(panel),
          onResizeEnd: onPanelDragEnd,
          readOnly,
        },
      } satisfies PanelFlowNode;
    }),
  ], [allPanels, fileSource, focusedPanelId, getFileActionLabel, groupNodes, highlightedFilePaths, onOpenFile, onOpenMenu, onPanelDragEnd, onPanelRef, openMenuId, panels, panelLayouts, readOnly, renderPanelMenu, selectedPanelIds, workspaceFiles]);

  const flowEdges = useMemo<AssociationFlowEdge[]>(() => connections.flatMap((connection) => {
    if (!panelLayouts[connection.sourceId] || !panelLayouts[connection.targetId]) return [];
    return [{
      id: connection.id,
      type: 'association',
      source: connection.sourceId,
      target: connection.targetId,
      sourceHandle: SOURCE_HANDLE_ID,
      targetHandle: TARGET_HANDLE_ID,
      selected: selectedConnectionIds.has(connection.id),
      // Edge activation is owned by the explicit association callback below.
      // Leaving React Flow's native edge-selection state enabled would fight
      // the controlled endpoint selection in the parent on every click.
      selectable: false,
      deletable: !readOnly,
      focusable: true,
      ariaRole: 'button',
      ariaLabel: `Association between ${getPanelTitle(allPanels.find((panel) => panel.id === connection.sourceId) ?? { id: connection.sourceId, type: 'markdown', content: '' })} and ${getPanelTitle(allPanels.find((panel) => panel.id === connection.targetId) ?? { id: connection.targetId, type: 'markdown', content: '' })}`,
      data: {
        connection,
        sourceTitle: getPanelTitle(allPanels.find((panel) => panel.id === connection.sourceId) ?? { id: connection.sourceId, type: 'markdown', content: '' }),
        targetTitle: getPanelTitle(allPanels.find((panel) => panel.id === connection.targetId) ?? { id: connection.targetId, type: 'markdown', content: '' }),
      },
    } satisfies AssociationFlowEdge];
  }), [allPanels, connections, panelLayouts, readOnly, selectedConnectionIds]);

  const [nodes, setNodes, applyNodeChanges] = useNodesState<CanvasNode>(flowNodes);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<AssociationFlowEdge>(flowEdges);
  const groupDragRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const panelDragIdsRef = useRef<Set<string>>(new Set());
  const edgeSelectionRef = useRef(false);
  const reactFlow = useReactFlow<CanvasNode, AssociationFlowEdge>();
  const store = useStoreApi<CanvasNode, AssociationFlowEdge>();
  const lastFlowNodesRef = useRef(flowNodes);
  const previousSelectedPanelIdsRef = useRef<Set<string> | null>(null);
  const pendingSelectionTransitionRef = useRef<Set<string> | null>(null);

  if (!panelIdSetsMatch(previousSelectedPanelIdsRef.current ?? EMPTY_SELECTION, selectedPanelIds)) {
    pendingSelectionTransitionRef.current = previousSelectedPanelIdsRef.current
      ? new Set(previousSelectedPanelIdsRef.current)
      : EMPTY_SELECTION;
    previousSelectedPanelIdsRef.current = new Set(selectedPanelIds);
  }

  useEffect(() => {
    if (flowNodesMatch(lastFlowNodesRef.current, flowNodes)) return;
    lastFlowNodesRef.current = flowNodes;
    setNodes((current) => preserveNodeMeasurements(flowNodes, current));
  }, [flowNodes, setNodes]);

  useEffect(() => {
    setEdges((current) => flowEdgesMatch(current, flowEdges) ? current : flowEdges);
  }, [flowEdges, setEdges]);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const stateChanges = changes.filter((change) => change.type !== 'dimensions' || change.dimensions);
    if (stateChanges.length > 0) applyNodeChanges(stateChanges);
    for (const change of changes) {
      if (!('id' in change)) continue;
      if (change.id.startsWith('group:')) continue;

      if (change.type === 'position' && change.position) {
        const currentLayout = panelLayouts[change.id];
        if (
          !currentLayout ||
          currentLayout.x !== change.position.x ||
          currentLayout.y !== change.position.y
        ) {
          onPanelLayoutChange?.(change.id, { x: change.position.x, y: change.position.y });
        }
        if (change.dragging === false && !panelDragIdsRef.current.has(change.id)) {
          onPanelDragEnd?.(change.id);
        }
      }

      // Keep measured dimensions in React Flow's controlled node state so a
      // later selection or viewport update retains the measured handle bounds.
      // Persist only interactive resize changes; measurement results are not
      // authoritative workspace layout.
      if (change.type === 'dimensions' && change.dimensions && change.resizing) {
        const currentLayout = panelLayouts[change.id];
        if (
          !currentLayout ||
          currentLayout.width !== change.dimensions.width ||
          currentLayout.height !== change.dimensions.height
        ) {
          onPanelLayoutChange?.(change.id, {
            width: change.dimensions.width,
            height: change.dimensions.height,
          });
        }
      }
    }
  }, [applyNodeChanges, onPanelDragEnd, onPanelLayoutChange, panelLayouts]);

  const handleEdgesChange = useCallback((changes: Parameters<typeof applyEdgeChanges>[0]) => {
    applyEdgeChanges(changes);
  }, [applyEdgeChanges]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: CanvasNode[] }) => {
    if (edgeSelectionRef.current || (selectedConnectionIds.size > 0 && selectedNodes.length === 0)) return;
    if (selectedNodes.some((node) => node.type === 'groupBoundary')) return;
    const nextPanelIds = selectedNodes.filter((node) => node.type === 'panel').map((node) => node.id);
    const nextSelection = new Set(nextPanelIds);
    const pendingSelection = pendingSelectionTransitionRef.current;
    if (pendingSelection && panelIdSetsMatch(nextSelection, pendingSelection)) {
      pendingSelectionTransitionRef.current = null;
      return;
    }
    pendingSelectionTransitionRef.current = null;
    // React Flow reports a transient empty selection while controlled nodes are
    // being reconciled. The parent owns selection, and pane clicks already
    // clear it explicitly; forwarding this transient event would make the
    // controlled `selected` prop oscillate between the user selection and []
    // until React hits its maximum update depth.
    if (nextPanelIds.length === 0 && selectedPanelIds.size > 0) return;
    if (panelIdSetsMatch(nextSelection, selectedPanelIds)) return;
    onSelectionChange?.(nextPanelIds);
  }, [onSelectionChange, selectedConnectionIds, selectedPanelIds]);

  const handleNodeDragStart = useCallback<OnNodeDrag<CanvasNode>>((_event, node) => {
    if (node.type === 'groupBoundary') {
      groupDragRef.current = { id: node.id.slice('group:'.length), x: node.position.x, y: node.position.y };
      return;
    }
    onNodeFocus?.(node.id);
    panelDragIdsRef.current.add(node.id);
    onPanelDragStart?.(node.id);
  }, [onNodeFocus, onPanelDragStart]);

  const handleNodeDrag = useCallback<OnNodeDrag<CanvasNode>>((_event, node) => {
    if (node.type !== 'groupBoundary' || !groupDragRef.current) return;
    const previous = groupDragRef.current;
    const dx = node.position.x - previous.x;
    const dy = node.position.y - previous.y;
    if (dx !== 0 || dy !== 0) {
      onGroupDrag?.(previous.id, dx, dy);
      groupDragRef.current = { ...previous, x: node.position.x, y: node.position.y };
    }
  }, [onGroupDrag]);

  const handleNodeDragStop = useCallback<OnNodeDrag<CanvasNode>>((_event, node) => {
    if (node.type === 'groupBoundary') {
      const groupId = node.id.slice('group:'.length);
      groupDragRef.current = null;
      onGroupDragEnd?.(groupId);
      return;
    }
    panelDragIdsRef.current.delete(node.id);
    onPanelDragEnd?.(node.id);
  }, [onGroupDragEnd, onPanelDragEnd]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: CanvasNode) => {
    if (node.type === 'groupBoundary') {
      store.getState().addSelectedNodes([node.id]);
      onGroupClick?.(node.id.slice('group:'.length));
      return;
    }
    onNodeFocus?.(node.id);
  }, [onGroupClick, onNodeFocus, store]);

  const handleNodeDoubleClick = useCallback((event: React.MouseEvent, node: CanvasNode) => {
    event.stopPropagation();
    if (node.type === 'groupBoundary') {
      onEditGroupStart?.(node.id.slice('group:'.length));
      return;
    }
    onNodeDoubleClick?.(node.id);
  }, [onEditGroupStart, onNodeDoubleClick]);

  const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: CanvasNode) => {
    if (node.type === 'panel') onNodeHover?.(node.id);
  }, [onNodeHover]);

  const handleNodeMouseLeave = useCallback((_event: React.MouseEvent, node: CanvasNode) => {
    if (node.type === 'panel') onNodeHover?.(null);
  }, [onNodeHover]);

  const handleEdgeClick = useCallback((event: React.MouseEvent, edge: AssociationFlowEdge) => {
    event.stopPropagation();
    if (!edge.data) return;
    edgeSelectionRef.current = true;
    const endpointIds = new Set([edge.data.connection.sourceId, edge.data.connection.targetId]);
    store.getState().addSelectedNodes([...endpointIds]);
    onConnectionClick?.(edge.data.connection);
    window.setTimeout(() => {
      edgeSelectionRef.current = false;
    }, 150);
  }, [onConnectionClick, store]);

  const handleViewportChange = useCallback((nextViewport: Viewport) => {
    onViewportChange?.({ x: nextViewport.x, y: nextViewport.y, zoom: nextViewport.zoom });
  }, [onViewportChange]);

  const handleCanvasKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('input, textarea, select, button, [contenteditable="true"], .panel-menu, .panel-menu-trigger')) return;

    if (event.currentTarget === event.target) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        void reactFlow.zoomIn({ duration: 160 }).then(() => {
          handleViewportChange(reactFlow.getViewport());
        });
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        void reactFlow.zoomOut({ duration: 160 }).then(() => {
          handleViewportChange(reactFlow.getViewport());
        });
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        void reactFlow.fitView({ duration: 160, padding: 0.2 }).then(() => {
          handleViewportChange(reactFlow.getViewport());
        });
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        onOpenShortcuts?.();
        return;
      }
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (readOnly) return;
      const edgeElement = target.closest<HTMLElement>('.react-flow__edge');
      if (edgeElement?.dataset.id) {
        event.preventDefault();
        event.stopPropagation();
        onConnectionDelete?.(edgeElement.dataset.id);
        return;
      }
      const nodeElement = target.closest<HTMLElement>('.react-flow__node');
      const nodeId = nodeElement?.dataset.id;
      const panelIds = selectedPanelIds.size > 0
        ? Array.from(selectedPanelIds)
        : nodeId && !nodeId.startsWith('group:') ? [nodeId] : [];
      if (panelIds.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        onPanelDelete?.(panelIds);
      }
      return;
    }

    const edgeElement = target.closest<HTMLElement>('.react-flow__edge');
    if (edgeElement && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
      const edge = flowEdges.find((entry) => entry.id === edgeElement.dataset.id);
      if (edge?.data) {
        event.preventDefault();
        event.stopPropagation();
        onConnectionClick?.(edge.data.connection);
      }
      return;
    }

    const nodeElement = target.closest<HTMLElement>('.react-flow__node');
    const nodeId = nodeElement?.dataset.id;
    if (!nodeId) return;

    if (nodeId.startsWith('group:')) {
      const groupId = nodeId.slice('group:'.length);
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        event.stopPropagation();
        onGroupClick?.(groupId);
        return;
      }
      if (event.key === 'F2' && !readOnly) {
        event.preventDefault();
        event.stopPropagation();
        onEditGroupStart?.(groupId);
        return;
      }
      if (readOnly) return;
      let dx = 0;
      let dy = 0;
      if (event.key === 'ArrowLeft') dx = -1;
      if (event.key === 'ArrowRight') dx = 1;
      if (event.key === 'ArrowUp') dy = -1;
      if (event.key === 'ArrowDown') dy = 1;
      if (dx === 0 && dy === 0) return;
      const step = event.shiftKey ? CANVAS_LARGE_STEP : CANVAS_STEP;
      event.preventDefault();
      event.stopPropagation();
      onGroupDrag?.(groupId, dx * step, dy * step);
      onGroupDragEnd?.(groupId);
      return;
    }

    if (event.key === 'm' || event.key === 'M') {
      if (readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      onNodeFocus?.(nodeId);
      onOpenMenu?.(openMenuId === nodeId ? '' : nodeId);
      return;
    }

    if (readOnly || selectedPanelIds.size > 1) return;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -1;
    if (event.key === 'ArrowRight') dx = 1;
    if (event.key === 'ArrowUp') dy = -1;
    if (event.key === 'ArrowDown') dy = 1;
    if (dx === 0 && dy === 0) return;
    const layout = panelLayouts[nodeId];
    if (!layout) return;

    event.preventDefault();
    event.stopPropagation();
    onNodeFocus?.(nodeId);
    if (event.altKey) {
      onPanelLayoutChange?.(nodeId, {
        width: Math.max(MIN_NODE_WIDTH, layout.width + dx * CANVAS_RESIZE_STEP),
        height: Math.max(MIN_NODE_HEIGHT, layout.height + dy * CANVAS_RESIZE_STEP),
      });
    } else {
      const step = event.shiftKey ? CANVAS_LARGE_STEP : CANVAS_STEP;
      onPanelLayoutChange?.(nodeId, { x: layout.x + dx * step, y: layout.y + dy * step });
    }
    onPanelDragEnd?.(nodeId);
  }, [flowEdges, handleViewportChange, onConnectionClick, onEditGroupStart, onGroupClick, onGroupDrag, onGroupDragEnd, onNodeFocus, onOpenMenu, onOpenShortcuts, onPanelDragEnd, onPanelLayoutChange, openMenuId, panelLayouts, reactFlow, readOnly, selectedPanelIds]);

  const handleCanvasFocusCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('.react-flow__node')
      : null;
    const panelId = target?.dataset.id;
    if (panelId && !panelId.startsWith('group:')) onNodeFocus?.(panelId);
  }, [onNodeFocus]);

  return (
    <div
      ref={viewportRef}
      onKeyDownCapture={handleCanvasKeyDownCapture}
      onFocusCapture={handleCanvasFocusCapture}
      className="canvas-bg canvas-wrapper relative flex-1 min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      role="region"
      aria-label={`Workspace canvas, ${panels.length} tile${panels.length === 1 ? '' : 's'}. Tab to a tile, then use arrow keys to move it.`}
      tabIndex={0}
    >
      <ReactFlow<CanvasNode, AssociationFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onSelectionChange={handleSelectionChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeDragStart={readOnly ? undefined : handleNodeDragStart}
        onNodeDrag={readOnly ? undefined : handleNodeDrag}
        onNodeDragStop={readOnly ? undefined : handleNodeDragStop}
        onEdgeClick={handleEdgeClick}
        onPaneClick={onPaneClick}
        onViewportChange={handleViewportChange}
        viewport={viewport}
        minZoom={0.35}
        maxZoom={2.5}
        panOnDrag={PAN_ON_DRAG}
        panActivationKeyCode="Space"
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        autoPanOnSelection={false}
        selectionKeyCode={null}
        multiSelectionKeyCode={MULTI_SELECTION_KEY_CODE}
        zoomActivationKeyCode={null}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        connectOnClick={false}
        nodesFocusable
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        preventScrolling
        noDragClassName="nodrag"
        noPanClassName="nopan"
        noWheelClassName="nowheel"
        onlyRenderVisibleElements={false}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        className="agent-studio-react-flow"
      >
        <CanvasZoomControls viewport={viewport} onViewportChange={handleViewportChange} />
        {emptyState}
        {children}
      </ReactFlow>
    </div>
  );
}

export function CanvasFlow(props: CanvasFlowProps) {
  return (
    <ReactFlowProvider>
      <CanvasFlowInner {...props} />
    </ReactFlowProvider>
  );
}
