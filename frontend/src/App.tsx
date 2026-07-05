import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import {
  getToolName,
  isTextUIPart,
  isToolUIPart,
} from 'ai';
import { toPng } from 'html-to-image';
import { HomePage } from './components/HomePage';
import { ConnectionLines as LegacyConnectionLines } from './components/canvas/ConnectionLines';
import { ContextualChatPopover as LegacyContextualChatPopover } from './components/canvas/ContextualChatPopover';
import { DraggablePanel as LegacyDraggablePanel } from './components/canvas/DraggablePanel';
import { GroupBoundary as LegacyGroupBoundary } from './components/canvas/GroupBoundary';
import { SelectionBox as LegacySelectionBox } from './components/canvas/SelectionBox';
import { SelectionToolbar as LegacySelectionToolbar } from './components/canvas/SelectionToolbar';
import { CanvasZoomControls } from './components/canvas/CanvasZoomControls';
import { ReadOnlyCanvas } from './components/canvas/ReadOnlyCanvas';
import { PanelBody } from './components/panels/PanelBody';
import { PanelMenu } from './components/panels/PanelMenu';
import { ChatPanel } from './components/chat/ChatPanel';
import { WorkspaceHeader } from './components/workspace/WorkspaceHeader';
import { FilesShelf } from './components/workspace/FilesShelf';
import { PublishDialog } from './components/workspace/PublishDialog';
import { WorkspaceToast } from './components/workspace/WorkspaceToast';
import { MaximizedPanelOverlay } from './components/workspace/MaximizedPanelOverlay';
import {
  X,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import {
  clearWorkspaceDownloads,
  cloneGalleryItem,
  createWorkspace,
  ensureCsrfToken,
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
  fetchModels,
  getWorkspaceFileUrl,
  importWorkspaceBundle,
  publishWorkspace,
  unpublishGalleryItem,
  updateWorkspace,
  uploadWorkspaceFiles,
  handleAuthRequired,
} from './api';
import type { ModelCatalog } from './api';
import {
  PANEL_GAP,
  buildPanelLayouts,
  getGroupBounds,
  getLayoutsBounds,
  hasOverlappingPanels,
  inferPanelLayout,
  layoutOverlapsBounds,
  resolveCollisions,
  resolveVisibleLayoutCollisions,
  type CanvasPanelLayout,
  type LayoutMap,
} from './lib/panelLayout';
import { escapeCsvCell, serializeTableAsCsv } from './lib/csv';
import { CANVAS_STEP, CANVAS_LARGE_STEP } from './lib/keyboardMap';
import { KeyboardShortcutsDialog } from './components/workspace/KeyboardShortcutsDialog';
import { clampNumber, formatFileSize, makeClientId } from './lib/format';
import { downloadBlob, triggerQueuedDownload } from './lib/download';
import {
  type ContextualChatTarget,
  type ContextualThreadMessage,
  extractMessageText,
  getContextualStatusLabel,
} from './lib/messages';
import {
  type ToolbarDownloadFormat,
  canOpenFileInPanel,
  getFileName,
  getPanelDownloadFormats,
  getPanelTitle,
  getPanelTypeLabel,
  getWorkspaceFilePanelId,
  inferWorkspaceFilePanelType,
  isPanelContextualChatCapable,
} from './lib/panelFiles';
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
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [workspaceModel, setWorkspaceModel] = useState<string | undefined>(workspace.workspace.model);
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
  // Politely-announced messages for screen readers (chat status, uploads,
  // errors). Kept separate from the visual toast so announcements can fire even
  // when there is nothing new to show visually.
  const [announcement, setAnnouncement] = useState('');
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [contextualComposer, setContextualComposer] = useState('');
  const [contextualChatTarget, setContextualChatTarget] = useState<ContextualChatTarget | null>(null);
  const [contextualThreads, setContextualThreads] = useState<Record<string, ContextualThreadMessage[]>>({});
  const [contextualLoading, setContextualLoading] = useState<Record<string, boolean>>({});
  const [contextualStatus, setContextualStatus] = useState<Record<string, string | null>>({});
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const filesSectionRef = useRef<HTMLElement | null>(null);
  const fileCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
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
    // Per-connection CSRF token on the WebSocket upgrade (fleet contract §3¾
    // rule 4). ensureCsrfToken() sources it from the path-scoped
    // cail_csrf_agentstudio cookie (delivery amendment); the browser can't set a
    // custom header on a WS upgrade, so it rides the query string. The DO
    // verifies it once at accept and closes the socket if it is missing/invalid;
    // a sibling tool is same-origin but cannot read this token.
    query: async () => ({ csrfToken: await ensureCsrfToken() }),
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
      // A model-proxy authentication_required envelope can surface here as a
      // stringified error body. Follow the /login?rt= redirect if so.
      const message = chatError instanceof Error ? chatError.message : String(chatError ?? '');
      if (message.includes('authentication_required')) {
        try {
          const parsed = JSON.parse(message.slice(message.indexOf('{')));
          if (handleAuthRequired(401, parsed)) return;
        } catch {
          handleAuthRequired(401, { error: 'authentication_required' });
          return;
        }
      }
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
    setWorkspaceModel(workspace.workspace.model);
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

  useEffect(() => {
    let cancelled = false;
    void fetchModels()
      .then((catalog) => {
        if (!cancelled) setModelCatalog(catalog);
      })
      .catch(() => {
        // Non-fatal: the picker just stays hidden if the catalog can't load.
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.workspace.id]);

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
  // Roving tabindex target: exactly one visible tile is Tab-reachable at a time,
  // so the canvas takes a single tab stop and arrow keys drive geometry from the
  // focused tile. Prefer the explicitly focused tile, then the first selected,
  // then the first visible tile.
  const rovingPanelId = useMemo(() => {
    if (focusedPanelId && visiblePanels.some((panel) => panel.id === focusedPanelId)) {
      return focusedPanelId;
    }
    const firstSelected = visiblePanels.find((panel) => selectedPanelIds.has(panel.id));
    if (firstSelected) return firstSelected.id;
    return visiblePanels[0]?.id ?? null;
  }, [focusedPanelId, selectedPanelIds, visiblePanels]);
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

  const announce = useCallback((message: string) => {
    // Re-set to empty first so identical consecutive messages are still spoken
    // by assistive tech (which ignores no-op text updates in a live region).
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(message), 30);
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'info' = 'success') => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }

    setToast({ message, type });
    announce(message);
    toastTimeoutRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3000);
  }, [announce]);

  // Announce agent/chat streaming status transitions politely. "submitted" and
  // "streaming" surface as "thinking"; errors and completion are announced too.
  const lastChatStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = chat.status;
    if (status === lastChatStatusRef.current) return;
    lastChatStatusRef.current = status;
    if (status === 'submitted' || status === 'streaming') {
      announce('Agent is thinking…');
    } else if (status === 'error') {
      announce('The agent response failed. You can retry or clear the thread.');
    } else if (status === 'ready') {
      announce('Agent response ready.');
    }
  }, [announce, chat.status]);

  // Surface workspace-level errors (uploads, saves, rate limits) to screen
  // readers, not just the visual error banner.
  useEffect(() => {
    if (error) announce(`Error: ${error}`);
  }, [announce, error]);

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
    <PanelMenu
      panel={panel}
      workspaceId={workspace.workspace.id}
      maximizedPanelId={maximizedPanelId}
      onAskAboutTile={openContextualChatForPanel}
      onRevealFile={revealFileInWorkspace}
      onPanelDownload={handlePanelDownload}
      onCloseMenu={() => setOpenMenuId(null)}
      onMinimize={(panelId) => {
        setMinimizedPanelIds((current) => new Set(current).add(panelId));
        setSelectedPanelIds((current) => new Set(Array.from(current).filter((id) => id !== panelId)));
      }}
      onMaximize={setMaximizedPanelId}
      onSetContextualChatTarget={setContextualChatTarget}
      onClearContextualDraft={clearContextualDraft}
      onSetMaximizedPanelId={setMaximizedPanelId}
      onRemovePanel={(panelId) => {
        void removePanel(panelId);
      }}
    />
  ), [
    clearContextualDraft,
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

  const handleModelChange = useCallback(async (modelId: string) => {
    const previous = workspaceModel;
    setWorkspaceModel(modelId);
    setError(null);
    try {
      await updateWorkspace(workspace.workspace.id, { model: modelId });
      await refreshWorkspace();
    } catch (nextError) {
      setWorkspaceModel(previous);
      setError(nextError instanceof Error ? nextError.message : 'Failed to change model');
    }
  }, [refreshWorkspace, workspace.workspace.id, workspaceModel]);

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
      const step = event.shiftKey ? CANVAS_LARGE_STEP : CANVAS_STEP;
      if (event.key === 'ArrowLeft') dx = -step;
      if (event.key === 'ArrowRight') dx = step;
      if (event.key === 'ArrowUp') dy = -step;
      if (event.key === 'ArrowDown') dy = step;

      // When 2+ tiles are selected, arrows nudge the whole selection. A single
      // focused tile is handled by DraggablePanel's own key handler (which stops
      // propagation), so this only runs for multi-select.
      if ((dx !== 0 || dy !== 0) && selectedPanelIds.size > 1) {
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

  const zoomBy = useCallback((factor: number) => {
    const element = canvasViewportRef.current;
    const centerX = element ? element.clientWidth / 2 : 0;
    const centerY = element ? element.clientHeight / 2 : 0;
    updateViewport((current) => {
      const nextZoom = clampNumber(current.zoom * factor, 0.35, 2.5);
      const canvasX = (centerX - current.x) / current.zoom;
      const canvasY = (centerY - current.y) / current.zoom;
      return {
        x: centerX - canvasX * nextZoom,
        y: centerY - canvasY * nextZoom,
        zoom: nextZoom,
      };
    });
  }, [updateViewport]);

  // Keyboard handling for the canvas region itself (fires only when the region,
  // not a tile, holds focus — tiles stopPropagation their own arrow keys). This
  // is why the canvas is a labeled region with roving tile focus rather than
  // role="application": it adds a few affordances without trapping all keys.
  const handleCanvasKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.2);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomBy(1 / 1.2);
    } else if (event.key === '0') {
      event.preventDefault();
      handleResetViewport();
    } else if (event.key === '?') {
      event.preventDefault();
      setShortcutsOpen(true);
    }
  }, [handleResetViewport, zoomBy]);

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
    <ChatPanel
      status={chat.status}
      messages={chat.messages}
      composer={composer}
      onComposerChange={setComposer}
      onSubmit={(text) => void sendChatMessage(text)}
      onClear={handleChatClear}
      onRetry={handleChatRetry}
      onDumpTrace={() => {
        void dumpWorkspaceObservability();
      }}
      canRetry={Boolean(lastUserPrompt)}
      selectedScopeLabel={selectedScopeLabel}
      onClearScope={clearSelection}
    />
  );

  const fileShelf = (
    <FilesShelf
      sectionRef={filesSectionRef}
      fileCardRefs={fileCardRefs}
      workspaceId={workspace.workspace.id}
      workspaceFileEntries={workspaceFileEntries}
      uploading={uploading}
      fileShelfCollapsed={fileShelfCollapsed}
      onToggleCollapsed={() => setFileShelfCollapsed((current) => !current)}
      onUpload={(files) => {
        void handleUpload(files);
      }}
      onOpenFilesPanel={() => void openFilesPanel()}
      filesTileActionLabel={filesTileActionLabel}
      activeFilePillPopover={activeFilePillPopover}
      onSetActiveFilePillPopover={setActiveFilePillPopover}
      highlightedFilePaths={highlightedFilePaths}
      onOpenFileOnCanvas={(file) => {
        void openFileOnCanvas(file);
      }}
      getFileCanvasActionLabel={getFileCanvasActionLabel}
    />
  );

  return (
    <div className="flex-1 flex min-h-0">
      <a
        href="#workspace-canvas"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
        onClick={(event) => {
          event.preventDefault();
          canvasViewportRef.current?.focus();
        }}
      >
        Skip to canvas
      </a>
      <main
        id="workspace-canvas"
        aria-label="Workspace"
        className={`flex-1 min-w-0 flex flex-col transition-[margin] duration-300 ${chatOpen && isDockedChatLayout ? 'mr-[400px]' : ''} ${isDrawerChatLayout && narrowActiveTab !== 'canvas' ? 'hidden' : ''}`}
      >
        <WorkspaceHeader
          workspaceName={workspaceName}
          workspaceDescription={workspaceDescription}
          onNameChange={setWorkspaceName}
          onDescriptionChange={setWorkspaceDescription}
          tileCount={workspaceState.panels.filter((p) => p.type !== 'chat').length}
          fileCount={workspaceFileEntries.length}
          modelCatalog={modelCatalog}
          workspaceModel={workspaceModel}
          onModelChange={(modelId) => void handleModelChange(modelId)}
          onGoHome={onGoHome}
          onRefresh={refreshWorkspace}
          onExport={() => void handleExportDownload()}
          onDelete={() => void onDelete()}
          onSave={() => void handleWorkspaceSave()}
          savingWorkspace={savingWorkspace}
          isCompactHeaderLayout={isCompactHeaderLayout}
          galleryId={workspace.workspace.galleryId}
          publishing={publishing}
          publishableArtifactCount={publishableArtifactCount}
          onUnpublish={() => void handleUnpublish()}
          onOpenPublishModal={() => setPublishModalOpen(true)}
          isDockedChatLayout={isDockedChatLayout}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((current) => !current)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />

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
            role="region"
            aria-label={`Workspace canvas, ${visiblePanels.length} tile${visiblePanels.length === 1 ? '' : 's'}. Tab to a tile, then use arrow keys to move it. Press question mark for keyboard help.`}
            tabIndex={0}
            className="canvas-bg canvas-wrapper flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onPointerDownCapture={handleCanvasPointerDown}
            onPointerMoveCapture={handleCanvasPointerMove}
            onPointerUpCapture={handleCanvasPointerUp}
            onPointerCancelCapture={handleCanvasPointerUp}
            onKeyDown={handleCanvasKeyDown}
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
                    onKeyboardSelect={selectPanel}
                    isFocusTarget={rovingPanelId === panel.id}
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
      </main>
      {isDrawerChatLayout && narrowActiveTab === 'chat' ? (
        <div className="flex-1 min-h-0 chat-panel flex flex-col">
          {chatPanelContent}
        </div>
      ) : null}
      {isDockedChatLayout ? (
        <aside
          aria-label="Agent chat"
          className={`fixed z-30 max-w-full chat-panel flex flex-col transition-transform duration-300 top-[73px] right-0 bottom-0 left-auto w-[400px] ${chatOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          {chatPanelContent}
        </aside>
      ) : null}
      {isDockedChatLayout && !chatOpen ? (
        <button
          onClick={() => setChatOpen(true)}
          className="chat-toggle"
          aria-label="Show chat"
        >
          <MessageSquare size={18} aria-hidden="true" />
        </button>
      ) : null}
      <WorkspaceToast toast={toast} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <PublishDialog
        open={publishModalOpen}
        publishing={publishing}
        title={publishTitle}
        description={publishDescription}
        publishablePanelCount={publishablePanelCount}
        fileCount={workspaceFileEntries.length}
        onTitleChange={setPublishTitle}
        onDescriptionChange={setPublishDescription}
        onClose={() => setPublishModalOpen(false)}
        onPublish={() => void handlePublish()}
      />
      <MaximizedPanelOverlay
        panel={maximizedPanel}
        fileSource={{ kind: 'workspace', id: workspace.workspace.id }}
        allPanels={workspaceState.panels}
        workspaceFiles={workspaceFiles}
        highlightedFilePaths={highlightedFilePaths}
        getFileActionLabel={getFileCanvasActionLabel}
        onOpenFile={(file) => {
          void openFileOnCanvas(file);
        }}
        onClose={() => setMaximizedPanelId(null)}
      />
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
