import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { agentBasePath } from './base-path';
import { toPng } from 'html-to-image';
import { HomePage } from './components/HomePage';
import { CanvasFlow } from './components/canvas/CanvasFlow';
import { ContextualChatPopover } from './components/canvas/ContextualChatPopover';
import { SelectionToolbar } from './components/canvas/SelectionToolbar';
import { ReadOnlyCanvas } from './components/canvas/ReadOnlyCanvas';
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
  ApiError,
  clearWorkspaceDownloads,
  cloneGalleryItem,
  createWorkspace,
  ensureCsrfToken,
  deleteWorkspace,
  fetchGalleryItem,
  fetchGalleryItems,
  fetchWorkspaceDownloads,
  fetchWorkspaceExport,
  fetchWorkspace,
  fetchWorkspaceFiles,
  fetchWorkspaces,
  fetchModels,
  refreshModelCredential,
  ModelsQuotaError,
  ModelsAuthError,
  ModelsUnavailableError,
  importWorkspaceBundle,
  publishWorkspace,
  unpublishGalleryItem,
  updateWorkspace,
  uploadWorkspaceFiles,
  handleAuthRequired,
} from './api';
import { downloadFileSource, type FileSource } from './lib/fileUrls';
import type { ModelCatalog } from './api';
import {
  PANEL_GAP,
  buildPanelLayouts,
  findOpenPanelPosition,
  getGroupBounds,
  getLayoutsBounds,
  inferPanelLayout,
  layoutOverlapsBounds,
  resolveVisibleLayoutCollisions,
  type CanvasPanelLayout,
} from './lib/panelLayout';
import { escapeCsvCell, serializeTableAsCsv } from './lib/csv';
import { computeGroupsDelta } from './lib/groupDelta';
import {
  clearPanelRelationFields,
  connectionEndpointKey,
  findPanelConnection,
  makePanelConnection,
  normalizePanelRelations,
  repairPanelConnectionId,
} from './lib/panelConnections';
import { CANVAS_STEP, CANVAS_LARGE_STEP } from './lib/keyboardMap';
import { KeyboardShortcutsDialog } from './components/workspace/KeyboardShortcutsDialog';
import { makeClientId } from './lib/format';
import { downloadBlob, triggerQueuedDownload } from './lib/download';
import { quotaMessageFromChatError } from './lib/quotaError';
import {
  contextualFailureMessage,
  getContextualTurnMessages,
} from './lib/contextualTurn';
import {
  type ContextualChatTarget,
  type ContextualThreadMessage,
  extractMessageText,
  getContextualStatusLabel,
} from './lib/messages';
import { getChatActivity } from './lib/chatActivity';
import {
  INITIAL_CONTEXTUAL_LIFECYCLE,
  transitionContextualLifecycle,
  type ContextualLifecycleAction,
  type ContextualLifecycleState,
  type ContextualTurnRecord,
} from './lib/contextualLifecycle';
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
  WorkspaceFileInfo,
  WorkspacePanel,
  WorkspaceRecord,
  WorkspaceResponse,
  WorkspaceState,
} from './types';
import { reconcileWorkspaceDraft } from './lib/workspaceDraft';
import { replaceWorkspaceInHomeList } from './lib/workspaceHome';
import {
  useAutomaticLayoutPersistence,
  type AutomaticPanelLayouts,
} from './lib/automaticLayout';
import {
  createViewportPersistenceQueue,
  type ViewportPersistenceQueue,
} from './lib/viewportPersistence';

function WorkspaceShell({
  workspace,
  onWorkspaceRefresh,
  onWorkspaceHomeMetadataUpdate,
  onGoHome,
  onDelete,
  initialPrompt,
  onInitialPromptConsumed,
}: {
  workspace: WorkspaceResponse;
  onWorkspaceRefresh: (workspaceId: string) => Promise<void>;
  onWorkspaceHomeMetadataUpdate: (workspace: WorkspaceRecord) => void;
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
  const [automaticLayoutSaveError, setAutomaticLayoutSaveError] = useState<string | null>(null);
  const [viewportSaveError, setViewportSaveError] = useState<string | null>(null);
  const [chatErrorNotice, setChatErrorNotice] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(workspace.workspace.name);
  const [workspaceDescription, setWorkspaceDescription] = useState(workspace.workspace.description);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [modelQuotaNotice, setModelQuotaNotice] = useState<string | null>(null);
  const [workspaceModel, setWorkspaceModel] = useState<string | undefined>(workspace.workspace.model);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishTitle, setPublishTitle] = useState(workspace.workspace.name);
  const [publishDescription, setPublishDescription] = useState(workspace.workspace.description);
  const [publishing, setPublishing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(
    globalThis.window?.innerWidth ?? 1440
  );
  const [chatOpen, setChatOpen] = useState(
    globalThis.window ? globalThis.window.innerWidth >= 1400 : true
  );
  const [narrowActiveTab, setNarrowActiveTab] = useState<'canvas' | 'chat'>('canvas');
  const [fileShelfCollapsed, setFileShelfCollapsed] = useState(false);
  const [showCanvasHint, setShowCanvasHint] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);
  // Politely-announced messages for screen readers (chat status, uploads,
  // errors). Kept separate from the visual toast so announcements can fire even
  // when there is nothing new to show visually.
  const [announcement, setAnnouncement] = useState('');
  const [highlightedFilePaths, setHighlightedFilePaths] = useState<Set<string>>(new Set());
  const [activeFilePillPopover, setActiveFilePillPopover] = useState<string | null>(null);
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<string>>(new Set());
  const [hoveredPanelId, setHoveredPanelId] = useState<string | null>(null);
  const [hoveredToolbarPanelId, setHoveredToolbarPanelId] = useState<string | null>(null);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [minimizedPanelIds, setMinimizedPanelIds] = useState<Set<string>>(new Set());
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [contextualComposer, setContextualComposer] = useState('');
  const [contextualLifecycle, setContextualLifecycle] = useState<ContextualLifecycleState>(INITIAL_CONTEXTUAL_LIFECYCLE);
  const [contextualThreads, setContextualThreads] = useState<Record<string, ContextualThreadMessage[]>>({});
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const filesSectionRef = useRef<HTMLElement | null>(null);
  const fileCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
  const workspaceFilesRef = useRef(workspace.files);
  const viewportRef = useRef(workspace.state.viewport);
  const viewportInteractionRef = useRef(false);
  const viewportPersistenceRef = useRef<{ workspaceId: string; queue: ViewportPersistenceQueue }>({
    workspaceId: workspace.workspace.id,
    queue: createViewportPersistenceQueue(workspace.workspace.id, workspace.state.viewport),
  });
  if (viewportPersistenceRef.current.workspaceId !== workspace.workspace.id) {
    viewportPersistenceRef.current = {
      workspaceId: workspace.workspace.id,
      queue: createViewportPersistenceQueue(workspace.workspace.id, workspace.state.viewport),
    };
  }
  const [viewportPersistenceRevision, setViewportPersistenceRevision] = useState(0);
  const autoFocusTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const panelLayoutsRef = useRef<Record<string, CanvasPanelLayout>>({});
  const panelSourceRef = useRef<Record<string, string>>({});
  const automaticLayoutPersistenceRef = useRef<ReturnType<typeof useAutomaticLayoutPersistence> | null>(null);
  const clearFileHighlightTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoverClearTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoveredPanelIdRef = useRef<string | null>(null);
  const hoveredToolbarPanelIdRef = useRef<string | null>(null);
  const previousDockedChatRef = useRef<boolean | null>(null);
  const serverWorkspaceRef = useRef(workspace.workspace);
  const pendingWorkspaceMetadataRef = useRef<WorkspaceRecord | null>(null);
  const pendingAutoFocusRef = useRef<Set<string>>(new Set());
  const previousArtifactIdsRef = useRef<Set<string>>(new Set());
  const contextualAutoPanKeyRef = useRef<string | null>(null);
  const initialPromptSentRef = useRef(false);
  const publishOperationIdRef = useRef<string | null>(null);
  const chatStopRef = useRef<() => void>(() => undefined);
  const contextualLifecycleRef = useRef<ContextualLifecycleState>(INITIAL_CONTEXTUAL_LIFECYCLE);

  const transitionContextualTurn = useCallback((action: ContextualLifecycleAction) => {
    const current = contextualLifecycleRef.current;
    const next = transitionContextualLifecycle(current, action);
    if (next === current) return current;
    contextualLifecycleRef.current = next;
    setContextualLifecycle(next);
    return next;
  }, []);
  const contextualChatTarget = contextualLifecycle.target;

  const reconcileWorkspaceFromServer = useCallback((nextWorkspace: WorkspaceRecord) => {
    const previousServer = serverWorkspaceRef.current;
    serverWorkspaceRef.current = nextWorkspace;
    setWorkspaceName((current) => reconcileWorkspaceDraft(
      { name: current, description: '', model: undefined },
      previousServer,
      nextWorkspace,
    ).name);
    setWorkspaceDescription((current) => reconcileWorkspaceDraft(
      { name: '', description: current, model: undefined },
      previousServer,
      nextWorkspace,
    ).description);
    setWorkspaceModel((current) => reconcileWorkspaceDraft(
      { name: '', description: '', model: current },
      previousServer,
      nextWorkspace,
    ).model);
    setPublishTitle((current) => current === previousServer.name ? nextWorkspace.name : current);
    setPublishDescription((current) => current === previousServer.description ? nextWorkspace.description : current);
    // The home list owns this metadata update. The selected workspace keeps
    // its live state/files in this shell; replacing the parent response here
    // would feed its older snapshot back through the same-ID refresh effect.
    onWorkspaceHomeMetadataUpdate(nextWorkspace);
  }, [onWorkspaceHomeMetadataUpdate]);

  const agent = useAgent<WorkspaceAgentClient, WorkspaceState>({
    agent: workspace.agent.className,
    name: workspace.agent.name,
    basePath: agentBasePath(workspace.agent.className, workspace.agent.name),
    // Per-connection CSRF token on the WebSocket upgrade (fleet contract §3¾
    // rule 4). ensureCsrfToken() sources it from the path-scoped
    // cail_csrf_agentstudio cookie (delivery amendment); the browser can't set a
    // custom header on a WS upgrade, so it rides the query string. The DO
    // verifies it once at accept and closes the socket if it is missing/invalid.
    // The explicit basePath keeps the socket under the same deployment mount
    // as the page, API, and path-scoped token cookie.
    query: async () => ({ csrfToken: await ensureCsrfToken() }),
    onStateUpdate: (state) => {
      if (!state.workspace || state.workspace.id !== workspace.workspace.id) return;
      const viewportPersistence = viewportPersistenceRef.current;
      const nextState = viewportInteractionRef.current
        ? { ...state, viewport: viewportRef.current }
        : viewportPersistence.queue.reapply(state);
      viewportRef.current = nextState.viewport;
      const automaticLayoutPersistence = automaticLayoutPersistenceRef.current;
      setWorkspaceState(automaticLayoutPersistence
        ? automaticLayoutPersistence.acknowledgeServerState(nextState)
        : nextState);
      pendingWorkspaceMetadataRef.current = nextState.workspace;
    },
  });
  const agentCallRef = useRef(agent.call);
  agentCallRef.current = agent.call;

  const chat = useAgentChat<WorkspaceState>({
    agent,
    // Keep streamed message/data commits on browser-frame cadence. The
    // installed AI SDK otherwise forwards every provider chunk synchronously;
    // dense tool streams can re-enter React's message store while the Agent
    // broadcasts the state produced by a tool.
    experimental_throttle: 16,
    getInitialMessages: async () => workspace.messages,
    body: () => selectedPanelIds.size > 0
      ? { scopePanelIds: Array.from(selectedPanelIds) }
      : {},
    prepareSendMessagesRequest: async () => {
      await refreshModelCredential(workspace.workspace.id);
      return {};
    },
    onError: (chatError) => {
      // An Agent-owned authentication_required envelope can surface here as a
      // stringified error body. Send the user to the standalone Doorway if so.
      const message = chatError instanceof Error ? chatError.message : String(chatError ?? '');
      if (message.includes('authentication_required')) {
        try {
          const parsed = JSON.parse(message.slice(message.indexOf('{')));
          if (handleAuthRequired(401, parsed)) return;
        } catch {
          // Stream errors that are not a complete canonical envelope remain
          // ordinary chat failures and keep the retry affordance visible.
        }
      }
      // Surface CAIL quota exhaustion distinctly (the stream error text carries a
      // { type: 'quota_exceeded', ... } JSON signal from the worker — see quota-error.ts).
      const quotaMessage = quotaMessageFromChatError(chatError);
      if (quotaMessage) {
        setChatErrorNotice(quotaMessage);
        return;
      }
    },
  });

  const automaticLayoutPersistence = useAutomaticLayoutPersistence({
    workspaceId: workspace.workspace.id,
    chat: {
      status: chat.status,
      isStreaming: chat.isStreaming,
      isServerStreaming: chat.isServerStreaming,
      isRecovering: chat.isRecovering,
      isToolContinuation: chat.isToolContinuation,
    },
    saveLayouts: async (layouts) => {
      await agentCallRef.current('applyLayoutPatch', [{ panels: layouts }]);
    },
    onSaveError: setAutomaticLayoutSaveError,
    onSaveSuccess: () => setAutomaticLayoutSaveError(null),
  });
  automaticLayoutPersistenceRef.current = automaticLayoutPersistence;

  useEffect(() => {
    const controller = viewportPersistenceRef.current;
    if (!controller.queue.hasPending() || controller.queue.hasFailure()) return;

    void controller.queue.flush((viewport) => (
      agentCallRef.current('applyLayoutPatch', [{ viewport }]).then(() => undefined)
    )).then((result) => {
      if (controller !== viewportPersistenceRef.current) return;
      if (result === 'failed') {
        setViewportSaveError('Your canvas view could not be saved. Retry viewport save.');
        return;
      }
      if (result === 'saved') {
        setViewportSaveError(null);
      }
      if ((result === 'saved' || result === 'superseded') && controller.queue.hasPending()) {
        setViewportPersistenceRevision((current) => current + 1);
      }
    });
  }, [viewportPersistenceRevision, workspace.workspace.id]);

  // The pending record lives in a ref so onStateUpdate never renders metadata
  // during a chat message commit. This effect intentionally runs after every
  // render: the ref write itself is not reactive, while both Agent state and
  // chat terminal transitions already provide the render that can safely flush it.
  useEffect(() => {
    if (chat.status !== 'ready' && chat.status !== 'error') return;
    if (chat.isStreaming || chat.isServerStreaming || chat.isRecovering || chat.isToolContinuation) return;
    const nextWorkspace = pendingWorkspaceMetadataRef.current;
    if (!nextWorkspace) return;
    if (nextWorkspace.id !== workspace.workspace.id) {
      pendingWorkspaceMetadataRef.current = null;
      return;
    }

    // useAgentChat owns the message setter and can still be committing stream
    // parts when the Agent broadcasts the state produced by a tool. Apply the
    // header/home-list metadata only after that commit reaches a terminal
    // status, including error: the Durable Object may have persisted the title
    // before a later stream failure.
    pendingWorkspaceMetadataRef.current = null;
    reconcileWorkspaceFromServer(nextWorkspace);
  });

  chatStopRef.current = chat.stop;

  const openContextualTarget = useCallback((target: ContextualChatTarget) => {
    const next = transitionContextualTurn({ type: 'open', target });
    if (next.target?.key === target.key) setContextualComposer('');
  }, [transitionContextualTurn]);

  const sendChatMessage = useCallback((
    text: string,
    options?: Parameters<typeof chat.sendMessage>[1],
  ) => {
    chat.clearError();
    setChatErrorNotice(null);
    return chat.sendMessage({ text }, options);
  }, [chat]);

  const finishContextualTurn = useCallback((
    pending: ContextualTurnRecord,
    reason: 'cancel' | 'error' | 'empty',
  ) => {
    if (
      contextualLifecycleRef.current.phase !== 'active' ||
      contextualLifecycleRef.current.turn.turnId !== pending.turnId
    ) return;
    const content = contextualFailureMessage(reason);
    setContextualThreads((current) => {
      const thread = current[pending.scopeKey] || [];
      const lastMessage = thread[thread.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.content === content) return current;
      return {
        ...current,
        [pending.scopeKey]: [
          ...thread,
          { id: makeClientId('context-assistant-error'), role: 'assistant', content },
        ],
      };
    });
    transitionContextualTurn({ type: 'finish', turnId: pending.turnId });
  }, [transitionContextualTurn]);

  const clearContextualDraft = useCallback(() => {
    setContextualComposer('');
  }, []);

  const closeContextualChat = useCallback(() => {
    // Closing the scoped popover is an explicit local cancellation. Stop the
    // attached stream so a later turn cannot inherit it.
    const pending = contextualLifecycleRef.current.phase === 'active'
      ? contextualLifecycleRef.current.turn
      : null;
    if (pending) {
      void chatStopRef.current();
      finishContextualTurn(pending, 'cancel');
    }
    transitionContextualTurn({ type: 'close' });
    clearContextualDraft();
  }, [clearContextualDraft, finishContextualTurn, transitionContextualTurn]);

  useEffect(() => {
    const previousServer = serverWorkspaceRef.current;
    const workspaceChanged = previousServer.id !== workspace.workspace.id;
    serverWorkspaceRef.current = workspace.workspace;
    pendingWorkspaceMetadataRef.current = null;
    const nextWorkspaceState = viewportPersistenceRef.current.queue.reapply(workspace.state);
    viewportInteractionRef.current = false;
    viewportRef.current = nextWorkspaceState.viewport;
    setWorkspaceState(nextWorkspaceState);
    setWorkspaceFiles(workspace.files);
    workspaceFilesRef.current = workspace.files;
    if (workspaceChanged) {
      setAutomaticLayoutSaveError(null);
      setViewportSaveError(null);
      setWorkspaceName(workspace.workspace.name);
      setWorkspaceDescription(workspace.workspace.description);
      setWorkspaceModel(workspace.workspace.model);
      setPublishModalOpen(false);
      setPublishTitle(workspace.workspace.name);
      setPublishDescription(workspace.workspace.description);
      setSelectedPanelIds(new Set());
      setHoveredPanelId(null);
      setHoveredToolbarPanelId(null);
      setHighlightedFilePaths(new Set());
      setActiveFilePillPopover(null);
      setToast(null);
      setFocusedPanelId(null);
      setEditingGroupId(null);
      setGroupNameInput('');
      setMinimizedPanelIds(new Set());
      setMaximizedPanelId(null);
      setOpenMenuId(null);
      closeContextualChat();
      setContextualThreads({});
      panelSourceRef.current = {};
      previousArtifactIdsRef.current = new Set(
        workspace.state.panels.filter((panel) => panel.type !== 'chat').map((panel) => panel.id)
      );
      contextualAutoPanKeyRef.current = null;
      initialPromptSentRef.current = false;
    } else {
      setWorkspaceName((current) => reconcileWorkspaceDraft(
        { name: current, description: '', model: undefined },
        previousServer,
        workspace.workspace,
      ).name);
      setWorkspaceDescription((current) => reconcileWorkspaceDraft(
        { name: '', description: current, model: undefined },
        previousServer,
        workspace.workspace,
      ).description);
      setWorkspaceModel((current) => reconcileWorkspaceDraft(
        { name: '', description: '', model: current },
        previousServer,
        workspace.workspace,
      ).model);
      setPublishTitle((current) => current === previousServer.name ? workspace.workspace.name : current);
      setPublishDescription((current) => current === previousServer.description ? workspace.workspace.description : current);
    }
    if (workspace.downloads && workspace.downloads.length > 0) {
      workspace.downloads.forEach((download) => {
        triggerQueuedDownload(download);
      });
      void clearWorkspaceDownloads(workspace.workspace.id);
    }
  }, [closeContextualChat, workspace]);

  useEffect(() => {
    let cancelled = false;
    setModelQuotaNotice(null);
    void fetchModels()
      .then((catalog) => {
        if (!cancelled) {
          setModelCatalog(catalog);
          setModelQuotaNotice(null);
        }
      })
      .catch((nextError) => {
        if (cancelled) return;
        if (nextError instanceof ModelsAuthError) {
          setModelQuotaNotice('Your sign-in expired. Sign in again to load models.');
        } else if (nextError instanceof ModelsQuotaError) {
          setModelQuotaNotice("You've used your AI allowance for now. Try again after it resets.");
        } else if (nextError instanceof ModelsUnavailableError) {
          // A 5xx catalog response (including the deliberate 502 for
          // config/secret drift) means a broken deployment — surface a plain
          // notice instead of silently hiding the picker.
          setModelQuotaNotice("Model choices aren't available right now.");
        } else {
          setModelQuotaNotice("Model choices couldn't load. Refresh the workspace to try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.workspace.id]);

  const artifactPanels = useMemo(
    () => workspaceState.panels.filter((panel) => panel.type !== 'chat'),
    [workspaceState.panels]
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
  const selectedPanels = useMemo(
    () => visiblePanels.filter((panel) => selectedPanelIds.has(panel.id)),
    [selectedPanelIds, visiblePanels]
  );
  const selectedConnection = useMemo(
    () => selectedPanels.length === 2
      ? findPanelConnection(workspaceState.connections, selectedPanels[0].id, selectedPanels[1].id) ?? null
      : null,
    [selectedPanels, workspaceState.connections]
  );
  const selectedConnectionIds = useMemo(
    () => selectedConnection ? new Set([selectedConnection.id]) : new Set<string>(),
    [selectedConnection]
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
      .filter((layout): layout is CanvasPanelLayout => layout !== undefined);
    return getLayoutsBounds(layouts);
  }, [panelLayouts, selectedPanels]);
  const contextualAnchor = useMemo(() => {
    if (!contextualChatTarget) return null;
    const layouts = contextualChatTarget.panelIds
      .map((panelId) => panelLayouts[panelId])
      .filter((layout): layout is CanvasPanelLayout => layout !== undefined);
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
  const contextualTurn = contextualLifecycle.phase === 'active' ? contextualLifecycle.turn : null;
  const contextualAssistantMessage = useMemo(
    () => contextualTurn ? getContextualTurnMessages(chat.messages, contextualTurn).assistantMessage : null,
    [chat.messages, contextualTurn]
  );
  const contextualStatusLabel = contextualChatTarget && contextualTurn?.scopeKey === contextualChatTarget.key
    ? getContextualStatusLabel(chat.status, contextualAssistantMessage) || 'Thinking...'
    : null;
  const contextualIsLoading = Boolean(
    contextualChatTarget && contextualTurn?.scopeKey === contextualChatTarget.key && chat.status !== 'error'
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
    if (selectedPanels.length === 1) return `Asking about ${getPanelTitle(selectedPanels[0])}`;
    return `Asking about ${selectedPanels.length} tiles`;
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
    }

    previousArtifactIdsRef.current = nextIds;
  }, [artifactPanels]);

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
      const target = event.target instanceof Element ? event.target : null;
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
      transitionContextualTurn({ type: 'hide', panelIds: contextualChatTarget.panelIds });
      clearContextualDraft();
    }
  }, [clearContextualDraft, contextualChatTarget, transitionContextualTurn, visiblePanels]);


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

  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
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

  const persistViewport = useCallback((viewport: WorkspaceState['viewport']) => {
    const controller = viewportPersistenceRef.current;
    if (controller.queue.enqueue(viewport)) {
      setViewportPersistenceRevision((current) => current + 1);
    }
  }, []);

  const updateViewport = useCallback((updater: (current: WorkspaceState['viewport']) => WorkspaceState['viewport']) => {
    const nextViewport = updater(viewportRef.current);
    if (
      nextViewport.x === viewportRef.current.x &&
      nextViewport.y === viewportRef.current.y &&
      nextViewport.zoom === viewportRef.current.zoom
    ) {
      return nextViewport;
    }
    viewportRef.current = nextViewport;
    setWorkspaceState((current) => {
      if (
        nextViewport.x === current.viewport.x &&
        nextViewport.y === current.viewport.y &&
        nextViewport.zoom === current.viewport.zoom
      ) {
        return current;
      }
      return {
        ...current,
        viewport: nextViewport,
      };
    });
    return nextViewport;
  }, []);

  const handleViewportChange = useCallback((nextViewport: WorkspaceState['viewport']) => {
    viewportInteractionRef.current = true;
    updateViewport(() => nextViewport);
  }, [updateViewport]);

  const handleViewportChangeEnd = useCallback((nextViewport: WorkspaceState['viewport']) => {
    updateViewport(() => nextViewport);
    viewportInteractionRef.current = false;
    persistViewport(nextViewport);
  }, [persistViewport, updateViewport]);

  const focusCanvasBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    if (!canvasViewportRef.current) return;
    const viewportWidth = canvasViewportRef.current.clientWidth;
    const viewportHeight = canvasViewportRef.current.clientHeight;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    const nextViewport = updateViewport((current) => ({
      ...current,
      x: viewportWidth / 2 - centerX * current.zoom,
      y: viewportHeight / 2 - centerY * current.zoom,
    }));
    persistViewport(nextViewport);
  }, [persistViewport, updateViewport]);

  useEffect(() => {
    if (!contextualChatTarget) {
      contextualAutoPanKeyRef.current = null;
      return;
    }

    if (contextualAutoPanKeyRef.current === contextualChatTarget.key) return;

    const layouts = contextualChatTarget.panelIds
      .map((panelId) => panelLayouts[panelId])
      .filter((layout): layout is CanvasPanelLayout => layout !== undefined);
    const bounds = getLayoutsBounds(layouts);
    if (!bounds) return;

    contextualAutoPanKeyRef.current = contextualChatTarget.key;
    focusCanvasBounds(bounds);
  }, [contextualChatTarget, focusCanvasBounds, panelLayouts]);

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

  useEffect(() => {
    if (automaticLayoutSaveError) announce(automaticLayoutSaveError);
  }, [announce, automaticLayoutSaveError]);

  useEffect(() => {
    if (viewportSaveError) announce(viewportSaveError);
  }, [announce, viewportSaveError]);

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

  const handleFileDownload = useCallback((source: FileSource, filePath: string, filename: string) => {
    setError(null);
    void downloadFileSource(source, filePath, filename).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : 'The file didn’t download. Try again.');
    });
  }, []);

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

  const handleConnectionClick = useCallback((connection: WorkspaceState['connections'][number]) => {
    const endpointIds = [connection.sourceId, connection.targetId]
      .filter((panelId) => visiblePanelIds.has(panelId));
    if (endpointIds.length !== 2) return;
    setFocusedPanelId(connection.targetId);
    setSelectedPanelIds(new Set(endpointIds));
  }, [visiblePanelIds]);

  const refreshWorkspace = useCallback(async () => {
    await onWorkspaceRefresh(workspace.workspace.id);
  }, [onWorkspaceRefresh, workspace.workspace.id]);

  const handleUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await uploadWorkspaceFiles(workspace.workspace.id, files);
      await refreshWorkspaceFiles();
      showToast(`Uploaded ${files.length} file${files.length !== 1 ? 's' : ''}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Your files didn’t upload. Try again.');
    } finally {
      setUploading(false);
    }
  }, [refreshWorkspaceFiles, showToast, workspace.workspace.id]);

  const openFileOnCanvas = useCallback(async (file: WorkspaceFileInfo) => {
    highlightWorkspaceFiles([file.path], { scroll: false });

    if (!canOpenFileInPanel(file.path)) {
      handleFileDownload(
        { kind: 'workspace', id: workspace.workspace.id },
        file.path,
        file.name,
      );
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
  }, [agent, focusTile, getExistingFileTileId, handleFileDownload, highlightWorkspaceFiles, workspace.workspace.id]);

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
    const automaticLayoutPersistence = automaticLayoutPersistenceRef.current;
    automaticLayoutPersistence?.recordRemoved([panelId]);
    if (!automaticLayoutPersistence?.hasFailure()) setAutomaticLayoutSaveError(null);
    try {
      const nextState = await agent.call('removePanel', [panelId]);
      if (
        automaticLayoutPersistence
        && automaticLayoutPersistenceRef.current === automaticLayoutPersistence
        && (!nextState.workspace || nextState.workspace.id === workspace.workspace.id)
      ) {
        setWorkspaceState(automaticLayoutPersistence.acknowledgeServerState(nextState));
      }
    } catch (nextError) {
      if (automaticLayoutPersistence && automaticLayoutPersistenceRef.current === automaticLayoutPersistence) {
        automaticLayoutPersistence.cancelRemoved([panelId]);
        setError(nextError instanceof Error ? nextError.message : 'The tile could not be removed. Try again.');
      }
      throw nextError;
    }
  }, [agent, workspace.workspace.id]);

  const saveGroups = useCallback(async (groups: WorkspaceState['groups']) => {
    // Every caller computes `groups` from the same workspaceState.groups
    // snapshot this callback closes over, so diffing against it yields exactly
    // what THIS edit changed. The server merges groups per id, so sending only
    // the delta (plus explicit removals) keeps a concurrent edit to a
    // different group in another tab alive (V3).
    const { upserts, removeIds } = computeGroupsDelta(workspaceState.groups, groups);
    setWorkspaceState((current) => ({
      ...current,
      groups,
    }));
    if (upserts.length === 0 && removeIds.length === 0) return;
    const patch: Parameters<WorkspaceAgentClient['applyLayoutPatch']>[0] = {};
    if (upserts.length > 0) patch.groups = upserts;
    if (removeIds.length > 0) patch.removeGroups = removeIds;
    await agent.call('applyLayoutPatch', [patch]);
  }, [agent, workspaceState.groups]);

  const toggleSelectedConnection = useCallback(async () => {
    if (selectedPanels.length !== 2) return;

    const [firstPanel, secondPanel] = selectedPanels;
    const currentConnection = findPanelConnection(
      workspaceState.connections,
      firstPanel.id,
      secondPanel.id,
    );

    if (currentConnection) {
      setWorkspaceState((current) => {
        const panels = clearPanelRelationFields(current.panels, [currentConnection]);
        const relations = normalizePanelRelations(
          panels,
          current.connections.filter((connection) => connection.id !== currentConnection.id),
        );
        return { ...current, ...relations };
      });
      try {
        await agent.call('applyLayoutPatch', [{ removeConnections: [currentConnection.id] }]);
        showToast(`Disconnected ${getPanelTitle(firstPanel)} and ${getPanelTitle(secondPanel)}`);
      } catch (nextError) {
        setWorkspaceState((current) => ({
          ...current,
          ...normalizePanelRelations(current.panels, [...current.connections, currentConnection]),
        }));
        setError(nextError instanceof Error ? nextError.message : 'The tile association could not be removed.');
      }
      return;
    }

    const nextConnection = repairPanelConnectionId(
      makePanelConnection(firstPanel.id, secondPanel.id),
      workspaceState.connections,
    );
    setWorkspaceState((current) => {
      return {
        ...current,
        ...normalizePanelRelations(current.panels, [...current.connections, nextConnection]),
      };
    });
    try {
      await agent.call('applyLayoutPatch', [{ connections: [nextConnection] }]);
      showToast(`Associated ${getPanelTitle(firstPanel)} and ${getPanelTitle(secondPanel)}`);
    } catch (nextError) {
      setWorkspaceState((current) => ({
        ...current,
        ...normalizePanelRelations(
          current.panels,
          current.connections.filter((connection) => connectionEndpointKey(connection.sourceId, connection.targetId)
            !== connectionEndpointKey(nextConnection.sourceId, nextConnection.targetId)),
        ),
      }));
      setError(nextError instanceof Error ? nextError.message : 'The tile association could not be saved.');
    }
  }, [agent, selectedPanels, showToast, workspaceState.connections]);

  const removeConnection = useCallback(async (connectionId: string) => {
    const connection = workspaceState.connections.find((entry) => entry.id === connectionId);
    if (!connection) return;

    setWorkspaceState((current) => {
      const panels = clearPanelRelationFields(current.panels, [connection]);
      return {
        ...current,
        ...normalizePanelRelations(
          panels,
          current.connections.filter((entry) => entry.id !== connection.id),
        ),
      };
    });

    try {
      await agent.call('applyLayoutPatch', [{ removeConnections: [connection.id] }]);
      showToast('Association removed');
    } catch (nextError) {
      setWorkspaceState((current) => ({
        ...current,
        ...normalizePanelRelations(current.panels, [...current.connections, connection]),
      }));
      setError(nextError instanceof Error ? nextError.message : 'The tile association could not be removed.');
    }
  }, [agent, showToast, workspaceState.connections]);

  const savePanelLayouts = useCallback(async (layouts: Record<string, { x: number; y: number; width?: number; height?: number }>) => {
    const manualLayouts: AutomaticPanelLayouts = {};
    for (const [panelId, layout] of Object.entries(layouts)) {
      const baseLayout = panelLayoutsRef.current[panelId];
      if (!baseLayout) continue;
      manualLayouts[panelId] = { ...baseLayout, ...layout };
    }
    automaticLayoutPersistenceRef.current?.recordManualLayouts(manualLayouts);
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

  const queueAutomaticPanelLayouts = useCallback((layouts: AutomaticPanelLayouts) => {
    const automaticLayoutPersistence = automaticLayoutPersistenceRef.current;
    if (!automaticLayoutPersistence?.enqueue(layouts)) return;
    setWorkspaceState((current) => automaticLayoutPersistence.reapply(current));
  }, []);

  const retryAutomaticPanelLayouts = useCallback(() => {
    setAutomaticLayoutSaveError(null);
    automaticLayoutPersistenceRef.current?.retry();
  }, []);

  useEffect(() => {
    const gap = PANEL_GAP;
    const occupiedRects: CanvasPanelLayout[] = [];
    const addedLayouts: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const canvasWidth = canvasViewportRef.current?.clientWidth || globalThis.window?.innerWidth || 1440;
    const canvasHeight = canvasViewportRef.current?.clientHeight || globalThis.window?.innerHeight || 900;

    const overlaps = (x: number, y: number, width: number, height: number) => occupiedRects.some((rect) => !(
      x + width + gap <= rect.x ||
      rect.x + rect.width + gap <= x ||
      y + height + gap <= rect.y ||
      rect.y + rect.height + gap <= y
    ));

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
            const position = findOpenPanelPosition(
              occupiedRects,
              width,
              height,
              workspaceState.viewport,
              { width: canvasWidth, height: canvasHeight },
            );
            x = position.x;
            y = position.y;
          }
        }

        delete panelSourceRef.current[panel.id];
      } else {
        const position = findOpenPanelPosition(
          occupiedRects,
          width,
          height,
          workspaceState.viewport,
          { width: canvasWidth, height: canvasHeight },
        );
        x = position.x;
        y = position.y;
      }

      const nextLayout = { x, y, width, height };
      addedLayouts[panel.id] = nextLayout;
      occupiedRects.push(nextLayout);
    });

    if (Object.keys(addedLayouts).length > 0) {
      queueAutomaticPanelLayouts(addedLayouts);
    }
  }, [panelLayouts, queueAutomaticPanelLayouts, visiblePanels, workspaceState.viewport]);

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
        .filter((layout): layout is CanvasPanelLayout => layout !== undefined);
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
    // A direct user edit supersedes an automatic placement that has not yet
    // reached the server. The drag/resize save below remains authoritative.
    const baseLayout = panelLayoutsRef.current[panelId];
    if (baseLayout) {
      automaticLayoutPersistenceRef.current?.recordManualLayouts({
        [panelId]: { ...baseLayout, ...layout },
      });
    } else {
      automaticLayoutPersistenceRef.current?.discard([panelId]);
    }
    if (!automaticLayoutPersistenceRef.current?.hasFailure()) setAutomaticLayoutSaveError(null);
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

    const groupPanelIds = new Set(group.panelIds);
    const nextLayouts: AutomaticPanelLayouts = {};
    workspaceState.panels.forEach((panel, index) => {
      if (!groupPanelIds.has(panel.id)) return;
      const baseLayout = panelLayoutsRef.current[panel.id] ?? inferPanelLayout(panel, index);
      nextLayouts[panel.id] = {
        ...baseLayout,
        x: baseLayout.x + dx,
        y: baseLayout.y + dy,
      };
    });
    automaticLayoutPersistenceRef.current?.recordManualLayouts(nextLayouts);

    setWorkspaceState((current) => {
      const nextPanels = current.panels.map((panel) => {
        const nextLayout = nextLayouts[panel.id];
        if (!nextLayout) return panel;
        return {
          ...panel,
          layout: nextLayout,
        };
      });
      panelLayoutsRef.current = {
        ...panelLayoutsRef.current,
        ...nextLayouts,
      };
      return {
        ...current,
        panels: nextPanels,
      };
    });
  }, [workspaceState.groups, workspaceState.panels]);

  const handleGroupDragEnd = useCallback(async (groupId: string) => {
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
    if (panelIds.length === 0) return false;
    const label = panelIds.length === 1 ? 'this tile' : `these ${panelIds.length} tiles`;
    if (!window.confirm(`Remove ${label} from the canvas? Workspace files won't be deleted.`)) {
      return false;
    }
    for (const panelId of panelIds) {
      await removePanel(panelId);
    }
    return true;
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
    const target = contextualLifecycleRef.current.target;
    if (target && target.panelIds.some((panelId) => panelIdSet.has(panelId))) {
      transitionContextualTurn({ type: 'hide', panelIds });
      clearContextualDraft();
    }
    if (maximizedPanelId && panelIdSet.has(maximizedPanelId)) {
      setMaximizedPanelId(null);
    }
  }, [clearContextualDraft, maximizedPanelId, transitionContextualTurn]);

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

  const handleContextualSubmit = useCallback(() => {
    const next = contextualComposer.trim();
    const target = contextualLifecycle.target;
    if (!target || !next || contextualLifecycle.phase !== 'idle') return;
    if (
      chat.status === 'submitted' ||
      chat.status === 'streaming' ||
      chat.isStreaming ||
      chat.isServerStreaming ||
      chat.isRecovering ||
      chat.isToolContinuation
    ) return;

    const previousAssistantId = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'assistant')?.id || null;
    const turnId = makeClientId('context-turn');
    const pending: ContextualTurnRecord = {
      turnId,
      scopeKey: target.key,
      previousAssistantId,
      previousMessageIds: new Set(chat.messages.map((message) => message.id)),
      userMessageId: null,
    };

    setContextualThreads((current) => ({
      ...current,
      [target.key]: [
        ...(current[target.key] || []),
        {
          id: makeClientId('context-user'),
          role: 'user',
          content: next,
        },
      ],
    }));
    transitionContextualTurn({ type: 'submit', turn: pending });
    const request = sendChatMessage(next, {
      body: { scopePanelIds: target.panelIds },
    });
    void request.catch(() => finishContextualTurn(pending, 'error'));
    setContextualComposer('');
  }, [chat, contextualComposer, contextualLifecycle, finishContextualTurn, sendChatMessage, transitionContextualTurn]);

  const handleChatClear = useCallback(() => {
    chat.clearHistory();
    chat.clearError();
    setChatErrorNotice(null);
  }, [chat]);

  const handleChatRetry = useCallback(() => {
    setChatErrorNotice(null);
    if (chat.regenerate) {
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
      setError('That tile is no longer on the canvas. Refresh the workspace and try again.');
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
      setError(nextError instanceof ApiError ? nextError.message : 'The tile image didn’t export. Try again.');
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
      handleFileDownload(
        { kind: 'workspace', id: workspace.workspace.id },
        panel.filePath,
        getFileName(panel.filePath),
      );
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
  }, [downloadPanelAsPng, handleFileDownload, workspace.workspace.id]);

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
        minimizePanels([panelId]);
      }}
      onMaximize={setMaximizedPanelId}
      onSetMaximizedPanelId={setMaximizedPanelId}
      onRemovePanel={(panelId) => {
        void removePanels([panelId]);
      }}
    />
  ), [
    handlePanelDownload,
    maximizedPanelId,
    minimizePanels,
    openContextualChatForPanel,
    revealFileInWorkspace,
    removePanels,
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
      setError(nextError instanceof ApiError ? nextError.message : 'The workspace didn’t save. Check your connection and try again.');
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
      setError(nextError instanceof ApiError ? nextError.message : 'The model didn’t change. Try again.');
    }
  }, [refreshWorkspace, workspace.workspace.id, workspaceModel]);

  const handleOpenPublishModal = useCallback(() => {
    setPublishTitle(workspaceName);
    setPublishDescription(workspaceDescription);
    publishOperationIdRef.current = crypto.randomUUID();
    setPublishModalOpen(true);
  }, [workspaceDescription, workspaceName]);

  const handlePublish = useCallback(async () => {
    const nextTitle = publishTitle.trim();
    const nextDescription = publishDescription.trim();
    if (!nextTitle || !nextDescription) return;
    setPublishing(true);
    setError(null);
    try {
      await publishWorkspace(workspace.workspace.id, {
        title: nextTitle,
        description: nextDescription,
        operationId: publishOperationIdRef.current ?? crypto.randomUUID(),
      });
      publishOperationIdRef.current = null;
      setPublishModalOpen(false);
      await refreshWorkspace();
      showToast('Published to gallery');
    } catch (nextError) {
      setError(nextError instanceof ApiError ? nextError.message : 'Publishing didn’t finish. Try again.');
    } finally {
      setPublishing(false);
    }
  }, [publishDescription, publishTitle, refreshWorkspace, showToast, workspace.workspace.id]);

  const handleUnpublish = useCallback(async () => {
    if (!workspace.workspace.galleryId) return;
    if (!window.confirm('Remove this workspace from the gallery? Your workspace and files will stay private to you.')) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      await unpublishGalleryItem(workspace.workspace.galleryId);
      await refreshWorkspace();
      showToast('Removed from gallery', 'info');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'The workspace is still public. Try unpublishing again.');
    } finally {
      setPublishing(false);
    }
  }, [refreshWorkspace, showToast, workspace.workspace.galleryId]);

  const handleExportDownload = useCallback(async () => {
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
    }
  }, [workspace.workspace.id]);

  useEffect(() => {
    const pending = contextualLifecycleRef.current.phase === 'active'
      ? contextualLifecycleRef.current.turn
      : null;
    if (!pending) return;

    const chatStillWorking = chat.status === 'submitted'
      || chat.status === 'streaming'
      || chat.isStreaming
      || chat.isServerStreaming
      || chat.isRecovering
      || chat.isToolContinuation;
    // The status can briefly be terminal while a server/tool continuation or
    // recovery is still active. Keep the contextual turn open until every
    // maintained activity flag is idle, otherwise an intermediate error or
    // empty assistant message would make the next response disappear.
    if (chatStillWorking) return;

    if (chat.status === 'error') {
      finishContextualTurn(pending, 'error');
      return;
    }

    const turnMessages = getContextualTurnMessages(chat.messages, pending);
    if (turnMessages.userMessageId) pending.userMessageId = turnMessages.userMessageId;
    const assistantMessage = turnMessages.assistantMessage;

    if (assistantMessage) {
      const content = extractMessageText(assistantMessage);
      if (content.trim()) {
        setContextualThreads((current) => {
          const thread = current[pending.scopeKey] || [];
          const existingIndex = thread.findIndex((message) => message.id === assistantMessage.id);
          if (existingIndex >= 0) {
            const next = [...thread];
            next[existingIndex] = { ...next[existingIndex], content };
            return { ...current, [pending.scopeKey]: next };
          }
          return {
            ...current,
            [pending.scopeKey]: [
              ...thread,
              { id: assistantMessage.id, role: 'assistant', content },
            ],
          };
        });
      }
    }

    if (chat.status === 'ready') {
      if (assistantMessage && extractMessageText(assistantMessage).trim()) {
        transitionContextualTurn({ type: 'finish', turnId: pending.turnId });
      } else {
        finishContextualTurn(pending, 'empty');
      }
    }
  }, [
    chat.isRecovering,
    chat.isServerStreaming,
    chat.isStreaming,
    chat.isToolContinuation,
    chat.messages,
    chat.status,
    finishContextualTurn,
    transitionContextualTurn,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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

      // When 2+ tiles are selected, arrows nudge the whole selection. CanvasFlow
      // handles a single focused tile's keyboard movement and resize bindings.
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

  const contextualTurnActive = contextualLifecycle.phase === 'active';
  const handleChatStop = useCallback(() => {
    const pending = contextualLifecycleRef.current.phase === 'active'
      ? contextualLifecycleRef.current.turn
      : null;
    void chatStopRef.current();
    if (pending) finishContextualTurn(pending, 'cancel');
  }, [finishContextualTurn]);

  const chatActivity = getChatActivity({
    status: chat.status,
    isStreaming: chat.isStreaming,
    isServerStreaming: chat.isServerStreaming,
    isRecovering: chat.isRecovering,
    isToolContinuation: chat.isToolContinuation,
    contextualTurnActive,
    canRetry: Boolean(lastUserPrompt),
  });

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
      activity={chatActivity}
      messages={chat.messages}
      composer={composer}
      onComposerChange={setComposer}
      onSubmit={(text) => void sendChatMessage(text)}
      onStop={handleChatStop}
      onClear={handleChatClear}
      onRetry={handleChatRetry}
      errorNotice={chatErrorNotice}
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
      onDownloadFile={handleFileDownload}
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
          modelQuotaNotice={modelQuotaNotice}
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
          onOpenPublishModal={handleOpenPublishModal}
          isDockedChatLayout={isDockedChatLayout}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((current) => !current)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />

        {error || automaticLayoutSaveError || viewportSaveError ? (
          <div className="px-6 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive animate-fade-in">
            <div className="flex items-center justify-between gap-3">
              <span>{automaticLayoutSaveError || viewportSaveError || error}</span>
              {automaticLayoutSaveError ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium hover:bg-destructive/10"
                  onClick={retryAutomaticPanelLayouts}
                >
                  Retry layout save
                </button>
              ) : null}
              {viewportSaveError ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium hover:bg-destructive/10"
                  onClick={() => {
                    setViewportSaveError(null);
                    viewportPersistenceRef.current.queue.retry();
                    setViewportPersistenceRevision((current) => current + 1);
                  }}
                >
                  Retry viewport save
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {isDrawerChatLayout ? (
          <div className="flex-shrink-0 flex items-center gap-1 px-4 py-1.5 border-b border-border/50 bg-card/40 backdrop-blur-sm">
            <div className="inline-flex rounded-lg bg-muted/60 p-0.5" role="tablist" aria-label="Workspace view">
              <button
                id="canvas-tab"
                role="tab"
                aria-selected={narrowActiveTab === 'canvas'}
                aria-controls="canvas-panel"
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
                id="chat-tab"
                role="tab"
                aria-selected={narrowActiveTab === 'chat'}
                aria-controls="chat-panel"
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

        <div
          id="canvas-panel"
          role="tabpanel"
          aria-labelledby="canvas-tab"
          className="flex-1 flex flex-col min-h-0 relative"
        >
          <div className="canvas-header flex items-center justify-between px-4 py-2 z-10">
            <div />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {visibleConnections.length > 0 ? (
                <span aria-label={`${visibleConnections.length} tile association${visibleConnections.length === 1 ? '' : 's'}`}>
                  {visibleConnections.length} association{visibleConnections.length === 1 ? '' : 's'}
                </span>
              ) : null}
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

          <CanvasFlow
            viewportRef={canvasViewportRef}
            panels={visiblePanels}
            allPanels={workspaceState.panels}
            groups={workspaceState.groups}
            connections={visibleConnections}
            viewport={workspaceState.viewport}
            workspaceFiles={workspaceFiles}
            fileSource={{ kind: 'workspace', id: workspace.workspace.id }}
            selectedPanelIds={selectedPanelIds}
            selectedConnectionIds={selectedConnectionIds}
            focusedPanelId={focusedPanelId}
            openMenuId={openMenuId}
            renderPanelMenu={renderPanelMenuContent}
            highlightedFilePaths={highlightedFilePaths}
            getFileActionLabel={getFileCanvasActionLabel}
            onOpenFile={(file) => {
              void openFileOnCanvas(file);
            }}
            onDownloadFile={handleFileDownload}
            onPanelRef={(panelId, node) => {
              panelRefs.current[panelId] = node;
            }}
            onOpenMenu={setOpenMenuId}
            onPanelLayoutChange={handlePanelLayoutChange}
            onPanelDragStart={handlePanelDragStart}
            onPanelDragEnd={handlePanelDragEnd}
            onPanelDelete={(panelIds) => {
              void removePanels(panelIds).then((removed) => {
                if (removed) clearSelection();
              });
            }}
            onConnectionDelete={(connectionId) => {
              void removeConnection(connectionId);
            }}
            onConnectionClick={handleConnectionClick}
            onSelectionChange={(panelIds) => {
              setSelectedPanelIds((current) => {
                if (current.size === panelIds.length && panelIds.every((panelId) => current.has(panelId))) {
                  return current;
                }
                return new Set(panelIds);
              });
            }}
            onPaneClick={() => {
              clearSelection();
              closeContextualChat();
            }}
            onNodeDoubleClick={(panelId) => {
              clearSelection();
              openContextualChatForPanel(panelId);
            }}
            onNodeFocus={setFocusedPanelId}
            onNodeHover={(panelId) => {
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
            onGroupClick={handleGroupClick}
            onGroupRename={(groupId, newName) => {
              void renameGroup(groupId, newName);
            }}
            onGroupDrag={handleGroupDrag}
            onGroupDragEnd={handleGroupDragEnd}
            editingGroupId={editingGroupId}
            groupNameInput={groupNameInput}
            onGroupNameInputChange={setGroupNameInput}
            onEditGroupStart={(groupId) => {
              const nextGroup = workspaceState.groups.find((entry) => entry.id === groupId);
              setEditingGroupId(groupId);
              setGroupNameInput(nextGroup?.name || '');
            }}
            onViewportChange={handleViewportChange}
            onViewportChangeEnd={handleViewportChangeEnd}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            emptyState={visiblePanels.length === 0 ? (
              <div className="canvas-empty pointer-events-none absolute inset-0">
                <Sparkles className="canvas-empty-icon" />
                <h3>{minimizedPanels.length > 0 ? 'All Minimized' : 'Empty Canvas'}</h3>
                <p>
                  {minimizedPanels.length > 0
                    ? 'All visible tiles are minimized. Restore them from the dock to continue.'
                    : 'Ask the agent to create files, markdown, tables, charts, and previews.'}
                </p>
              </div>
            ) : null}
          >
            {showToolbar ? (
              <SelectionToolbar
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
                onToggleConnection={selectedPanels.length === 2 ? () => void toggleSelectedConnection() : undefined}
                isConnected={Boolean(selectedConnection)}
                onUngroup={selectedGroup ? () => void ungroupSelection() : undefined}
                isInGroup={Boolean(toolbarSinglePanelGroup)}
                onRemoveFromGroup={toolbarSinglePanelGroup && toolbarPanel ? () => void removePanelFromGroup(toolbarPanel.id) : undefined}
                onRemove={selectedPanelIds.size > 0 ? () => {
                  const panelIds = selectedPanels.map((panel) => panel.id);
                  void removePanels(panelIds).then((removed) => {
                    if (removed) clearSelection();
                  });
                } : (toolbarPanel ? () => {
                  void removePanels([toolbarPanel.id]);
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
              <ContextualChatPopover
                anchor={contextualAnchor}
                viewport={workspaceState.viewport}
                viewportSize={canvasViewportSize}
                title={contextualChatTarget.title}
                typeLabel={contextualChatTarget.typeLabel}
                messages={contextualMessages}
                input={contextualComposer}
                statusLabel={contextualStatusLabel}
                isLoading={contextualIsLoading}
                onInputChange={setContextualComposer}
                onSubmit={handleContextualSubmit}
                onClose={closeContextualChat}
                onDismiss={() => {
                  transitionContextualTurn({ type: 'hide', panelIds: contextualChatTarget.panelIds });
                  clearContextualDraft();
                }}
              />
            ) : null}
          </CanvasFlow>
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
        <div id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" className="flex-1 min-h-0 chat-panel flex flex-col">
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
        onDownloadFile={handleFileDownload}
        onClose={() => setMaximizedPanelId(null)}
      />
    </div>
  );
}

export default function App() {
  const browserLocation = globalThis.window?.location;
  const initialWorkspaceId = browserLocation
    ? new URL(browserLocation.href).searchParams.get('workspace')
    : null;
  const initialGalleryId = browserLocation
    ? new URL(browserLocation.href).searchParams.get('gallery')
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

  const loadHome = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadWorkspaces(), loadGallery()]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Agent Studio couldn't load. Try again.");
    }
  }, [loadGallery, loadWorkspaces]);

  const loadWorkspace = useCallback(async (workspaceId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWorkspace(workspaceId);
      setSelectedWorkspace(response);
      setSelectedWorkspaceId(workspaceId);
    } catch (nextError) {
      setError(nextError instanceof ApiError ? nextError.message : 'The workspace didn’t load. Reload the page to try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWorkspaceHomeMetadataUpdate = useCallback((nextWorkspace: WorkspaceRecord) => {
    setWorkspaces((current) => replaceWorkspaceInHomeList(current, nextWorkspace));
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

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
      if (!selectedGalleryId) setLoading(false);
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
    setLoading(true);

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

  const handleDeleteWorkspace = useCallback(async (): Promise<boolean> => {
    if (!selectedWorkspaceId) return false;
    setError(null);
    try {
      await deleteWorkspace(selectedWorkspaceId);
      await loadWorkspaces();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete workspace');
      return false;
    }
  }, [loadWorkspaces, selectedWorkspaceId]);

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

  const handleOpenGalleryItem = useCallback((galleryId: string) => {
    setError(null);
    setSelectedGallery(null);
    setSelectedWorkspaceId(null);
    setSelectedGalleryId(galleryId);
  }, []);

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
      setError(nextError instanceof Error ? nextError.message : 'Importing didn’t work. Make sure it’s a workspace file exported from Agent Studio.');
      setLoading(false);
    } finally {
      setImporting(false);
    }
  }, [loadWorkspaces]);

  const handleCreateWorkspace = useCallback(async (prompt?: string) => {
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace({ name: 'New Workspace' });
      await loadWorkspaces();
      setPendingInitialPrompt(prompt ? { workspaceId: workspace.id, prompt } : null);
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
          <button
            className="ml-4 underline"
            onClick={selectedWorkspaceId || selectedGalleryId ? handleGoHome : () => void loadHome()}
          >
            {selectedWorkspaceId || selectedGalleryId ? 'Go home' : 'Try again'}
          </button>
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
          onGoHome={handleGoHome}
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
              const workspaceName = selectedWorkspace.workspace.name.trim() || 'Untitled workspace';
              const confirmed = window.confirm(
                `Delete “${workspaceName}”? This permanently removes its chat, files, and canvas. You can’t undo this.`
              );
              if (!confirmed) return;
              if (await handleDeleteWorkspace()) {
                handleGoHome();
              }
            }}
            onWorkspaceRefresh={async (workspaceId) => {
              await loadWorkspace(workspaceId);
              await loadWorkspaces();
              await loadGallery();
            }}
            onWorkspaceHomeMetadataUpdate={handleWorkspaceHomeMetadataUpdate}
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
      onCreateWorkspace={(prompt) => handleCreateWorkspace(prompt)}
      onSelectWorkspace={(id) => {
        setPendingInitialPrompt(null);
        setSelectedGalleryId(null);
        setSelectedWorkspaceId(id);
      }}
      onOpenGalleryItem={handleOpenGalleryItem}
      onCloneGalleryItem={handleCloneGalleryItem}
      onStartBlank={() => handleCreateWorkspace()}
      onImportWorkspace={handleImportBundle}
      busy={creating || importing}
      importing={importing}
    />
  );
}
