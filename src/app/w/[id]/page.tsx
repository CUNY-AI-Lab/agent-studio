'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { DraggablePanel } from '@/components/canvas/DraggablePanel';
import { ContextualChatPopover } from '@/components/canvas/ContextualChatPopover';
import { ConnectionLines } from '@/components/canvas/ConnectionLines';
import { SelectionBox } from '@/components/canvas/SelectionBox';
import { GroupBoundary } from '@/components/canvas/GroupBoundary';
import { SelectionToolbar } from '@/components/canvas/SelectionToolbar';
import {
  Bar, BarChart, Line, LineChart, Pie, PieChart, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Cell
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { SafeMarkdown } from '@/components/SafeMarkdown';
import { toPng } from 'html-to-image';
import { useTheme } from '@/components/ThemeProvider';
import { apiFetch, basePath } from '@/lib/api';
import { useStreamingQuery, type Message, type ToolExecution, type PanelUpdate, type StreamStatusEvent } from '@/hooks/useStreamingQuery';
import { CapabilitiesPanel } from '@/components/CapabilitiesPanel';
import { OnboardingTour, type TourStep } from '@/components/OnboardingTour';
import skills from '@/lib/skills/index.json';
import type { CanvasPanelLayout, UIPanel, UIState, PanelGroup, PanelConnection } from '@/lib/storage';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface TableData {
  id: string;
  title: string;
  columns: { key: string; label: string; type: string; linkText?: string }[];
  data: Record<string, unknown>[];
}

interface ChartData {
  id: string;
  title: string;
  type: 'bar' | 'line' | 'pie' | 'area';
  data: Record<string, unknown>[];
  config: {
    xKey?: string;
    yKey?: string;
    labelKey?: string;
    valueKey?: string;
  };
}

interface CardsData {
  id: string;
  title: string;
  items: {
    id?: string;
    title: string;
    subtitle?: string;
    description?: string;
    image?: string;
    badge?: string;
    metadata?: Record<string, string>;
  }[];
}

interface DownloadRequest {
  filename: string;
  data: unknown;
  format: 'csv' | 'json' | 'txt';
}

interface WorkspaceData {
  id: string;
  name: string;
  description: string;
  galleryId?: string;
}

// Default panel sizes in pixels for infinite canvas
const DEFAULT_PANEL_SIZES: Record<string, { width: number; height: number }> = {
  table: { width: 600, height: 400 },
  chart: { width: 500, height: 350 },
  cards: { width: 500, height: 400 },
  markdown: { width: 400, height: 300 },
  preview: { width: 600, height: 500 },
};

// Collision resolution constants
const PANEL_GAP = 20; // Minimum gap between panels in pixels
const AUTO_FOCUS_DELAY = 150;
const AUTO_FOCUS_DURATION = 650;
const AUTO_FOCUS_EASING = 'easeInOutQuint';
const AUTO_FOCUS_PADDING = 40;

// Type for panel layouts
type LayoutMap = Record<string, { x: number; y: number; width: number; height: number }>;

// Check if any panels overlap (quick check for periodic resolution)
function hasOverlappingPanels(layouts: LayoutMap): boolean {
  const panelIds = Object.keys(layouts);
  const gap = PANEL_GAP;
  for (let i = 0; i < panelIds.length; i++) {
    for (let j = i + 1; j < panelIds.length; j++) {
      const a = layouts[panelIds[i]];
      const b = layouts[panelIds[j]];
      const overlaps = !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
                         a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
      if (overlaps) return true;
    }
  }
  return false;
}

// Collision resolution helper - pushes overlapping panels apart
// fixedPanelIds: panels that should not move (the ones being dragged)
// Note: This function mutates the layouts parameter for efficiency
function resolveCollisions(layouts: LayoutMap, fixedPanelIds: Set<string>): LayoutMap {
  const gap = PANEL_GAP;
  const maxIterations = 15;
  const panelIds = Object.keys(layouts);

  // Helper to check if two rectangles overlap (with gap)
  const rectsOverlap = (a: LayoutMap[string], b: LayoutMap[string]) => {
    return !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
             a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
  };

  // Skip collision between panels that are both fixed (e.g., both in dragged group)
  const shouldSkipCollision = (idA: string, idB: string) => {
    return fixedPanelIds.has(idA) && fixedPanelIds.has(idB);
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    let hadCollision = false;

    for (let i = 0; i < panelIds.length; i++) {
      for (let j = i + 1; j < panelIds.length; j++) {
        const idA = panelIds[i];
        const idB = panelIds[j];
        const a = layouts[idA];
        const b = layouts[idB];

        if (!rectsOverlap(a, b)) continue;
        if (shouldSkipCollision(idA, idB)) continue;

        hadCollision = true;

        // Determine which panel moves: fixed panels stay put
        let toMoveId: string;
        let stayId: string;
        if (fixedPanelIds.has(idA)) {
          toMoveId = idB;
          stayId = idA;
        } else if (fixedPanelIds.has(idB)) {
          toMoveId = idA;
          stayId = idB;
        } else {
          // Move the one that's more bottom-right
          if (b.y > a.y || (b.y === a.y && b.x > a.x)) {
            toMoveId = idB;
            stayId = idA;
          } else {
            toMoveId = idA;
            stayId = idB;
          }
        }

        const stay = layouts[stayId];
        const move = layouts[toMoveId];

        // Calculate centers to determine push direction
        const stayCx = stay.x + stay.width / 2;
        const stayCy = stay.y + stay.height / 2;
        const moveCx = move.x + move.width / 2;
        const moveCy = move.y + move.height / 2;

        // Calculate edge-based push amounts
        const pushRight = (stay.x + stay.width + gap) - move.x;
        const pushLeft = (move.x + move.width + gap) - stay.x;
        const pushDown = (stay.y + stay.height + gap) - move.y;
        const pushUp = (move.y + move.height + gap) - stay.y;

        // Choose minimum push in the natural direction (away from stay's center)
        const pushX = moveCx >= stayCx ? pushRight : pushLeft;
        const pushY = moveCy >= stayCy ? pushDown : pushUp;

        // Push in the direction requiring minimum movement
        if (pushX > 0 && pushX <= pushY) {
          const dx = moveCx >= stayCx ? pushRight : -pushLeft;
          layouts[toMoveId] = { ...move, x: move.x + dx };
        } else if (pushY > 0) {
          const dy = moveCy >= stayCy ? pushDown : -pushUp;
          layouts[toMoveId] = { ...move, y: move.y + dy };
        }
      }
    }

    if (!hadCollision) break;
  }

  return layouts;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export default function WorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = params.id as string;
  const { resolvedTheme, setTheme } = useTheme();

  // State
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tables, setTables] = useState<Record<string, TableData>>({});
  const [charts, setCharts] = useState<Record<string, ChartData>>({});
  const [cards, setCards] = useState<Record<string, CardsData>>({});
  const [uiState, setUIState] = useState<UIState>({ panels: [{ id: 'chat', type: 'chat' }], viewport: { x: 0, y: 0, zoom: 1 } });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [tourOpen, setTourOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishTitle, setPublishTitle] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const [tempDescription, setTempDescription] = useState('');
  const originalTitleRef = useRef('');
  const originalDescriptionRef = useRef('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; path: string }[]>([]);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [minimizedPanels, setMinimizedPanels] = useState<Set<string>>(new Set());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);

  // Canvas state
  const [panelLayouts, setPanelLayouts] = useState<Record<string, CanvasPanelLayout>>({});
  const [zoomLevel, setZoomLevel] = useState(1);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);

  // Contextual chat state - supports both panels and groups
  const [contextualChatPanelId, setContextualChatPanelId] = useState<string | null>(null);
  const [contextualChatGroupId, setContextualChatGroupId] = useState<string | null>(null);
  const [contextualChatMessages, setContextualChatMessages] = useState<Record<string, Array<{ id: string; role: 'user' | 'assistant'; content: string }>>>({});
  const [contextualChatLoading, setContextualChatLoading] = useState<Record<string, boolean>>({});
  const [contextualChatStatus, setContextualChatStatus] = useState<Record<string, string | null>>({});

  // Connection lines state
  const [connections, setConnections] = useState<PanelConnection[]>([]);
  const [animatingConnectionIds, setAnimatingConnectionIds] = useState<Set<string>>(new Set());

  // Panel animation state
  const [animatingPanelIds, setAnimatingPanelIds] = useState<Set<string>>(new Set());

  // Selection and grouping state
  const [selectedPanelIds, setSelectedPanelIds] = useState<Set<string>>(new Set());
  const [hoveredPanelId, setHoveredPanelId] = useState<string | null>(null);
  const [hoveredToolbarPanelId, setHoveredToolbarPanelId] = useState<string | null>(null);
  const hoverClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredPanelIdRef = useRef<string | null>(null);
  const hoveredToolbarPanelIdRef = useRef<string | null>(null);
  const [groups, setGroups] = useState<PanelGroup[]>([]);
  const latestGroupsRef = useRef<PanelGroup[]>([]);
  const latestConnectionsRef = useRef<PanelConnection[]>([]);

  useEffect(() => {
    latestGroupsRef.current = groups;
    latestConnectionsRef.current = connections;
  }, [groups, connections]);
  // Selected group when all selected panels belong to the same group
  const selectedPanelsGroup = useMemo(() => {
    if (selectedPanelIds.size < 2) return null;
    const selectedArray = Array.from(selectedPanelIds);
    for (const group of groups) {
      if (selectedArray.every(id => group.panelIds.includes(id))) return group;
    }
    return null;
  }, [selectedPanelIds, groups]);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [isSelectingBox, setIsSelectingBox] = useState(false);
  const [selectionBoxStart, setSelectionBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionBoxEnd, setSelectionBoxEnd] = useState<{ x: number; y: number } | null>(null);

  // UX state
  const [showCanvasHint, setShowCanvasHint] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameInput, setGroupNameInput] = useState('');

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const viewportSaveTimeout = useRef<NodeJS.Timeout | null>(null);
  // Initial viewport: looking at canvas area around (4000, 4000) at 75% zoom
  const currentViewport = useRef<{ x: number; y: number; scale: number }>({ x: -2500, y: -2000, scale: 0.75 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<{ setTransform: (x: number, y: number, scale: number, duration?: number, animationType?: "linear" | "easeInOutQuint" | "easeOut" | "easeInQuad" | "easeOutQuad" | "easeInOutQuad" | "easeInCubic" | "easeOutCubic" | "easeInOutCubic" | "easeInQuart" | "easeOutQuart" | "easeInOutQuart" | "easeInQuint" | "easeOutQuint") => void } | null>(null);
  const groupsSaveTimeout = useRef<NodeJS.Timeout | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoFocusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingQueryProcessed = useRef(false);
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastLayoutInteractionRef = useRef(0);
  const messageIdRef = useRef(0);
  const selectionPendingRef = useRef<{ x: number; y: number } | null>(null);
  const selectionSuppressClickRef = useRef(false);
  const selectionPointerIdRef = useRef<number | null>(null);

  // Load workspace callback (forward declared for hook)
  const loadWorkspaceRef = useRef<((options?: { skipMessages?: boolean }) => Promise<void>) | undefined>(undefined);

  // Track panels that need auto-focus after layout is computed
  const pendingAutoFocusRef = useRef<Set<string>>(new Set());
  // Track which source panel a new panel should be positioned near
  const panelSourceRef = useRef<Record<string, string>>({});

  const tourSteps = useMemo<TourStep[]>(() => [
    {
      id: 'chat',
      title: 'Ask the agent',
      description: 'Type your request here. The agent will create tables, charts, and tools on the canvas.',
      selector: '[data-tour="chat-input"]',
    },
    {
      id: 'upload',
      title: 'Add files',
      description: 'Upload PDFs, CSVs, or images and reference them in your prompt.',
      selector: '[data-tour="upload-button"]',
    },
    {
      id: 'canvas',
      title: 'Your workspace canvas',
      description: 'Results appear here as draggable panels you can move and resize.',
      selector: '[data-tour="canvas"]',
    },
    {
      id: 'zoom',
      title: 'Navigate the space',
      description: 'Scroll to zoom, Space + drag (or middle-click) to pan.',
      selector: '[data-tour="zoom-controls"]',
    },
  ], []);

  const makeMessageId = useCallback(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    messageIdRef.current += 1;
    return `msg-${Date.now()}-${messageIdRef.current}`;
  }, []);

  // Handle panel updates from streaming
  const handlePanelUpdates = useCallback((updates: PanelUpdate[], context?: { sourcePanelId?: string | null; sourceGroupId?: string | null }) => {
    const syncPanelLayout = (panel: UIPanel) => {
      const layout = panel.layout;
      if (!layout) return;
      const hasAnyLayoutValue = layout.x !== undefined || layout.y !== undefined || layout.width !== undefined || layout.height !== undefined;
      if (!hasAnyLayoutValue) return;

      setPanelLayouts(prev => {
        const prevLayout = prev[panel.id];
        const hasFullLayout = layout.x !== undefined && layout.y !== undefined && layout.width !== undefined && layout.height !== undefined;
        if (!prevLayout && !hasFullLayout) return prev;

        const nextLayout: CanvasPanelLayout = {
          x: layout.x ?? prevLayout?.x ?? 0,
          y: layout.y ?? prevLayout?.y ?? 0,
          width: layout.width ?? prevLayout?.width ?? (DEFAULT_PANEL_SIZES[panel.type]?.width ?? 500),
          height: layout.height ?? prevLayout?.height ?? (DEFAULT_PANEL_SIZES[panel.type]?.height ?? 400),
        };

        if (prevLayout &&
          prevLayout.x === nextLayout.x &&
          prevLayout.y === nextLayout.y &&
          prevLayout.width === nextLayout.width &&
          prevLayout.height === nextLayout.height) {
          return prev;
        }

        return { ...prev, [panel.id]: nextLayout };
      });
    };

    for (const update of updates) {
      const { action, panel, data } = update;
      // Cast panel to UIPanel since we know server sends valid types
      const typedPanel = panel as unknown as UIPanel;

      if (action === 'add') {
        const sourceId = typedPanel.sourcePanel || context?.sourcePanelId || null;

        // Add new panel to UI state
        setUIState(prev => {
          // Check if panel already exists
          const exists = prev.panels.some(p => p.id === typedPanel.id);
          if (exists) {
            // Update existing panel
            return {
              ...prev,
              panels: prev.panels.map(p => p.id === typedPanel.id ? { ...p, ...typedPanel } : p)
            };
          }
          return {
            ...prev,
            panels: [...prev.panels, typedPanel]
          };
        });

        // Add associated data
        if (data?.table && typedPanel.tableId) {
          setTables(prev => ({ ...prev, [typedPanel.tableId!]: data.table as TableData }));
        }
        if (data?.chart && typedPanel.chartId) {
          setCharts(prev => ({ ...prev, [typedPanel.chartId!]: data.chart as ChartData }));
        }
        if (data?.cards && typedPanel.cardsId) {
          setCards(prev => ({ ...prev, [typedPanel.cardsId!]: data.cards as CardsData }));
        }

        // Create connection if panel has a source or was created during contextual chat
        if (sourceId && sourceId !== typedPanel.id) {
          const connectionId = `conn-${sourceId}-${typedPanel.id}`;
          setConnections(prev => {
            // Don't add duplicate connections
            if (prev.some(c => c.id === connectionId)) return prev;
            return [...prev, {
              id: connectionId,
              sourceId: sourceId,
              targetId: typedPanel.id,
            }];
          });
          // Animate the new connection
          setAnimatingConnectionIds(prev => new Set(prev).add(connectionId));
          // Remove animation class after animation completes
          setTimeout(() => {
            setAnimatingConnectionIds(prev => {
              const next = new Set(prev);
              next.delete(connectionId);
              return next;
            });
          }, 600);
        }

        // Animate new panel with pop-in effect
        setAnimatingPanelIds(prev => new Set(prev).add(typedPanel.id));
        setTimeout(() => {
          setAnimatingPanelIds(prev => {
            const next = new Set(prev);
            next.delete(typedPanel.id);
            return next;
          });
        }, 400);

        // Mark panel for auto-focus (will be handled by useEffect after layout is computed)
        pendingAutoFocusRef.current.add(typedPanel.id);
        // Track source panel for positioning near it
        if (sourceId) {
          panelSourceRef.current[typedPanel.id] = sourceId;
        }

        // If created from a group contextual chat, add to that group
        if (context?.sourceGroupId) {
          setGroups(prev => prev.map(g =>
            g.id === context.sourceGroupId && !g.panelIds.includes(typedPanel.id)
              ? { ...g, panelIds: [...g.panelIds, typedPanel.id] }
              : g
          ));
        }
        syncPanelLayout(typedPanel);
      } else if (action === 'update') {
        // Update existing panel
        setUIState(prev => ({
          ...prev,
          panels: prev.panels.map(p => p.id === typedPanel.id ? { ...p, ...typedPanel } : p)
        }));

        // Update associated data
        if (data?.table && typedPanel.tableId) {
          setTables(prev => ({ ...prev, [typedPanel.tableId!]: data.table as TableData }));
        }
        if (data?.chart && typedPanel.chartId) {
          setCharts(prev => ({ ...prev, [typedPanel.chartId!]: data.chart as ChartData }));
        }
        if (data?.cards && typedPanel.cardsId) {
          setCards(prev => ({ ...prev, [typedPanel.cardsId!]: data.cards as CardsData }));
        }
        syncPanelLayout(typedPanel);
      } else if (action === 'remove') {
        // Remove panel from UI state
        setUIState(prev => ({
          ...prev,
          panels: prev.panels.filter(p => p.id !== typedPanel.id)
        }));

        // Clean up connections involving this panel
        setConnections(prev => prev.filter(c =>
          c.sourceId !== typedPanel.id && c.targetId !== typedPanel.id
        ));

        // Clean up groups containing this panel
        setGroups(prev => prev.map(g => ({
          ...g,
          panelIds: g.panelIds.filter(pid => pid !== typedPanel.id)
        })).filter(g => g.panelIds.length >= 2)); // Remove groups with less than 2 panels

        setMinimizedPanels(prev => {
          if (!prev.has(typedPanel.id)) return prev;
          const next = new Set(prev);
          next.delete(typedPanel.id);
          return next;
        });

        // Clean up panel ref to avoid memory leak
        delete panelRefs.current[typedPanel.id];

        // Clean up contextual chat messages
        setContextualChatMessages(prev => {
          const rest = { ...prev } as Record<string, Array<{ id: string; role: 'user' | 'assistant'; content: string }>>;
          delete rest[typedPanel.id];
          return rest;
        });
        setContextualChatLoading(prev => {
          if (!(typedPanel.id in prev)) return prev;
          const rest = { ...prev };
          delete rest[typedPanel.id];
          return rest;
        });
        setContextualChatStatus(prev => {
          if (!(typedPanel.id in prev)) return prev;
          const rest = { ...prev };
          delete rest[typedPanel.id];
          return rest;
        });

        // Close panel chat if it was for this panel
        setContextualChatPanelId(prev => prev === typedPanel.id ? null : prev);
      }
    }
  }, []);

  const getStatusLabel = useCallback((event: StreamStatusEvent): string | null => {
    if (event.status === 'complete') return null;
    if (event.label) return event.label;
    if (event.status === 'tool_running') return 'Running tools...';
    if (event.status === 'responding') return 'Responding...';
    return 'Thinking...';
  }, []);

  // Streaming query hook
  const { executeQuery, stopQuery } = useStreamingQuery({
    workspaceId,
    onMessagesUpdate: setMessages,
    onComplete: async () => {
      if (loadWorkspaceRef.current) {
        await loadWorkspaceRef.current({ skipMessages: true });
      }
    },
    onPanelUpdate: handlePanelUpdates,
    onStatusUpdate: (event) => {
      setStreamStatus(getStatusLabel(event));
    },
  });

  useEffect(() => {
    const seen = localStorage.getItem('agent-studio-tour-seen');
    if (seen !== 'true') {
      setTourOpen(true);
    }
  }, []);

  useEffect(() => {
    if (tourOpen) {
      setChatOpen(true);
    }
  }, [tourOpen]);

  const handleTourClose = useCallback((markSeen: boolean) => {
    setTourOpen(false);
    if (markSeen) {
      localStorage.setItem('agent-studio-tour-seen', 'true');
    }
  }, []);

  // Load canvas hint dismissal from localStorage
  useEffect(() => {
    const dismissed = localStorage.getItem('canvas-hint-dismissed');
    if (dismissed === 'true') {
      setShowCanvasHint(false);
    }
  }, []);

  // Close menu on click outside
  useEffect(() => {
    if (!openMenuId) return;
    const handleClick = () => setOpenMenuId(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openMenuId]);

  // Close maximized panel on Escape
  useEffect(() => {
    if (!maximizedPanelId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximizedPanelId(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [maximizedPanelId]);

  // Save groups and connections when they change (debounced)
  const isInitialGroupsLoad = useRef(true);
  useEffect(() => {
    // Don't save on initial mount
    if (isInitialGroupsLoad.current) {
      isInitialGroupsLoad.current = false;
      return;
    }
    if (!workspaceLoaded) return;

    if (groupsSaveTimeout.current) clearTimeout(groupsSaveTimeout.current);
    groupsSaveTimeout.current = setTimeout(() => {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ groups, connections }),
      }).catch(console.error);
    }, 500);
  }, [groups, connections, workspaceId, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded) return;
    const flushGroups = () => {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: latestGroupsRef.current,
          connections: latestConnectionsRef.current,
        }),
        keepalive: true,
      }).catch(() => {});
    };

    const handlePageHide = () => flushGroups();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushGroups();
    };

    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [workspaceId, workspaceLoaded]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      if (groupsSaveTimeout.current) clearTimeout(groupsSaveTimeout.current);
      if (viewportSaveTimeout.current) clearTimeout(viewportSaveTimeout.current);
      // Clear drag state on unmount to prevent stuck state
      setDraggingGroupId(null);
    };
  }, []);

  // Close publish modal on Escape
  useEffect(() => {
    if (!publishModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPublishModalOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [publishModalOpen]);

  // (moved) Global Escape & keyboard shortcuts effect is defined later after handler functions

  // Get artifact panels (everything except chat)
  const artifactPanels = useMemo(() =>
    uiState.panels.filter(p => p.type !== 'chat'),
    [uiState.panels]
  );

  // Source of truth for which panels actually exist (used for group cleanup)
  const existingPanelIds = useMemo(() => new Set(artifactPanels.map(p => p.id)), [artifactPanels]);

  const visiblePanels = useMemo(
    () => artifactPanels.filter(p => !minimizedPanels.has(p.id)),
    [artifactPanels, minimizedPanels]
  );

  const visiblePanelIds = useMemo(() => new Set(visiblePanels.map(p => p.id)), [visiblePanels]);

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

  useEffect(() => {
    return () => {
      if (hoverClearTimeoutRef.current) {
        clearTimeout(hoverClearTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autoFocusTimeoutRef.current) {
        clearTimeout(autoFocusTimeoutRef.current);
      }
    };
  }, []);

  const visibleConnections = useMemo(
    () => connections.filter(c => visiblePanelIds.has(c.sourceId) && visiblePanelIds.has(c.targetId)),
    [connections, visiblePanelIds]
  );

  useEffect(() => {
    setMinimizedPanels(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(Array.from(prev).filter(id => existingPanelIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [existingPanelIds]);

  useEffect(() => {
    setSelectedPanelIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(Array.from(prev).filter(id => visiblePanelIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visiblePanelIds]);

  useEffect(() => {
    if (focusedPanelId && minimizedPanels.has(focusedPanelId)) {
      setFocusedPanelId(null);
    }
  }, [focusedPanelId, minimizedPanels]);

  useEffect(() => {
    if (contextualChatPanelId && minimizedPanels.has(contextualChatPanelId)) {
      setContextualChatPanelId(null);
    }
  }, [contextualChatPanelId, minimizedPanels]);

  useEffect(() => {
    if (!contextualChatGroupId) return;
    const group = groups.find(g => g.id === contextualChatGroupId);
    if (!group) return;
    const hasVisiblePanels = group.panelIds.some(id => visiblePanelIds.has(id));
    if (!hasVisiblePanels) {
      setContextualChatGroupId(null);
    }
  }, [contextualChatGroupId, groups, visiblePanelIds]);

  // Auto-pan when opening group contextual chat
  useEffect(() => {
    if (!contextualChatGroupId) return;
    const group = groups.find(g => g.id === contextualChatGroupId);
    if (!group || !transformRef.current || !canvasContainerRef.current) return;
    const groupLayouts = group.panelIds
      .filter(id => visiblePanelIds.has(id))
      .map(id => panelLayouts[id])
      .filter(Boolean);
    if (groupLayouts.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of groupLayouts) {
      minX = Math.min(minX, l.x);
      minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + l.width);
      maxY = Math.max(maxY, l.y + l.height);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const container = canvasContainerRef.current;
    const viewportWidth = container.clientWidth;
    const viewportHeight = container.clientHeight;
    const currentScale = currentViewport.current.scale;
    const targetX = viewportWidth / 2 - centerX * currentScale;
    const targetY = viewportHeight / 2 - centerY * currentScale;
    transformRef.current.setTransform(targetX, targetY, currentScale, 400);
  }, [contextualChatGroupId, groups, panelLayouts, visiblePanelIds]);

  // Clean up stale panel IDs and invalid groups
  useEffect(() => {
    if (!workspaceLoaded) return;
    let needsUpdate = false;
    const groupsToRemove: string[] = [];

    // Check for stale panel IDs or groups that became invalid
    for (const g of groups) {
      const validPanels = g.panelIds.filter(id => existingPanelIds.has(id));
      if (validPanels.length !== g.panelIds.length) {
        needsUpdate = true;
      }
      if (validPanels.length < 2) {
        needsUpdate = true;
        groupsToRemove.push(g.id);
      }
    }

    if (needsUpdate) {
      setGroups(prev => prev
        .map(g => ({
          ...g,
          panelIds: g.panelIds.filter(id => existingPanelIds.has(id)) // Remove stale IDs
        }))
        .filter(g => g.panelIds.length >= 2) // Remove invalid groups
      );

      // Clean up contextual chat messages for removed groups
      if (groupsToRemove.length > 0) {
        setContextualChatMessages(prev => {
          const updated = { ...prev };
          for (const groupId of groupsToRemove) {
            delete updated[groupId];
          }
          return updated;
        });
        setContextualChatLoading(prev => {
          const updated = { ...prev };
          for (const groupId of groupsToRemove) {
            delete updated[groupId];
          }
          return updated;
        });
        setContextualChatStatus(prev => {
          const updated = { ...prev };
          for (const groupId of groupsToRemove) {
            delete updated[groupId];
          }
          return updated;
        });
        // Close group chat if it was for a removed group
        if (contextualChatGroupId && groupsToRemove.includes(contextualChatGroupId)) {
          setContextualChatGroupId(null);
        }
      }
    }
  }, [groups, existingPanelIds, contextualChatGroupId, workspaceLoaded]);

  // Initialize panel layouts when panels change
  // New panels appear in the center of the current viewport
  useEffect(() => {
    const gap = PANEL_GAP;

    // Calculate viewport center in canvas coordinates
    const vp = currentViewport.current;
    const container = canvasContainerRef.current;
    const viewportWidth = container?.clientWidth || 1200;
    const viewportHeight = container?.clientHeight || 700;
    // Place new panels near the center of the current viewport
    const startX = Math.round((-vp.x + viewportWidth / 2) / vp.scale - 250);
    const startY = Math.round((-vp.y + viewportHeight / 2) / vp.scale - 200);

    const added: Record<string, { x: number; y: number; width: number; height: number }> = {};
    setPanelLayouts(prev => {
      const newLayouts = { ...prev };
      const occupiedRects: { x: number; y: number; width: number; height: number }[] = [];

      // Collect existing layouts (ignore minimized panels)
      Object.entries(newLayouts).forEach(([id, layout]) => {
        if (visiblePanelIds.has(id)) {
          occupiedRects.push(layout);
        }
      });

      // Check if a rectangle overlaps
      const overlaps = (x: number, y: number, w: number, h: number): boolean => {
        for (const rect of occupiedRects) {
          if (!(x >= rect.x + rect.width + gap || x + w + gap <= rect.x ||
                y >= rect.y + rect.height + gap || y + h + gap <= rect.y)) {
            return true;
          }
        }
        return false;
      };

      // Find non-overlapping position
      const findPosition = (width: number, height: number): { x: number; y: number } => {
        if (occupiedRects.length === 0) return { x: startX, y: startY };

        // Try right of rightmost in top row
        const topRow = occupiedRects.filter(r => r.y < startY + 200);
        if (topRow.length > 0) {
          const rightmost = topRow.reduce((max, r) => (r.x + r.width) > (max.x + max.width) ? r : max);
          const x = rightmost.x + rightmost.width + gap;
          if (!overlaps(x, startY, width, height)) return { x, y: startY };
        }

        // Grid search
        for (let row = 0; row < 20; row++) {
          for (let col = 0; col < 10; col++) {
            const x = startX + col * (500 + gap);
            const y = startY + row * (400 + gap);
            if (!overlaps(x, y, width, height)) return { x, y };
          }
        }

        return { x: startX, y: Math.max(...occupiedRects.map(r => r.y + r.height), 0) + gap };
      };

      // Add layouts for new panels
      for (const panel of visiblePanels) {
        if (!newLayouts[panel.id]) {
          const defaultSize = DEFAULT_PANEL_SIZES[panel.type] || { width: 500, height: 400 };
          const width = panel.layout?.width ?? defaultSize.width;
          const height = panel.layout?.height ?? defaultSize.height;

          let x: number, y: number;
          if (panel.layout?.x !== undefined && panel.layout?.y !== undefined) {
            x = panel.layout.x;
            y = panel.layout.y;
          } else {
            // Check if this panel has a source panel to position near
            const sourceId = panelSourceRef.current[panel.id];
            const sourceLayout = sourceId ? newLayouts[sourceId] : null;

            if (sourceLayout) {
              // Position to the right of source panel
              x = sourceLayout.x + sourceLayout.width + gap;
              y = sourceLayout.y;
              // Check for collisions and adjust if needed
              if (overlaps(x, y, width, height)) {
                // Try below source
                x = sourceLayout.x;
                y = sourceLayout.y + sourceLayout.height + gap;
                if (overlaps(x, y, width, height)) {
                  // Fall back to find position
                  const pos = findPosition(width, height);
                  x = pos.x;
                  y = pos.y;
                }
              }
              // Clean up the source reference
              delete panelSourceRef.current[panel.id];
            } else {
              const pos = findPosition(width, height);
              x = pos.x;
              y = pos.y;
            }
          }

          const layout = { x, y, width, height };
          newLayouts[panel.id] = layout;
          occupiedRects.push(layout);
          added[panel.id] = layout;
        }
      }

      // Remove layouts for deleted panels
      const panelIds = new Set(artifactPanels.map(p => p.id));
      Object.keys(newLayouts).forEach(id => {
        if (!panelIds.has(id)) delete newLayouts[id];
      });

      return newLayouts;
    });
    if (Object.keys(added).length > 0) {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: added }),
      }).catch(console.error);
    }
  }, [artifactPanels, workspaceId, visiblePanelIds, visiblePanels]);

  // Auto-focus viewport on new panels after layout is computed
  useEffect(() => {
    if (pendingAutoFocusRef.current.size === 0) return;
    if (!transformRef.current) return;
    if (!canvasContainerRef.current) return;

    if (autoFocusTimeoutRef.current) {
      clearTimeout(autoFocusTimeoutRef.current);
    }

    autoFocusTimeoutRef.current = setTimeout(() => {
      autoFocusTimeoutRef.current = null;

      const pendingIds = Array.from(pendingAutoFocusRef.current);
      if (pendingIds.length === 0) return;

      const readyLayouts: Array<{ id: string; layout: CanvasPanelLayout }> = [];
      const missingIds: string[] = [];
      for (const panelId of pendingIds) {
        const layout = panelLayouts[panelId];
        if (layout) {
          readyLayouts.push({ id: panelId, layout });
        } else {
          missingIds.push(panelId);
        }
      }
      pendingAutoFocusRef.current = new Set(missingIds);
      if (readyLayouts.length === 0) return;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const { layout } of readyLayouts) {
        minX = Math.min(minX, layout.x);
        minY = Math.min(minY, layout.y);
        maxX = Math.max(maxX, layout.x + layout.width);
        maxY = Math.max(maxY, layout.y + layout.height);
      }

      minX -= AUTO_FOCUS_PADDING;
      minY -= AUTO_FOCUS_PADDING;
      maxX += AUTO_FOCUS_PADDING;
      maxY += AUTO_FOCUS_PADDING;

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      const container = canvasContainerRef.current;
      if (!container) return;
      const viewportWidth = container.clientWidth;
      const viewportHeight = container.clientHeight;
      const currentScale = currentViewport.current.scale;

      const targetX = viewportWidth / 2 - centerX * currentScale;
      const targetY = viewportHeight / 2 - centerY * currentScale;

      transformRef.current?.setTransform(targetX, targetY, currentScale, AUTO_FOCUS_DURATION, AUTO_FOCUS_EASING);

      const focusId = readyLayouts[readyLayouts.length - 1]?.id;
      if (focusId && selectedPanelIds.size === 0 && !focusedPanelId) {
        setFocusedPanelId(focusId);
      }
    }, AUTO_FOCUS_DELAY);
  }, [focusedPanelId, panelLayouts, selectedPanelIds]);

  // Handle panel drag start - individual panels can now move independently
  // (draggingGroupId is only set when dragging the group boundary)
  const handlePanelDragStart = useCallback((id: string) => {
    void id; // mark used
    // No longer set draggingGroupId here - panels move independently
    // Group boundary drag handles moving all panels together via handleGroupDrag
  }, []);

  // Handle panel layout change (during drag/resize)
  // Individual panels move independently - use group boundary drag to move the whole group
  const handleLayoutChange = useCallback((id: string, layout: Partial<{ x: number; y: number; width: number; height: number }>) => {
    lastLayoutInteractionRef.current = Date.now();
    setPanelLayouts(prev => {
      const prevLayout = prev[id];
      if (!prevLayout) return prev;

      return {
        ...prev,
        [id]: { ...prevLayout, ...layout },
      };
    });
  }, []);

  // Handle group drag (dragging the group boundary moves all panels)
  const handleGroupDrag = useCallback((groupId: string, dx: number, dy: number) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    // Set dragging state for CSS (disable transitions)
    setDraggingGroupId(groupId);
    lastLayoutInteractionRef.current = Date.now();

    setPanelLayouts(prev => {
      const newLayouts = { ...prev };
      for (const panelId of group.panelIds) {
        if (newLayouts[panelId]) {
          newLayouts[panelId] = {
            ...newLayouts[panelId],
            x: newLayouts[panelId].x + dx,
            y: newLayouts[panelId].y + dy,
          };
        }
      }
      return newLayouts;
    });
  }, [groups]);

  // Handle group drag end - resolve collisions with panels outside the group
  const handleGroupDragEnd = useCallback((groupId: string) => {
    setDraggingGroupId(null);

    // Find group to get its panel IDs (they're the "fixed" panels)
    const group = groups.find(g => g.id === groupId);
    const visibleFixedPanelIds = new Set((group?.panelIds || []).filter(id => visiblePanelIds.has(id)));

    let savedPayload: LayoutMap | null = null;
    setPanelLayouts(prev => {
      const visibleLayouts: LayoutMap = {};
      const merged: LayoutMap = { ...prev };
      for (const id of visiblePanelIds) {
        const layout = prev[id];
        if (layout) {
          visibleLayouts[id] = { ...layout };
        }
      }

      // Resolve collisions - group panels stay fixed, others move
      const resolved = resolveCollisions(visibleLayouts, visibleFixedPanelIds);
      for (const [id, layout] of Object.entries(resolved)) {
        merged[id] = layout;
      }
      savedPayload = merged;
      return merged;
    });

    if (savedPayload) {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: savedPayload }),
      }).catch(console.error);
    }
  }, [workspaceId, groups, visiblePanelIds]);

  // Resolve collisions and save layout after drag ends (single panel drag)
  const handleDragEnd = useCallback((movedPanelId: string) => {
    // Clear any group dragging state (shouldn't be set for individual drags, but just in case)
    setDraggingGroupId(null);

    // Only the moved panel is fixed - individual panels move independently now
    const visibleFixedPanelIds = new Set([movedPanelId].filter(id => visiblePanelIds.has(id)));

    let savedPayload: LayoutMap | null = null;
    setPanelLayouts(prev => {
      const visibleLayouts: LayoutMap = {};
      const merged: LayoutMap = { ...prev };
      for (const id of visiblePanelIds) {
        const layout = prev[id];
        if (layout) {
          visibleLayouts[id] = { ...layout };
        }
      }

      // Resolve collisions - moved panel stays fixed, others move
      const resolved = resolveCollisions(visibleLayouts, visibleFixedPanelIds);
      for (const [id, layout] of Object.entries(resolved)) {
        merged[id] = layout;
      }
      savedPayload = merged;

      // Check if moved panel should join or leave a group
      // Use generous padding to make groups "sticky" - panels don't accidentally leave
      const movedLayout = resolved[movedPanelId];
      if (movedLayout) {
        // Helper to calculate group bounds (excluding the moved panel)
        // Use different padding for leave vs join checks
        const getGroupBounds = (group: typeof groups[0], padding: number) => {
          const groupLayouts = group.panelIds
            .filter(id => id !== movedPanelId) // Exclude moved panel for bounds calculation
            .map(id => resolved[id])
            .filter(Boolean);

          if (groupLayouts.length === 0) return null;

          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const gl of groupLayouts) {
            minX = Math.min(minX, gl.x);
            minY = Math.min(minY, gl.y);
            maxX = Math.max(maxX, gl.x + gl.width);
            maxY = Math.max(maxY, gl.y + gl.height);
          }

          return {
            x: minX - padding,
            y: minY - padding,
            width: maxX - minX + padding * 2,
            height: maxY - minY + padding * 2,
          };
        };

        // Check if panel overlaps with bounds
        const panelOverlaps = (bounds: { x: number; y: number; width: number; height: number }) => {
          return !(
            movedLayout.x + movedLayout.width < bounds.x ||
            movedLayout.x > bounds.x + bounds.width ||
            movedLayout.y + movedLayout.height < bounds.y ||
            movedLayout.y > bounds.y + bounds.height
          );
        };

        // Find current group (if any) and check group membership changes
        const currentGroup = groups.find(g => g.panelIds.includes(movedPanelId));
        let leaveGroupId: string | null = null;
        let joinGroupId: string | null = null;

        if (currentGroup) {
          // Check if panel moved outside its current group
          // Use LARGE padding (100px) - panels need to be dragged far to leave a group
          const bounds = getGroupBounds(currentGroup, 100);
          if (bounds && !panelOverlaps(bounds)) {
            leaveGroupId = currentGroup.id;
          }
        }

        // Check if panel moved into a different group (only if left current or wasn't in one)
        if (leaveGroupId || !currentGroup) {
          for (const group of groups) {
            if (group.id === currentGroup?.id) continue; // Skip current group
            // Use smaller padding (16px) for joining - need to be close to join
            const bounds = getGroupBounds(group, 16);
            if (bounds && panelOverlaps(bounds)) {
              joinGroupId = group.id;
              break;
            }
          }
        }

        // Apply group changes outside the state updater to avoid side effects
        if (leaveGroupId || joinGroupId) {
          setTimeout(() => {
            setGroups(prev => {
              let updated = prev;

              // Leave old group
              if (leaveGroupId) {
                updated = updated.map(g =>
                  g.id === leaveGroupId
                    ? { ...g, panelIds: g.panelIds.filter(id => id !== movedPanelId) }
                    : g
                ).filter(g => g.panelIds.length >= 2); // Remove groups with <2 panels
              }

              // Join new group (avoid duplicates)
              if (joinGroupId) {
                updated = updated.map(g =>
                  g.id === joinGroupId && !g.panelIds.includes(movedPanelId)
                    ? { ...g, panelIds: [...g.panelIds, movedPanelId] }
                    : g
                );
              }

              return updated;
            });
          }, 0);
        }
      }

      return merged;
    });
    if (savedPayload) {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: savedPayload }),
      }).catch(console.error);
    }
  }, [workspaceId, groups, visiblePanelIds]);

  // Periodic collision check - catches edge cases where panels end up overlapping
  // Runs every 3 seconds but only resolves if overlaps are detected and not dragging
  useEffect(() => {
    const checkAndResolveCollisions = () => {
      // Skip if user is actively dragging
      if (draggingGroupId) return;
      if (Date.now() - lastLayoutInteractionRef.current < 1500) return;

      setPanelLayouts(prev => {
        if (visiblePanelIds.size < 2) return prev; // Nothing visible to check

        const visibleLayouts: LayoutMap = {};
        for (const id of visiblePanelIds) {
          const layout = prev[id];
          if (layout) {
            visibleLayouts[id] = { ...layout };
          }
        }
        if (Object.keys(visibleLayouts).length < 2) return prev;
        if (!hasOverlappingPanels(visibleLayouts)) return prev; // No overlaps

        // No fixed panels - everything can move to find best arrangement
        const resolved = resolveCollisions(visibleLayouts, new Set());
        const merged = { ...prev, ...resolved };

        // Check if anything actually changed before saving
        const changed = Object.keys(resolved).some(id => {
          const r = resolved[id];
          const p = prev[id];
          return r.x !== p.x || r.y !== p.y;
        });

        if (changed) {
          apiFetch(`/api/workspaces/${workspaceId}/layout`, {
            method: 'PATCH',
            body: JSON.stringify({ panels: merged }),
          }).catch(console.error);
          return merged;
        }

        return prev; // No change needed
      });
    };

    const intervalId = setInterval(checkAndResolveCollisions, 3000);
    return () => clearInterval(intervalId);
  }, [workspaceId, draggingGroupId, visiblePanelIds]);


  // Load workspace data
  const loadWorkspace = useCallback(async (options?: { skipMessages?: boolean }) => {
    const res = await apiFetch(`/api/workspaces/${workspaceId}`);
    const data = await res.json();

    if (data.workspace) setWorkspace(data.workspace);
    if (data.tables) {
      const tableMap: Record<string, TableData> = {};
      data.tables.forEach((t: TableData) => { tableMap[t.id] = t; });
      setTables(tableMap);
    }
    if (data.charts) setCharts(data.charts);
    if (data.cards) setCards(data.cards);
    if (data.downloads && data.downloads.length > 0) {
      data.downloads.forEach((dl: DownloadRequest) => {
        triggerDownload(dl.filename, dl.data, dl.format);
      });
      apiFetch(`/api/workspaces/${workspaceId}/downloads`, { method: 'DELETE' });
    }
    if (!options?.skipMessages && data.messages) {
      setMessages(data.messages.map((msg: Message) => (
        msg.id ? msg : { ...msg, id: makeMessageId() }
      )));
    }
    if (data.uiState) {
      setUIState(data.uiState);
      // Sync currentViewport ref with loaded viewport so new panels appear in view
      if (data.uiState.viewport) {
        currentViewport.current = {
          x: data.uiState.viewport.x ?? -3100,
          y: data.uiState.viewport.y ?? -3400,
          scale: data.uiState.viewport.zoom ?? 1,
        };
      }
      // Load groups and connections from UIState
      // Reset initial flag to prevent immediate re-save of loaded data
      if (data.uiState.groups) {
        isInitialGroupsLoad.current = true;
        setGroups(data.uiState.groups);
      }
      if (data.uiState.connections) {
        setConnections(data.uiState.connections);
      }
    }
    setWorkspaceLoaded(true);
  }, [workspaceId, makeMessageId]);

  // Set the ref so hook can access loadWorkspace
  loadWorkspaceRef.current = loadWorkspace;

  // Trigger browser download
  const triggerDownload = (filename: string, data: unknown, format: 'csv' | 'json' | 'txt') => {
    let content: string;
    let mimeType: string;

    if (format === 'json') {
      content = JSON.stringify(data, null, 2);
      mimeType = 'application/json';
    } else if (format === 'csv') {
      if (Array.isArray(data) && data.length > 0) {
        const headers = Object.keys(data[0] as Record<string, unknown>);
        const rows = data.map(row =>
          headers.map(h => JSON.stringify((row as Record<string, unknown>)[h] ?? '')).join(',')
        );
        content = [headers.join(','), ...rows].join('\n');
      } else {
        content = '';
      }
      mimeType = 'text/csv';
    } else {
      content = typeof data === 'string' ? data : JSON.stringify(data);
      mimeType = 'text/plain';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Auto-process pending user message (from initial prompt)
  const processPendingMessage = useCallback(async (userMessage: string) => {
    if (isLoading) return;
    setStreamStatus('Thinking...');
    setIsLoading(true);
    try {
      await executeQuery(userMessage);
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
    }
  }, [isLoading, executeQuery]);

  // Check for pending message on initial load
  useEffect(() => {
    if (pendingQueryProcessed.current) return;
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    // If last message is from user and there's no assistant response, process it
    if (lastMessage.role === 'user') {
      pendingQueryProcessed.current = true;
      processPendingMessage(lastMessage.content);
    } else {
      // No pending message to process
      pendingQueryProcessed.current = true;
    }
  }, [messages, processPendingMessage]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const behavior = isLoading ? 'auto' : 'smooth';
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  // Submit message
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    let userMessage = input.trim();

    // If there are uploaded files, append them to the message for agent awareness
    if (uploadedFiles.length > 0) {
      const fileList = uploadedFiles.map(f => `- ${f.path} (${f.name})`).join('\n');
      userMessage += `\n\n[Attached files]\n${fileList}`;
      setUploadedFiles([]); // Clear after including in message
    }

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setMessages((prev) => [...prev, { id: makeMessageId(), role: 'user', content: userMessage }]);
    setStreamStatus('Thinking...');
    setIsLoading(true);

    try {
      await executeQuery(userMessage);
    } finally {
      setIsLoading(false);
      setStreamStatus(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Handle single click on panel - for selection
  const handlePanelClick = useCallback((panelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectionSuppressClickRef.current) return;

    // Shift+click or Cmd/Ctrl+click for multi-select toggle
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelectedPanelIds(prev => {
        const next = new Set(prev);
        if (next.has(panelId)) {
          next.delete(panelId);
        } else {
          next.add(panelId);
        }
        return next;
      });
      return;
    }

    // Normal click - select this panel only (like file explorer)
    setSelectedPanelIds(new Set([panelId]));
  }, []);

  // Handle double-click on panel - for contextual chat
  const handlePanelDoubleClick = useCallback((panelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectionSuppressClickRef.current) return;

    // Clear selection when opening chat
    setSelectedPanelIds(new Set());

    // Toggle contextual chat
    if (contextualChatPanelId === panelId) {
      setContextualChatPanelId(null);
    } else {
      setContextualChatPanelId(panelId);
      // Don't clear messages - they persist per panel
      // Auto-pan so the panel and chat are in view
      setTimeout(() => {
        const layout = panelLayouts[panelId];
        if (!layout || !transformRef.current || !canvasContainerRef.current) return;
        const viewportWidth = canvasContainerRef.current.clientWidth;
        const viewportHeight = canvasContainerRef.current.clientHeight;
        const currentScale = currentViewport.current.scale;
        const panelCenterX = layout.x + layout.width / 2;
        const panelCenterY = layout.y + layout.height / 2;
        const targetX = viewportWidth / 2 - panelCenterX * currentScale;
        const targetY = viewportHeight / 2 - panelCenterY * currentScale;
        transformRef.current.setTransform(targetX, targetY, currentScale, 400);
      }, 0);
    }
  }, [contextualChatPanelId, panelLayouts]);

  const minimizePanel = useCallback((panelId: string, options?: { clearSelection?: boolean }) => {
    setMinimizedPanels(prev => {
      const next = new Set(prev);
      next.add(panelId);
      return next;
    });
    setSelectedPanelIds(prev => {
      if (options?.clearSelection) return new Set();
      if (!prev.has(panelId)) return prev;
      const next = new Set(prev);
      next.delete(panelId);
      return next;
    });
    setOpenMenuId(null);
    if (focusedPanelId === panelId) {
      setFocusedPanelId(null);
    }
    if (contextualChatPanelId === panelId) {
      setContextualChatPanelId(null);
    }
  }, [contextualChatPanelId, focusedPanelId]);

  // Get panel title (needed for contextual prompts, menu labels, etc.)
  const getPanelTitle = useCallback((panel: UIPanel): string => {
    if (panel.title) return panel.title;
    if (panel.type === 'table' && panel.tableId && tables[panel.tableId]) {
      return tables[panel.tableId].title;
    }
    if (panel.type === 'chart' && panel.chartId && charts[panel.chartId]) {
      return charts[panel.chartId].title;
    }
    if (panel.type === 'cards' && panel.cardsId && cards[panel.cardsId]) {
      return cards[panel.cardsId].title;
    }
    return panel.type.charAt(0).toUpperCase() + panel.type.slice(1);
  }, [tables, charts, cards]);

  // Get resource path for a panel (used in read() instructions)
  const getPanelResource = useCallback((panel: UIPanel): string | null => {
    if (panel.type === 'table' && panel.tableId) return `table:${panel.tableId}`;
    if (panel.type === 'chart' && panel.chartId) return `chart:${panel.chartId}`;
    if (panel.type === 'cards' && panel.cardsId) return `cards:${panel.cardsId}`;
    if (panel.type === 'markdown') return `markdown:${panel.id}`;
    if ((panel.type === 'editor' || panel.type === 'pdf') && panel.filePath) return `file:${panel.filePath}`;
    // preview, chat, fileTree, detail have no readable resource
    return null;
  }, []);

  // Handle contextual chat message
  const handleContextualMessage = useCallback(async (message: string) => {
    if (!contextualChatPanelId) return;

    const panel = uiState.panels.find(p => p.id === contextualChatPanelId);
    if (!panel) return;

    const panelId = contextualChatPanelId;
    if (contextualChatLoading[panelId]) return;

    // Add user message and placeholder assistant message for streaming updates
    setContextualChatMessages(prev => ({
      ...prev,
      [panelId]: [
        ...(prev[panelId] || []),
        { id: makeMessageId(), role: 'user', content: message },
        { id: makeMessageId(), role: 'assistant', content: '' },
      ]
    }));
    setContextualChatLoading(prev => ({ ...prev, [panelId]: true }));
    setContextualChatStatus(prev => ({ ...prev, [panelId]: 'Thinking...' }));

    const resource = getPanelResource(panel);

    const contextualPrompt = `<contextual_focus>
The user is asking about a specific panel in their workspace.
This block is internal context. Do not repeat it in your reply.
Scope: Only this panel is in context. Other panels are out of scope unless explicitly provided.
Panels are isolated. A preview panel cannot access other panels' data at runtime.

Panel ID: ${panel.id}
Title: "${getPanelTitle(panel)}"
Type: ${panel.type}
${resource ? `Data: await read("${resource}")` : 'Data: (no readable data resource)'}
</contextual_focus>

User question: ${message}`;

    const updateAssistantMessage = (content: string) => {
      setContextualChatMessages(prev => {
        const history = [...(prev[panelId] || [])];
        const lastIndex = history.length - 1;
        if (lastIndex >= 0 && history[lastIndex].role === 'assistant') {
          history[lastIndex] = { ...history[lastIndex], content };
        } else {
          history.push({ id: makeMessageId(), role: 'assistant', content });
        }
        return { ...prev, [panelId]: history };
      });
    };

    let sawText = false;
    try {
      const responseText = await executeQuery(contextualPrompt, {
        skipMainChat: true,
        onTextDelta: (_delta, fullText) => {
          sawText = true;
          updateAssistantMessage(fullText);
        },
        onStatusUpdate: (event) => {
          setContextualChatStatus(prev => ({ ...prev, [panelId]: getStatusLabel(event) }));
        },
        panelContext: { sourcePanelId: panelId },
      });
      if (responseText?.trim()) {
        updateAssistantMessage(responseText);
      } else if (!sawText) {
        updateAssistantMessage('No response received. Please try again.');
      }
    } catch (error) {
      console.error('Contextual query error:', error);
      updateAssistantMessage('Sorry, there was an error processing your request.');
    } finally {
      setContextualChatLoading(prev => ({ ...prev, [panelId]: false }));
      setContextualChatStatus(prev => ({ ...prev, [panelId]: null }));
    }
  }, [contextualChatPanelId, contextualChatLoading, uiState.panels, getPanelResource, executeQuery, getPanelTitle, getStatusLabel, makeMessageId]);

  // Handle group contextual chat message
  const handleGroupContextualMessage = useCallback(async (message: string) => {
    if (!contextualChatGroupId) return;

    const group = groups.find(g => g.id === contextualChatGroupId);
    if (!group) return;

    const groupId = contextualChatGroupId;
    if (contextualChatLoading[groupId]) return;
    const groupPanels = group.panelIds.map(pid => uiState.panels.find(p => p.id === pid)).filter(Boolean);

    // Add user message and placeholder assistant message for streaming updates
    setContextualChatMessages(prev => ({
      ...prev,
      [groupId]: [
        ...(prev[groupId] || []),
        { id: makeMessageId(), role: 'user', content: message },
        { id: makeMessageId(), role: 'assistant', content: '' },
      ]
    }));
    setContextualChatLoading(prev => ({ ...prev, [groupId]: true }));
    setContextualChatStatus(prev => ({ ...prev, [groupId]: 'Thinking...' }));

    // Build context from all panels in the group (minimal, reference-based)
    const panelsContext = groupPanels.map(panel => {
      if (!panel) return '';
      const resource = getPanelResource(panel);
      const accessLine = resource ? `Data: await read("${resource}")` : 'Data: (no readable data resource)';
      return `- ID: ${panel.id}\n  Title: "${getPanelTitle(panel)}"\n  Type: ${panel.type}\n  ${accessLine}`;
    }).join('\n');

    const contextualPrompt = `<contextual_focus>
The user is asking about a group of related panels in their workspace.
This block is internal context. Do not repeat it in your reply.
Scope: Only the panels listed below are in context. Other panels are out of scope unless explicitly provided.
Panels are isolated. A preview panel cannot access other panels' data at runtime.

Group: ${group.name || 'Unnamed group'}
Panels (${groupPanels.length}):
${panelsContext}
</contextual_focus>

User question: ${message}`;

    const updateAssistantMessage = (content: string) => {
      setContextualChatMessages(prev => {
        const history = [...(prev[groupId] || [])];
        const lastIndex = history.length - 1;
        if (lastIndex >= 0 && history[lastIndex].role === 'assistant') {
          history[lastIndex] = { ...history[lastIndex], content };
        } else {
          history.push({ id: makeMessageId(), role: 'assistant', content });
        }
        return { ...prev, [groupId]: history };
      });
    };

    let sawText = false;
    try {
      const responseText = await executeQuery(contextualPrompt, {
        skipMainChat: true,
        onTextDelta: (_delta, fullText) => {
          sawText = true;
          updateAssistantMessage(fullText);
        },
        onStatusUpdate: (event) => {
          setContextualChatStatus(prev => ({ ...prev, [groupId]: getStatusLabel(event) }));
        },
        panelContext: { sourceGroupId: groupId },
      });
      if (responseText?.trim()) {
        updateAssistantMessage(responseText);
      } else if (!sawText) {
        updateAssistantMessage('No response received. Please try again.');
      }
    } catch (error) {
      console.error('Group contextual query error:', error);
      updateAssistantMessage('Sorry, there was an error processing your request.');
    } finally {
      setContextualChatLoading(prev => ({ ...prev, [groupId]: false }));
      setContextualChatStatus(prev => ({ ...prev, [groupId]: null }));
    }
  }, [contextualChatGroupId, contextualChatLoading, groups, uiState.panels, getPanelResource, executeQuery, getPanelTitle, getStatusLabel, makeMessageId]);

  // Handle canvas pointer down for drag-to-select
  // Left-click starts selection box, middle-click allows panning (RTS style controls)
  const [spacePanning, setSpacePanning] = useState(false);

  // Spacebar to pan with left mouse
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Ignore if focused on input/textarea/contenteditable
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        setSpacePanning(true);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePanning(false);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const releaseSelectionCapture = useCallback((pointerId?: number) => {
    const id = pointerId ?? selectionPointerIdRef.current;
    if (id == null) return;
    const el = canvasContainerRef.current;
    if (el && el.hasPointerCapture(id)) {
      el.releasePointerCapture(id);
    }
    selectionPointerIdRef.current = null;
  }, []);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    // Only handle left mouse button for selection
    // Middle mouse (button 1) passes through for panning
    if (e.button !== 0) return;

    // If space-panning, don't start a selection
    if (spacePanning) return;

    const target = e.target as HTMLElement;

    // Don't intercept clicks on interactive elements - let them handle their own events
    if (target.closest('.contextual-chat-popover')) return;
    if (target.closest('.group-boundary')) return;
    if (target.closest('button')) return;  // All buttons should work normally
    if (target.closest('.fixed')) return;  // Fixed UI elements (zoom controls, selection actions, etc.)
    if (target.closest('input')) return;
    if (target.closest('textarea')) return;
    if (target.closest('.panel-menu') || target.closest('.panel-menu-trigger')) return;

    const isPanel = !!target.closest('.artifact-card');
    if (isPanel) {
      if (target.closest('.artifact-header') || target.closest('.resize-handle')) return;
    }

    // Stop event from reaching TransformWrapper (prevents any panning interference)
    e.stopPropagation();

    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Convert screen coords to canvas coords
    const vp = currentViewport.current;
    const canvasX = (e.clientX - rect.left - vp.x) / vp.scale;
    const canvasY = (e.clientY - rect.top - vp.y) / vp.scale;

    if (isPanel) {
      selectionPendingRef.current = { x: canvasX, y: canvasY };
      return;
    }

    e.stopPropagation();
    if (canvasContainerRef.current) {
      canvasContainerRef.current.setPointerCapture(e.pointerId);
      selectionPointerIdRef.current = e.pointerId;
    }
    setSelectionBoxStart({ x: canvasX, y: canvasY });
    setSelectionBoxEnd({ x: canvasX, y: canvasY });
    setIsSelectingBox(true);
  }, [spacePanning]);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const vp = currentViewport.current;
    const canvasX = (e.clientX - rect.left - vp.x) / vp.scale;
    const canvasY = (e.clientY - rect.top - vp.y) / vp.scale;

    if (isSelectingBox && selectionBoxStart) {
      setSelectionBoxEnd({ x: canvasX, y: canvasY });
      return;
    }

    const pending = selectionPendingRef.current;
    if (!pending) return;

    const dx = canvasX - pending.x;
    const dy = canvasY - pending.y;
    if (Math.hypot(dx, dy) < 6) return;

    selectionPendingRef.current = null;
    if (canvasContainerRef.current) {
      canvasContainerRef.current.setPointerCapture(e.pointerId);
      selectionPointerIdRef.current = e.pointerId;
    }
    setSelectionBoxStart({ x: pending.x, y: pending.y });
    setSelectionBoxEnd({ x: canvasX, y: canvasY });
    setIsSelectingBox(true);
  }, [isSelectingBox, selectionBoxStart]);

  const handleCanvasPointerUp = useCallback((e?: React.PointerEvent | PointerEvent) => {
    const pointerId = e && 'pointerId' in e ? e.pointerId : undefined;
    releaseSelectionCapture(pointerId);
    if (!isSelectingBox || !selectionBoxStart || !selectionBoxEnd) {
      setIsSelectingBox(false);
      setSelectionBoxStart(null);
      setSelectionBoxEnd(null);
      selectionPendingRef.current = null;
      return;
    }

    // Calculate selection rectangle
    const left = Math.min(selectionBoxStart.x, selectionBoxEnd.x);
    const right = Math.max(selectionBoxStart.x, selectionBoxEnd.x);
    const top = Math.min(selectionBoxStart.y, selectionBoxEnd.y);
    const bottom = Math.max(selectionBoxStart.y, selectionBoxEnd.y);

    const boxWidth = right - left;
    const boxHeight = bottom - top;

    // If box is large enough, select panels within it
    const isDragSelection = boxWidth > 10 && boxHeight > 10;
    if (isDragSelection) {
      // Find panels that intersect with selection box
      const selected = new Set<string>();
      for (const panel of visiblePanels) {
        const layout = panelLayouts[panel.id];
        if (!layout) continue;

        // Check if panel intersects with selection box
        const panelLeft = layout.x;
        const panelRight = layout.x + layout.width;
        const panelTop = layout.y;
        const panelBottom = layout.y + layout.height;

        if (panelRight > left && panelLeft < right && panelBottom > top && panelTop < bottom) {
          selected.add(panel.id);
        }
      }
      setSelectedPanelIds(selected);
    } else {
      // Click (not drag) on empty canvas - clear selection
      setSelectedPanelIds(new Set());
    }

    setIsSelectingBox(false);
    setSelectionBoxStart(null);
    setSelectionBoxEnd(null);
    selectionPendingRef.current = null;
    if (isDragSelection) {
      selectionSuppressClickRef.current = true;
      setTimeout(() => {
        selectionSuppressClickRef.current = false;
      }, 0);
    }
  }, [isSelectingBox, selectionBoxStart, selectionBoxEnd, visiblePanels, panelLayouts, releaseSelectionCapture]);

  // Ensure selection ends even if pointer is released outside the canvas
  useEffect(() => {
    if (!isSelectingBox) return;
    const onWindowPointerUp = (event: PointerEvent) => {
      handleCanvasPointerUp(event);
    };
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => window.removeEventListener('pointerup', onWindowPointerUp);
  }, [isSelectingBox, handleCanvasPointerUp]);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'info' = 'success') => {
    // Clear any existing toast timeout
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Create a group from selected panels
  // If openChat is true, opens contextual chat for the new group
  const createGroup = useCallback((options?: { openChat?: boolean }) => {
    if (selectedPanelIds.size < 2) return;

    const groupId = `group-${Date.now()}`;
    const panelCount = selectedPanelIds.size;
    const selectedArray = Array.from(selectedPanelIds);

    // Get current layouts for selected panels
    const selectedLayouts = selectedArray.map(id => ({ id, layout: panelLayouts[id] })).filter(p => p.layout);

    if (selectedLayouts.length >= 2) {
      // Calculate centroid of all selected panels
      let centerX = 0, centerY = 0;
      for (const { layout } of selectedLayouts) {
        centerX += layout.x + layout.width / 2;
        centerY += layout.y + layout.height / 2;
      }
      centerX /= selectedLayouts.length;
      centerY /= selectedLayouts.length;

      // Helper to check if two rectangles overlap
      const rectsOverlap = (a: CanvasPanelLayout, b: CanvasPanelLayout, gap = 16) => {
        return !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
                 a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
      };

      // Try pulling with decreasing factors until no overlap
      const pullFactors = [0.25, 0.15, 0.08, 0];
      let finalLayouts: Record<string, CanvasPanelLayout> | null = null;

      for (const pullFactor of pullFactors) {
        const testLayouts: Record<string, CanvasPanelLayout> = {};

        // Calculate proposed positions
        for (const { id, layout } of selectedLayouts) {
          const panelCenterX = layout.x + layout.width / 2;
          const panelCenterY = layout.y + layout.height / 2;
          const dx = centerX - panelCenterX;
          const dy = centerY - panelCenterY;

          testLayouts[id] = {
            ...layout,
            x: layout.x + dx * pullFactor,
            y: layout.y + dy * pullFactor,
          };
        }

        // Check for overlaps between any pair
        let hasOverlap = false;
        const ids = Object.keys(testLayouts);
        outer: for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            if (rectsOverlap(testLayouts[ids[i]], testLayouts[ids[j]])) {
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

      // Apply the safe positions (or original if all factors cause overlap)
      if (finalLayouts) {
        setPanelLayouts(prev => {
          const updated = { ...prev };
          for (const [id, layout] of Object.entries(finalLayouts!)) {
            if (updated[id]) {
              updated[id] = layout;
            }
          }
          return updated;
        });
      }
    }

    setGroups(prev => {
      // First, remove selected panels from any existing groups
      const updatedGroups = prev
        .map(g => ({
          ...g,
          panelIds: g.panelIds.filter(id => !selectedPanelIds.has(id))
        }))
        .filter(g => g.panelIds.length >= 2); // Remove groups that become too small

      // Then add the new group
      return [...updatedGroups, {
        id: groupId,
        panelIds: selectedArray,
      }];
    });
    setSelectedPanelIds(new Set());

    if (options?.openChat) {
      // Open chat for the new group
      setContextualChatPanelId(null);
      setContextualChatGroupId(groupId);
    } else {
      showToast(`Grouped ${panelCount} panels`);
    }
  }, [selectedPanelIds, panelLayouts, showToast]);

  // Align selected panels to an edge/center
  const alignSelected = useCallback((mode: 'left' | 'right' | 'centerX' | 'top' | 'bottom' | 'centerY') => {
    if (selectedPanelIds.size < 2) return;
    lastLayoutInteractionRef.current = Date.now();
    const ids = Array.from(selectedPanelIds).filter(id => panelLayouts[id]);
    if (ids.length < 2) return;
    const rects = ids.map(id => ({ id, l: panelLayouts[id] }));
    const minX = Math.min(...rects.map(r => r.l.x));
    const maxX = Math.max(...rects.map(r => r.l.x + r.l.width));
    const minY = Math.min(...rects.map(r => r.l.y));
    const maxY = Math.max(...rects.map(r => r.l.y + r.l.height));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const changed: Record<string, { x: number; y: number; width: number; height: number }> = {};
    setPanelLayouts(prev => {
      const next = { ...prev };
      for (const id of ids) {
        const l = next[id]!;
        let x = l.x, y = l.y;
        if (mode === 'left') x = minX;
        if (mode === 'right') x = maxX - l.width;
        if (mode === 'centerX') x = Math.round(centerX - l.width / 2);
        if (mode === 'top') y = minY;
        if (mode === 'bottom') y = maxY - l.height;
        if (mode === 'centerY') y = Math.round(centerY - l.height / 2);
        const nl = { ...l, x, y };
        next[id] = nl;
        changed[id] = nl;
      }
      return next;
    });
    if (Object.keys(changed).length > 0) {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: changed }),
      }).catch(console.error);
    }
  }, [selectedPanelIds, panelLayouts, workspaceId]);

  // Distribute selected panels evenly along axis by center points
  const distributeSelected = useCallback((axis: 'horizontal' | 'vertical') => {
    if (selectedPanelIds.size < 3) return;
    lastLayoutInteractionRef.current = Date.now();
    const ids = Array.from(selectedPanelIds).filter(id => panelLayouts[id]);
    if (ids.length < 3) return;
    const sorted = [...ids].sort((a, b) => {
      const la = panelLayouts[a]!;
      const lb = panelLayouts[b]!;
      const ca = axis === 'horizontal' ? la.x + la.width / 2 : la.y + la.height / 2;
      const cb = axis === 'horizontal' ? lb.x + lb.width / 2 : lb.y + lb.height / 2;
      return ca - cb;
    });
    const first = panelLayouts[sorted[0]]!;
    const last = panelLayouts[sorted[sorted.length - 1]]!;
    const start = axis === 'horizontal' ? first.x + first.width / 2 : first.y + first.height / 2;
    const end = axis === 'horizontal' ? last.x + last.width / 2 : last.y + last.height / 2;
    const step = (end - start) / (sorted.length - 1);
    const changed: Record<string, { x: number; y: number; width: number; height: number }> = {};
    setPanelLayouts(prev => {
      const next = { ...prev };
      sorted.forEach((id, idx) => {
        if (idx === 0 || idx === sorted.length - 1) return;
        const l = next[id]!;
        const center = start + step * idx;
        const nl = axis === 'horizontal' ? { ...l, x: Math.round(center - l.width / 2) } : { ...l, y: Math.round(center - l.height / 2) };
        next[id] = nl as typeof l;
        changed[id] = next[id]!;
      });
      return next;
    });
    if (Object.keys(changed).length > 0) {
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: changed }),
      }).catch(console.error);
    }
  }, [selectedPanelIds, panelLayouts, workspaceId]);

  // Calculate selection bounds for toolbar positioning
  const selectionBounds = useMemo(() => {
    // Priority: selected group > multiple selected panels > single focused panel
    if (selectedPanelIds.size > 0) {
      const selectedArray = Array.from(selectedPanelIds).filter(id => visiblePanelIds.has(id));
      const layouts = selectedArray.map(id => panelLayouts[id]).filter(Boolean);
      if (layouts.length === 0) return null;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const layout of layouts) {
        minX = Math.min(minX, layout.x);
        minY = Math.min(minY, layout.y);
        maxX = Math.max(maxX, layout.x + layout.width);
        maxY = Math.max(maxY, layout.y + layout.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return null;
  }, [selectedPanelIds, panelLayouts, visiblePanelIds]);

  const canvasViewport = canvasContainerRef.current
    ? { width: canvasContainerRef.current.clientWidth, height: canvasContainerRef.current.clientHeight }
    : undefined;

  // Get info about single selected panel for toolbar
  const singleSelectedPanel = useMemo(() => {
    if (selectedPanelIds.size !== 1) return null;
    const panelId = Array.from(selectedPanelIds)[0];
    return visiblePanels.find(p => p.id === panelId) || null;
  }, [selectedPanelIds, visiblePanels]);

  // Check if single selected panel is in a group
  const singleSelectedPanelGroup = useMemo(() => {
    if (!singleSelectedPanel) return null;
    return groups.find(g => g.panelIds.includes(singleSelectedPanel.id)) || null;
  }, [singleSelectedPanel, groups]);

  const hoveredPanel = useMemo(() => {
    if (selectedPanelIds.size > 0) return null;
    const targetId = hoveredToolbarPanelId ?? hoveredPanelId;
    if (!targetId) return null;
    return visiblePanels.find(p => p.id === targetId) || null;
  }, [selectedPanelIds, hoveredPanelId, hoveredToolbarPanelId, visiblePanels]);

  const hoveredPanelBounds = useMemo(() => {
    if (!hoveredPanel) return null;
    const layout = panelLayouts[hoveredPanel.id];
    if (!layout) return null;
    return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
  }, [hoveredPanel, panelLayouts]);

  const hoveredPanelGroup = useMemo(() => {
    if (!hoveredPanel) return null;
    return groups.find(g => g.panelIds.includes(hoveredPanel.id)) || null;
  }, [hoveredPanel, groups]);

  const toolbarPanel = selectedPanelIds.size > 0 ? singleSelectedPanel : hoveredPanel;
  const toolbarBounds = selectedPanelIds.size > 0 ? selectionBounds : hoveredPanelBounds;
  const toolbarPanelIds = selectedPanelIds.size > 0
    ? selectedPanelIds
    : (hoveredPanel ? new Set([hoveredPanel.id]) : new Set<string>());
  const toolbarGroup = selectedPanelIds.size > 0 ? selectedPanelsGroup : null;
  const toolbarSinglePanelGroup = selectedPanelIds.size > 0 ? singleSelectedPanelGroup : hoveredPanelGroup;
  const showToolbar = !!toolbarBounds && (selectedPanelIds.size > 0 || !!hoveredPanel);

  // Ungroup selected panels
  const ungroupPanels = useCallback(() => {
    if (!selectedPanelsGroup) return;
    const groupId = selectedPanelsGroup.id;
    const groupName = selectedPanelsGroup.name || 'Group';
    setGroups(prev => prev.filter(g => g.id !== groupId));
    setSelectedPanelIds(new Set());
    // Clean up contextual chat messages for the removed group
    setContextualChatMessages(prev => {
      const rest = { ...prev } as Record<string, Array<{ id: string; role: 'user' | 'assistant'; content: string }>>;
      delete rest[groupId];
      return rest;
    });
    setContextualChatLoading(prev => {
      if (!(groupId in prev)) return prev;
      const rest = { ...prev };
      delete rest[groupId];
      return rest;
    });
    setContextualChatStatus(prev => {
      if (!(groupId in prev)) return prev;
      const rest = { ...prev };
      delete rest[groupId];
      return rest;
    });
    // Close group chat if it was open
    if (contextualChatGroupId === groupId) {
      setContextualChatGroupId(null);
    }
    showToast(`Ungrouped "${groupName}"`);
  }, [selectedPanelsGroup, contextualChatGroupId, showToast]);

  // Rename a group
  const renameGroup = useCallback((groupId: string, newName: string) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, name: newName.trim() || undefined } : g
    ));
    setEditingGroupId(null);
    setGroupNameInput('');
    if (newName.trim()) {
      showToast(`Group renamed to "${newName.trim()}"`);
    }
  }, [showToast]);

  // Remove a single panel from its group
  const removeFromGroup = useCallback((panelId: string) => {
    const group = groups.find(g => g.panelIds.includes(panelId));
    if (!group) return;

    setGroups(prev => prev.map(g =>
      g.id === group.id
        ? { ...g, panelIds: g.panelIds.filter(id => id !== panelId) }
        : g
    ).filter(g => g.panelIds.length >= 2)); // Remove groups with <2 panels

    showToast('Removed from group');
  }, [groups, showToast]);

  // Save workspace title/description
  const saveWorkspaceInfo = async (title?: string, description?: string) => {
    if (!workspace) return;
    try {
      const updates: Record<string, string> = {};
      if (title !== undefined) updates.name = title;
      if (description !== undefined) updates.description = description;

      await apiFetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      setWorkspace({ ...workspace, ...updates });
    } catch (error) {
      console.error('Failed to save workspace info:', error);
    }
  };

  // Publish to gallery
  const handlePublish = async () => {
    if (!publishTitle.trim() || !publishDescription.trim()) return;
    setIsPublishing(true);

    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: publishTitle.trim(),
          description: publishDescription.trim(),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setPublishModalOpen(false);
        setPublishTitle('');
        setPublishDescription('');
        // Update workspace with galleryId
        if (workspace && data.item?.id) {
          setWorkspace({ ...workspace, galleryId: data.item.id });
        }
        alert('Published to gallery!');
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to publish');
      }
    } catch (error) {
      console.error('Publish error:', error);
      alert('Failed to publish');
    } finally {
      setIsPublishing(false);
    }
  };

  // Unpublish from gallery
  const handleUnpublish = async () => {
    if (!workspace?.galleryId) return;
    if (!confirm('Remove this workspace from the gallery?')) return;

    try {
      const res = await apiFetch(`/api/gallery/${workspace.galleryId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setWorkspace({ ...workspace, galleryId: undefined });
        alert('Removed from gallery');
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to unpublish');
      }
    } catch (error) {
      console.error('Unpublish error:', error);
      alert('Failed to unpublish');
    }
  };

  // Delete workspace
  const handleDelete = async () => {
    if (!confirm('Delete this workspace? This cannot be undone.')) return;

    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        router.push(`${basePath}/`);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete');
      }
    } catch (error) {
      console.error('Delete error:', error);
      alert('Failed to delete workspace');
    }
  };

  // Render artifact content
  const renderArtifact = (panel: UIPanel) => {
    switch (panel.type) {
      case 'table':
        return <TableContent table={panel.tableId ? tables[panel.tableId] : null} />;
      case 'chart':
        return <ChartContent chart={panel.chartId ? charts[panel.chartId] : null} />;
      case 'cards':
        return <CardsContent cards={panel.cardsId ? cards[panel.cardsId] : null} />;
      case 'markdown':
        return <MarkdownContent content={panel.content} />;
      case 'preview':
        return <PreviewContent content={panel.content} />;
      case 'pdf':
        return <PDFContent workspaceId={workspaceId} filePath={panel.filePath} />;
      default:
        return <div className="text-muted-foreground text-sm">Unknown type: {panel.type}</div>;
    }
  };

  // (moved) getPanelTitle is defined earlier above

  // Download utilities
  const escapeCSV = (value: unknown): string => {
    const str = value === null || value === undefined ? '' : String(value);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };

  const downloadBlob = (content: string | Blob, filename: string, type: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPanel = (panel: UIPanel, format: string) => {
    const title = getPanelTitle(panel);
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

    if (panel.type === 'table' && panel.tableId) {
      const table = tables[panel.tableId];
      if (!table) return;
      if (format === 'csv') {
        const headers = table.columns.map(c => escapeCSV(c.label)).join(',');
        const rows = table.data.map(row =>
          table.columns.map(c => escapeCSV(row[c.key])).join(',')
        );
        downloadBlob([headers, ...rows].join('\n'), `${safeTitle}.csv`, 'text/csv');
      } else {
        downloadBlob(JSON.stringify(table.data, null, 2), `${safeTitle}.json`, 'application/json');
      }
    } else if (panel.type === 'chart' && panel.chartId) {
      const chart = charts[panel.chartId];
      if (!chart) return;
      if (format === 'csv') {
        if (chart.data.length > 0) {
          const keys = Object.keys(chart.data[0]);
          const headers = keys.map(k => escapeCSV(k)).join(',');
          const rows = chart.data.map(row => keys.map(k => escapeCSV(row[k])).join(','));
          downloadBlob([headers, ...rows].join('\n'), `${safeTitle}.csv`, 'text/csv');
        }
      } else {
        downloadBlob(JSON.stringify(chart.data, null, 2), `${safeTitle}.json`, 'application/json');
      }
    } else if (panel.type === 'cards' && panel.cardsId) {
      const cardsData = cards[panel.cardsId];
      if (!cardsData) return;
      downloadBlob(JSON.stringify(cardsData.items, null, 2), `${safeTitle}.json`, 'application/json');
    } else if (panel.type === 'markdown') {
      downloadBlob(panel.content || '', `${safeTitle}.md`, 'text/markdown');
    } else if (panel.type === 'preview') {
      downloadBlob(panel.content || '', `${safeTitle}.html`, 'text/html');
    }
  };

  const [exportError, setExportError] = useState<string | null>(null);

  const downloadPanelAsPng = async (panelId: string, title: string) => {
    const element = panelRefs.current[panelId];
    if (!element) {
      setExportError('Panel not found');
      return;
    }

    try {
      const dataUrl = await toPng(element, {
        backgroundColor: '#1a1a1a',
        pixelRatio: 2,
        cacheBust: true,
        skipFonts: true,
        filter: (node) => {
          // Skip problematic elements
          if (node instanceof Element) {
            const tagName = node.tagName?.toLowerCase();
            if (tagName === 'link' || tagName === 'style') return false;
          }
          return true;
        },
      });
      const link = document.createElement('a');
      const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      link.download = `${safeTitle}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error('Failed to export PNG:', error);
      setExportError('Failed to export image. Try again.');
      setTimeout(() => setExportError(null), 3000);
    }
  };

  const removePanel = useCallback(async (panelId: string) => {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/panels/${panelId}`, { method: 'DELETE' });
      // Clean up panel ref to avoid memory leak
      delete panelRefs.current[panelId];
      setUIState(prev => ({
        ...prev,
        panels: prev.panels.filter(p => p.id !== panelId)
      }));
      // Remove from groups and delete empty groups
      setGroups(prev => prev
        .map(g => ({ ...g, panelIds: g.panelIds.filter(id => id !== panelId) }))
        .filter(g => g.panelIds.length >= 2)
      );
      setMinimizedPanels(prev => {
        if (!prev.has(panelId)) return prev;
        const next = new Set(prev);
        next.delete(panelId);
        return next;
      });
      // Remove from connections
      setConnections(prev => prev.filter(c => c.sourceId !== panelId && c.targetId !== panelId));
      // Clean up layout
      setPanelLayouts(prev => {
        const rest = { ...prev } as Record<string, { x: number; y: number; width: number; height: number }>;
        delete rest[panelId];
        return rest;
      });
      // Clean up contextual chat messages
      setContextualChatMessages(prev => {
        const rest = { ...prev } as Record<string, Array<{ id: string; role: 'user' | 'assistant'; content: string }>>;
        delete rest[panelId];
        return rest;
      });
      setContextualChatLoading(prev => {
        if (!(panelId in prev)) return prev;
        const rest = { ...prev };
        delete rest[panelId];
        return rest;
      });
      setContextualChatStatus(prev => {
        if (!(panelId in prev)) return prev;
        const rest = { ...prev };
        delete rest[panelId];
        return rest;
      });
    } catch (error) {
      console.error('Failed to remove panel:', error);
    }
  }, [workspaceId]);

  // Global Escape to clear selection and keyboard shortcuts (after handlers are defined)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Avoid interfering with text inputs
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Clear selection / close chats
      if (e.key === 'Escape') {
        setSelectedPanelIds(new Set());
        setContextualChatPanelId(null);
        setContextualChatGroupId(null);
        return;
      }

      // Delete selected panels
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPanelIds.size > 0) {
        e.preventDefault();
        const ids = Array.from(selectedPanelIds);
        if (ids.length === 1) {
          removePanel(ids[0]);
        } else {
          ids.forEach(id => removePanel(id));
        }
        setSelectedPanelIds(new Set());
        return;
      }

      // Group (Cmd/Ctrl + G)
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) {
          // Ungroup
          if (selectedPanelsGroup) ungroupPanels();
        } else {
          // Group
          if (selectedPanelIds.size >= 2) createGroup();
        }
        return;
      }

      // Nudge with arrow keys
      const step = e.shiftKey ? 20 : 5;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      if ((dx !== 0 || dy !== 0) && selectedPanelIds.size > 0) {
        e.preventDefault();
        const changed: Record<string, { x: number; y: number; width: number; height: number }> = {};
        setPanelLayouts(prev => {
          const next = { ...prev };
          for (const id of selectedPanelIds) {
            const l = next[id];
            if (!l) continue;
            const nl = { ...l, x: l.x + dx, y: l.y + dy };
            next[id] = nl;
            changed[id] = nl;
          }
          return next;
        });
        if (Object.keys(changed).length > 0) {
          apiFetch(`/api/workspaces/${workspaceId}/layout`, {
            method: 'PATCH',
            body: JSON.stringify({ panels: changed }),
          }).catch(console.error);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedPanelIds, selectedPanelsGroup, removePanel, createGroup, ungroupPanels, workspaceId]);

  // Loading state
  if (!workspace) {
    return (
      <div className="min-h-screen flex items-center justify-center canvas-bg">
        <div className="animate-subtle-pulse text-muted-foreground">Loading workspace...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Error Toast */}
      {exportError && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2 bg-destructive text-destructive-foreground rounded-lg shadow-lg text-sm animate-fade-in">
          {exportError}
        </div>
      )}
      {/* Header */}
      <header className="canvas-header flex-shrink-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
            </Link>
            <div className="min-w-0 flex-1">
              {editingTitle ? (
                <input
                  type="text"
                  value={tempTitle}
                  onChange={(e) => setTempTitle(e.target.value)}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== originalTitleRef.current) {
                      saveWorkspaceInfo(value);
                    }
                    setEditingTitle(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const value = (e.target as HTMLInputElement).value.trim();
                      if (value && value !== originalTitleRef.current) {
                        saveWorkspaceInfo(value);
                      }
                      setEditingTitle(false);
                    } else if (e.key === 'Escape') {
                      setEditingTitle(false);
                    }
                  }}
                  className="text-xl font-medium bg-transparent border-b border-primary outline-none w-full"
                  autoFocus
                />
              ) : (
                <h1
                  className="text-xl font-medium cursor-pointer hover:text-primary transition-colors truncate"
                  onClick={() => {
                    originalTitleRef.current = workspace.name;
                    setTempTitle(workspace.name);
                    setEditingTitle(true);
                  }}
                  title="Click to edit title"
                >
                  {workspace.name}
                </h1>
              )}
              {editingDescription ? (
                <input
                  type="text"
                  value={tempDescription}
                  onChange={(e) => setTempDescription(e.target.value)}
                  onBlur={(e) => {
                    const value = e.target.value;
                    if (value !== originalDescriptionRef.current) {
                      saveWorkspaceInfo(undefined, value);
                    }
                    setEditingDescription(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const value = (e.target as HTMLInputElement).value;
                      if (value !== originalDescriptionRef.current) {
                        saveWorkspaceInfo(undefined, value);
                      }
                      setEditingDescription(false);
                    } else if (e.key === 'Escape') {
                      setEditingDescription(false);
                    }
                  }}
                  className="text-sm text-muted-foreground bg-transparent border-b border-primary/50 outline-none w-full"
                  autoFocus
                />
              ) : (
                <p
                  className="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors truncate"
                  onClick={() => {
                    originalDescriptionRef.current = workspace.description || '';
                    setTempDescription(workspace.description || '');
                    setEditingDescription(true);
                  }}
                  title="Click to edit description"
                >
                  {workspace.description || 'Add a description...'}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-lg">
              {artifactPanels.length} artifact{artifactPanels.length !== 1 ? 's' : ''}
            </span>
            <CapabilitiesPanel skills={skills} />
            {workspace.galleryId ? (
              <button
                onClick={handleUnpublish}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors"
                title="Remove from gallery"
              >
                Unpublish
              </button>
            ) : artifactPanels.length > 0 ? (
              <button
                onClick={() => {
                  setPublishTitle(workspace.name);
                  setPublishDescription(workspace.description || '');
                  setPublishModalOpen(true);
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                title="Publish to gallery"
              >
                Publish
              </button>
            ) : null}
            <button
              onClick={() => setTourOpen(true)}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Start tutorial"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.32-.67.414-.74.295-1.338.987-1.338 1.796v.406M12 17.25h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {resolvedTheme === 'dark' ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              )}
            </button>
            <button
              onClick={handleDelete}
              className="p-2 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
              title="Delete workspace"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={chatOpen ? 'Hide chat' : 'Show chat'}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0">
        {/* Canvas Area */}
        <div
          ref={canvasContainerRef}
          data-tour="canvas"
          className={`flex-1 canvas-bg overflow-hidden transition-all duration-300 relative ${chatOpen ? 'md:mr-[400px]' : ''}`}
          onPointerDownCapture={handleCanvasPointerDown}
          onPointerMoveCapture={handleCanvasPointerMove}
          onPointerUpCapture={handleCanvasPointerUp}
        >
          <TransformWrapper
              initialScale={uiState.viewport?.zoom ?? 0.75}
              initialPositionX={uiState.viewport?.x ?? -2500}
              initialPositionY={uiState.viewport?.y ?? -2000}
              minScale={0.1}
              maxScale={3}
              limitToBounds={false}
              centerZoomedOut={false}
              disabled={isSelectingBox}
              wheel={{ step: 0.1, excluded: ['no-zoom-scroll'] }}
              panning={{ velocityDisabled: true, allowLeftClickPan: spacePanning, allowMiddleClickPan: true }}
              doubleClick={{ disabled: true }}
              alignmentAnimation={{ disabled: true }}
              onTransformed={(_, state) => {
                setZoomLevel(state.scale);
                // Track current viewport for new panel placement
                currentViewport.current = { x: state.positionX, y: state.positionY, scale: state.scale };
                // Debounced save of viewport position
                if (viewportSaveTimeout.current) clearTimeout(viewportSaveTimeout.current);
                viewportSaveTimeout.current = setTimeout(() => {
                  apiFetch(`/api/workspaces/${workspaceId}/viewport`, {
                    method: 'PATCH',
                    body: JSON.stringify({ x: state.positionX, y: state.positionY, zoom: state.scale }),
                  }).catch(console.error);
                }, 500);
              }}
            >
              {({ zoomIn, zoomOut, resetTransform, setTransform }) => {
                // Store setTransform in ref for programmatic viewport control
                transformRef.current = { setTransform };
                return (
                <>
                  {/* Zoom Controls */}
                  <div className="fixed bottom-4 left-4 z-40 flex items-center gap-1 bg-card/90 backdrop-blur border border-border rounded-lg p-1 shadow-lg" data-tour="zoom-controls">
                    <button
                      onClick={() => zoomOut(0.1)}
                      className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                      title="Zoom out"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6" />
                      </svg>
                    </button>
                    <span className="text-xs font-mono text-muted-foreground w-12 text-center">{Math.round(zoomLevel * 100)}%</span>
                    <button
                      onClick={() => zoomIn(0.1)}
                      className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                      title="Zoom in"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" />
                      </svg>
                    </button>
                    {zoomLevel !== 1 && (
                      <button
                        onClick={() => resetTransform()}
                        className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground text-xs"
                        title="Reset zoom"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  

                  {/* Minimized Panels Dock */}
                  {minimizedPanels.size > 0 && (
                    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-card/90 backdrop-blur border border-border rounded-lg p-2 shadow-lg">
                      {Array.from(minimizedPanels).map(panelId => {
                        const panel = artifactPanels.find(p => p.id === panelId);
                        if (!panel) return null;
                        return (
                          <button
                            key={panelId}
                            onClick={() => setMinimizedPanels(prev => {
                              const next = new Set(prev);
                              next.delete(panelId);
                              return next;
                            })}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted hover:bg-muted/80 transition-colors text-sm"
                            title={`Restore ${getPanelTitle(panel)}`}
                          >
                            <span className="truncate max-w-[120px]">{getPanelTitle(panel)}</span>
                            <span className="text-xs text-muted-foreground">{panel.type}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Canvas Hint - shows interaction tips */}
                  {showCanvasHint && visiblePanels.length > 0 && (
                    <div className="canvas-hint fixed top-20 left-1/2 -translate-x-1/2 z-40">
                      <div className="flex items-center gap-3 px-4 py-2.5 bg-card/95 backdrop-blur border border-border rounded-lg shadow-lg text-sm">
                        <span className="text-muted-foreground">
                          <strong className="text-foreground">Drag</strong> to select
                          <span className="mx-2 text-border">|</span>
                          <strong className="text-foreground">Space + drag</strong> (or middle-click) to pan
                          <span className="mx-2 text-border">|</span>
                          <strong className="text-foreground">Scroll</strong> to zoom
                        </span>
                        <button
                          onClick={() => {
                            setShowCanvasHint(false);
                            localStorage.setItem('canvas-hint-dismissed', 'true');
                          }}
                          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                          aria-label="Dismiss hint"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Toast Notification */}
                  {toast && (
                    <div className="toast-notification fixed top-20 right-4 z-50">
                      <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm ${
                        toast.type === 'success'
                          ? 'bg-green-500/10 border border-green-500/30 text-green-700 dark:text-green-400'
                          : 'bg-blue-500/10 border border-blue-500/30 text-blue-700 dark:text-blue-400'
                      }`}>
                        {toast.type === 'success' ? (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                        <span>{toast.message}</span>
                      </div>
                    </div>
                  )}

                  <TransformComponent
                    wrapperStyle={{ width: '100%', height: '100%' }}
                    contentStyle={{ width: '8000px', height: '8000px' }}
                  >
                    <div
                      className="canvas-content relative"
                      style={{ width: '8000px', height: '8000px' }}
                    >
                      {/* Group boundaries (render first so they're behind panels) */}
                      {groups.map(group => (
                        <GroupBoundary
                          key={group.id}
                          group={group}
                          panelLayouts={panelLayouts}
                          existingPanelIds={existingPanelIds}
                          visiblePanelIds={visiblePanelIds}
                          scale={zoomLevel}
                          onGroupClick={(groupId) => {
                            // Select all panels in the group
                            const g = groups.find(grp => grp.id === groupId);
                            if (g) {
                              const selected = g.panelIds.filter(id => visiblePanelIds.has(id));
                              setSelectedPanelIds(new Set(selected));
                            }
                          }}
                          onGroupRename={renameGroup}
                          onGroupDrag={handleGroupDrag}
                          onGroupDragEnd={handleGroupDragEnd}
                          isEditing={editingGroupId === group.id}
                          editValue={editingGroupId === group.id ? groupNameInput : group.name || ''}
                          onEditChange={setGroupNameInput}
                          onEditStart={(groupId) => {
                            const g = groups.find(grp => grp.id === groupId);
                            setEditingGroupId(groupId);
                            setGroupNameInput(g?.name || '');
                          }}
                        />
                      ))}

                      {/* Connection lines between panels */}
                      <ConnectionLines
                        connections={visibleConnections}
                        panelLayouts={panelLayouts}
                        animatingConnectionIds={animatingConnectionIds}
                        panelTitles={Object.fromEntries(
                          visiblePanels.map(p => [p.id, getPanelTitle(p)])
                        )}
                      />

                      {visiblePanels.map((panel) => {
                        const layout = panelLayouts[panel.id];
                        if (!layout) return null;

                        return (
                          <DraggablePanel
                            key={panel.id}
                            id={panel.id}
                            layout={layout}
                            title={getPanelTitle(panel)}
                            type={panel.type}
                            scale={zoomLevel}
                            zIndex={focusedPanelId === panel.id ? 100 : 1}
                            onLayoutChange={handleLayoutChange}
                            onDragStart={handlePanelDragStart}
                            onDragEnd={handleDragEnd}
                            isInDraggingGroup={draggingGroupId !== null && groups.find(g => g.id === draggingGroupId)?.panelIds.includes(panel.id)}
                            onFocus={setFocusedPanelId}
                            onOpenMenu={setOpenMenuId}
                            isMenuOpen={openMenuId === panel.id}
                            isSelected={selectedPanelIds.has(panel.id)}
                            onPanelClick={handlePanelClick}
                            onPanelDoubleClick={handlePanelDoubleClick}
                            isAnimating={animatingPanelIds.has(panel.id)}
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
                            menuContent={
                              <>
                                {panel.type === 'table' && (
                                  <>
                                    <button onClick={() => { downloadPanel(panel, 'csv'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download CSV</button>
                                    <button onClick={() => { downloadPanel(panel, 'json'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download JSON</button>
                                  </>
                                )}
                                {panel.type === 'chart' && (
                                  <>
                                    <button onClick={() => { downloadPanelAsPng(panel.id, getPanelTitle(panel)); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download PNG</button>
                                    <button onClick={() => { downloadPanel(panel, 'csv'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download CSV</button>
                                    <button onClick={() => { downloadPanel(panel, 'json'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download JSON</button>
                                  </>
                                )}
                                {panel.type === 'cards' && (
                                  <button onClick={() => { downloadPanel(panel, 'json'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download JSON</button>
                                )}
                                {panel.type === 'markdown' && (
                                  <button onClick={() => { downloadPanel(panel, 'md'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download .md</button>
                                )}
                                {panel.type === 'preview' && (
                                  <button onClick={() => { downloadPanel(panel, 'html'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Download HTML</button>
                                )}
                                {panel.type === 'pdf' && panel.filePath && (
                                  <button onClick={() => { window.open(`${basePath}/api/workspaces/${workspaceId}/files/${encodeURIComponent(panel.filePath!)}`, '_blank'); setOpenMenuId(null); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors">Open in new tab</button>
                                )}
                                <button
                                  onClick={() => minimizePanel(panel.id)}
                                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" /></svg>
                                  Minimize
                                </button>
                                <button
                                  onClick={() => { setMaximizedPanelId(panel.id); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
                                  Maximize
                                </button>
                                <div className="border-t border-border my-1" />
                                <button
                                  onClick={() => { removePanel(panel.id); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
                                >
                                  Remove
                                </button>
                              </>
                            }
                          >
                            <div ref={(el) => { panelRefs.current[panel.id] = el; }} className="h-full">
                              {renderArtifact(panel)}
                            </div>
                          </DraggablePanel>
                        );
                      })}

                      {/* Selection box for drag-to-select */}
                      {isSelectingBox && selectionBoxStart && selectionBoxEnd && (
                        <SelectionBox start={selectionBoxStart} end={selectionBoxEnd} />
                      )}

                      {/* Contextual Chat Popover for Panels */}
                      {contextualChatPanelId && panelLayouts[contextualChatPanelId] && !minimizedPanels.has(contextualChatPanelId) && (() => {
                        const panel = uiState.panels.find(p => p.id === contextualChatPanelId);
                        if (!panel) return null;
                        return (
                          <ContextualChatPopover
                            isOpen={true}
                            onClose={() => setContextualChatPanelId(null)}
                            anchorLayout={panelLayouts[contextualChatPanelId]}
                            panelTitle={getPanelTitle(panel)}
                            panelType={panel.type}
                            scale={zoomLevel}
                            viewportOffset={{ x: currentViewport.current.x, y: currentViewport.current.y }}
                            viewportSize={canvasViewport}
                            onSendMessage={handleContextualMessage}
                            isLoading={!!contextualChatLoading[contextualChatPanelId]}
                            messages={contextualChatMessages[contextualChatPanelId] || []}
                            statusLabel={contextualChatStatus[contextualChatPanelId] || null}
                          />
                        );
                      })()}

                      {/* Contextual Chat Popover for Groups */}
                      {contextualChatGroupId && (() => {
                        const group = groups.find(g => g.id === contextualChatGroupId);
                        if (!group) return null;
                        // Calculate group label position (top-left of group + offset)
                        const groupLayouts = group.panelIds
                          .filter(pid => visiblePanelIds.has(pid))
                          .map(pid => panelLayouts[pid])
                          .filter(Boolean);
                        if (groupLayouts.length === 0) return null;
                        let minX = Infinity, minY = Infinity;
                        for (const layout of groupLayouts) {
                          minX = Math.min(minX, layout.x);
                          minY = Math.min(minY, layout.y);
                        }
                        // Position popover near the group label (small anchor at top-left)
                        const labelAnchor = { x: minX, y: minY - 20, width: 100, height: 30 };
                        return (
                          <ContextualChatPopover
                            isOpen={true}
                            onClose={() => setContextualChatGroupId(null)}
                            anchorLayout={labelAnchor}
                            panelTitle={group.name || `${groupLayouts.length} panels`}
                            panelType="group"
                            scale={zoomLevel}
                            viewportOffset={{ x: currentViewport.current.x, y: currentViewport.current.y }}
                            viewportSize={canvasViewport}
                            onSendMessage={handleGroupContextualMessage}
                            isLoading={!!contextualChatLoading[contextualChatGroupId]}
                            messages={contextualChatMessages[contextualChatGroupId] || []}
                            statusLabel={contextualChatStatus[contextualChatGroupId] || null}
                          />
                        );
                      })()}

                      {/* Selection Toolbar - Figma-style floating toolbar */}
                      {showToolbar && (
                        <SelectionToolbar
                          selectedPanelId={toolbarPanel?.id ?? null}
                          selectedGroupId={toolbarGroup?.id ?? null}
                          selectedPanelIds={toolbarPanelIds}
                          panelTitle={toolbarPanel ? getPanelTitle(toolbarPanel) : undefined}
                          groupName={toolbarGroup?.name}
                          selectionBounds={toolbarBounds}
                          canvasScale={zoomLevel}
                          viewportOffset={{ x: currentViewport.current.x, y: currentViewport.current.y }}
                          viewportSize={canvasViewport}
                          onChat={() => {
                            if (selectedPanelIds.size > 0) {
                              if (singleSelectedPanel) {
                                setContextualChatGroupId(null);
                                setContextualChatPanelId(singleSelectedPanel.id);
                              } else if (selectedPanelsGroup) {
                                // Chat about the group
                                setContextualChatPanelId(null);
                                setContextualChatGroupId(selectedPanelsGroup.id);
                              } else if (selectedPanelIds.size > 1) {
                                // Auto-create a group and open chat for it
                                createGroup({ openChat: true });
                              }
                              return;
                            }
                            setContextualChatGroupId(null);
                            setContextualChatPanelId(toolbarPanel?.id ?? null);
                          }}
                          onDownload={toolbarPanel ? (format) => {
                            if (format === 'png') {
                              downloadPanelAsPng(toolbarPanel.id, getPanelTitle(toolbarPanel));
                            } else {
                              downloadPanel(toolbarPanel, format);
                            }
                          } : undefined}
                          onMinimize={() => {
                            if (toolbarPanel) {
                              minimizePanel(toolbarPanel.id, { clearSelection: selectedPanelIds.size > 0 });
                            }
                          }}
                          onRemove={() => {
                            if (selectedPanelIds.size > 0) {
                              if (singleSelectedPanel) {
                                removePanel(singleSelectedPanel.id);
                                setSelectedPanelIds(new Set());
                              } else if (selectedPanelIds.size > 1) {
                                selectedPanelIds.forEach(id => removePanel(id));
                                setSelectedPanelIds(new Set());
                              }
                              return;
                            }
                            if (toolbarPanel) {
                              removePanel(toolbarPanel.id);
                            }
                          }}
                          onGroup={selectedPanelIds.size >= 2 && !selectedPanelsGroup ? createGroup : undefined}
                          onUngroup={selectedPanelsGroup ? ungroupPanels : undefined}
                          onRemoveFromGroup={toolbarSinglePanelGroup && selectedPanelIds.size <= 1 ? () => {
                            if (toolbarPanel) {
                              removeFromGroup(toolbarPanel.id);
                              setSelectedPanelIds(new Set());
                            }
                          } : undefined}
                          isInGroup={!!toolbarSinglePanelGroup}
                          canDownload={!!toolbarPanel && (toolbarPanel.type === 'table' || toolbarPanel.type === 'chart')}
                          downloadFormats={
                            toolbarPanel?.type === 'table' ? ['csv', 'json'] :
                            toolbarPanel?.type === 'chart' ? ['png'] :
                            []
                          }
                          onAlign={selectedPanelIds.size > 0 ? alignSelected : undefined}
                          onDistribute={selectedPanelIds.size > 0 ? distributeSelected : undefined}
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
                      )}
                    </div>
                  </TransformComponent>
                </>
                );
              }}
            </TransformWrapper>
          {visiblePanels.length === 0 && (
            <div className="canvas-empty absolute inset-0 pointer-events-none">
              <svg className="canvas-empty-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              {artifactPanels.length === 0 ? (
                <>
                  <h3>Your canvas is empty</h3>
                  <p>Chat with the agent to create tables, charts, and other artifacts. They&rsquo;ll appear here as draggable cards.</p>
                </>
              ) : (
                <>
                  <h3>All panels are minimized</h3>
                  <p>Restore panels from the dock below to continue working on the canvas.</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Floating Chat Panel */}
        <div
          className={`fixed top-[73px] right-0 bottom-0 w-full md:w-[400px] chat-panel flex flex-col transition-transform duration-300 ${chatOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <ChatPanel
            messages={messages}
            input={input}
            isLoading={isLoading}
            statusLabel={streamStatus}
            messagesEndRef={messagesEndRef}
            textareaRef={textareaRef}
            onInputChange={handleTextareaChange}
            onSubmit={handleSubmit}
            onStop={stopQuery}
            onKeyDown={handleKeyDown}
            workspaceId={workspaceId}
            uploadedFiles={uploadedFiles}
            setUploadedFiles={setUploadedFiles}
          />
        </div>

        {/* Chat toggle button (when closed) */}
        {!chatOpen && (
          <button
            onClick={() => setChatOpen(true)}
            className="chat-toggle"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </button>
        )}
      </div>

      {/* Maximized Panel Overlay */}
      {maximizedPanelId && (() => {
        const panel = artifactPanels.find(p => p.id === maximizedPanelId);
        if (!panel) return null;
        return (
          <div className="fixed inset-0 bg-background/95 backdrop-blur-sm z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-medium">{getPanelTitle(panel)}</h2>
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded">{panel.type}</span>
              </div>
              <button
                onClick={() => setMaximizedPanelId(null)}
                className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Close fullscreen (Esc)"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto p-6">
              <div className="h-full bg-card rounded-xl border border-border p-4">
                {renderArtifact(panel)}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Publish Modal */}
      {publishModalOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => !isPublishing && setPublishModalOpen(false)}
        >
          <div className="bg-card rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Publish to Gallery</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Title</label>
                <input
                  type="text"
                  value={publishTitle}
                  onChange={(e) => setPublishTitle(e.target.value)}
                  placeholder="Give your workspace a name..."
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:border-primary/50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Description</label>
                <textarea
                  value={publishDescription}
                  onChange={(e) => setPublishDescription(e.target.value)}
                  placeholder="Describe what this workspace does..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:border-primary/50 resize-none"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                This will share your {artifactPanels.length} artifact{artifactPanels.length !== 1 ? 's' : ''} (tables, charts, files) to the public gallery.
              </p>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setPublishModalOpen(false)}
                className="px-4 py-2 text-sm rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                disabled={isPublishing}
              >
                Cancel
              </button>
              <button
                onClick={handlePublish}
                disabled={isPublishing || !publishTitle.trim() || !publishDescription.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {isPublishing ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tourOpen && (
        <OnboardingTour
          steps={tourSteps}
          isOpen={tourOpen}
          onClose={handleTourClose}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Artifact Content Components
// ═══════════════════════════════════════════════════════════════════════════

function TableContent({ table }: { table: TableData | null }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedData = useMemo(() => {
    const data = table?.data ?? [];
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];

      // Handle nulls
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortDir === 'asc' ? 1 : -1;
      if (bVal == null) return sortDir === 'asc' ? -1 : 1;

      // Number comparison
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }

      // String comparison
      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      if (aStr < bStr) return sortDir === 'asc' ? -1 : 1;
      if (aStr > bStr) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [table, sortKey, sortDir]);

  if (!table || table.data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No data
      </div>
    );
  }

  const renderCell = (col: TableData['columns'][0], value: unknown) => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-muted-foreground">—</span>;
    }

    // Handle URL type columns - render as clickable links
    if (col.type === 'url' && typeof value === 'string' && value) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {col.linkText || 'View'}
        </a>
      );
    }

    return String(value);
  };

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {table.columns.map((col, idx) => (
              <th
                key={`${col.key}-${idx}`}
                className="px-3 py-2 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide cursor-pointer hover:text-foreground transition-colors select-none"
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key && (
                    <span className="text-foreground">
                      {sortDir === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {sortedData.map((row, i) => (
            <tr key={i} className="hover:bg-muted/30 transition-colors">
              {table.columns.map((col, idx) => (
                <td key={`${col.key}-${idx}`} className="px-3 py-2 text-sm">
                  {renderCell(col, row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartContent({ chart }: { chart: ChartData | null }) {
  if (!chart) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No chart data
      </div>
    );
  }

  const xKey = chart.config.xKey || chart.config.labelKey || 'label';
  const yKey = chart.config.yKey || chart.config.valueKey || 'value';
  // Use hex colors for Recharts SVG compatibility
  const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];

  // Sanitize data: remove React-specific props that break SVG rendering
  const RESERVED_PROPS = ['style', 'className', 'key', 'ref', 'children'];
  const sanitizedData = chart.data.map(item => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      if (!RESERVED_PROPS.includes(k)) {
        clean[k] = v;
      }
    }
    return clean;
  });

  const chartConfig = {
    [yKey]: {
      label: yKey.charAt(0).toUpperCase() + yKey.slice(1),
      color: COLORS[0],
    },
  };

  return (
    <div className="h-full w-full bg-card rounded-lg">
      <ChartContainer config={chartConfig} className="h-full w-full">
        {chart.type === 'bar' ? (
          <BarChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey={yKey} fill={COLORS[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : chart.type === 'line' ? (
          <LineChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey={yKey} stroke={COLORS[0]} strokeWidth={2} dot={{ fill: COLORS[0] }} />
          </LineChart>
        ) : chart.type === 'area' ? (
          <AreaChart data={sanitizedData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey={yKey} stroke={COLORS[1]} strokeWidth={2} fill={`${COLORS[1]}80`} />
          </AreaChart>
        ) : chart.type === 'pie' ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={sanitizedData} dataKey={yKey} nameKey={xKey} cx="50%" cy="50%" outerRadius="70%" label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`} labelLine={false}>
              {sanitizedData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        ) : (
          <div className="text-muted-foreground">Unknown chart type</div>
        )}
      </ChartContainer>
    </div>
  );
}

function CardsContent({ cards }: { cards: CardsData | null }) {
  if (!cards || cards.items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No items
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 overflow-auto h-full">
      {cards.items.map((item, i) => (
        <div key={item.id || i} className="rounded-lg border border-border bg-card/50 p-3 hover:border-primary/50 transition-colors">
          {item.badge && (
            <span className="inline-block text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full mb-2">
              {item.badge}
            </span>
          )}
          <h4 className="font-medium text-sm line-clamp-2">{item.title}</h4>
          {item.subtitle && <p className="text-xs text-muted-foreground mt-1">{item.subtitle}</p>}
          {item.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.description}</p>}
        </div>
      ))}
    </div>
  );
}

function MarkdownContent({ content }: { content?: string }) {
  if (!content) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No content
      </div>
    );
  }

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold overflow-auto h-full">
      <SafeMarkdown>{content}</SafeMarkdown>
    </div>
  );
}

function PreviewContent({ content }: { content?: string }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!content) return;

    // Upload content to preview API and get a URL
    // This gives the iframe a real origin with proper CORS/COEP headers
    const uploadPreview = async () => {
      try {
        const res = await apiFetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        if (res.ok) {
          const { key } = await res.json();
          setPreviewUrl(`${basePath}/api/preview?key=${key}`);
        }
      } catch (e) {
        console.error('Failed to upload preview:', e);
      }
    };
    uploadPreview();
  }, [content]);

  if (!content || !previewUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {content ? 'Loading preview...' : 'No preview'}
      </div>
    );
  }

  return (
    <iframe
      src={previewUrl}
      className="w-full h-full border-0 rounded"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
    />
  );
}

function PDFContent({ workspaceId, filePath }: { workspaceId: string; filePath?: string }) {
  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No PDF file specified
      </div>
    );
  }

  // Build URL to the file serving endpoint
  const pdfUrl = `${basePath}/api/workspaces/${workspaceId}/files/${encodeURIComponent(filePath)}`;

  return (
    <iframe
      src={pdfUrl}
      className="w-full h-full border-0 rounded bg-white"
      title={filePath}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Chat Components
// ═══════════════════════════════════════════════════════════════════════════

// Tool icons by type
const ToolIcon = ({ name, className }: { name: string; className?: string }) => {
  const cleanName = name.replace(/^mcp__[^_]+__/, '');

  switch (cleanName) {
    case 'execute':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
        </svg>
      );
    case 'Bash':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
        </svg>
      );
    case 'read':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
      );
    case 'write':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
        </svg>
      );
    case 'WebFetch':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
        </svg>
      );
    case 'WebSearch':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
      );
    default:
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l5.653-4.655m8.254-4.665L21 6.93c.466-.47.883-1.034.83-1.713-.052-.68-.483-1.26-1.067-1.67a12.52 12.52 0 0 0-3.24-1.584c-.662-.19-1.29-.156-1.76.173L14.25 3.15" />
        </svg>
      );
  }
};

// Tool labels by type
const getToolLabel = (name: string) => {
  const cleanName = name.replace(/^mcp__[^_]+__/, '');
  const labels: Record<string, string> = {
    execute: 'Running code',
    Bash: 'Running command',
    read: 'Reading data',
    write: 'Writing data',
    WebFetch: 'Fetching web',
    WebSearch: 'Searching web',
  };
  return labels[cleanName] || cleanName.replace(/_/g, ' ');
};

function ToolCard({ tool }: { tool: ToolExecution }) {
  const [expanded, setExpanded] = useState(false);
  const cleanName = tool.name.replace(/^mcp__[^_]+__/, '');

  const getStatusStyles = () => {
    switch (tool.status) {
      case 'running':
        return 'border-blue-500/50 bg-blue-500/5 before:bg-blue-500 before:animate-pulse';
      case 'success':
        return 'border-border bg-card before:bg-green-500';
      case 'error':
        return 'border-red-500/50 bg-red-500/5 before:bg-red-500';
    }
  };

  const getToolTarget = () => {
    const input = tool.input as Record<string, unknown>;

    switch (cleanName) {
      case 'execute':
        if (input?.code) {
          const code = input.code as string;
          const firstLine = code.split('\n')[0].slice(0, 30);
          return firstLine + (code.length > 30 ? '...' : '');
        }
        return null;
      case 'Bash':
        if (input?.command) {
          const cmd = input.command as string;
          return cmd.slice(0, 40) + (cmd.length > 40 ? '...' : '');
        }
        return null;
      case 'read':
        return input?.from as string || null;
      case 'write':
        return input?.to as string || null;
      case 'WebFetch':
        if (input?.url) {
          try {
            const url = new URL(input.url as string);
            return url.hostname;
          } catch {
            return (input.url as string).slice(0, 25);
          }
        }
        return null;
      case 'WebSearch':
        if (input?.query) {
          const q = input.query as string;
          return q.length > 25 ? q.slice(0, 25) + '...' : q;
        }
        return null;
      default:
        if (input?.query) return (input.query as string).slice(0, 25) + '...';
        if (input?.from) return input.from as string;
        if (input?.url) return input.url as string;
        return null;
    }
  };

  const target = getToolTarget();

  return (
    <button
      type="button"
      className={`relative text-left border rounded-lg px-3 py-2 cursor-pointer transition-all flex-shrink-0 overflow-hidden
        before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] before:rounded-l
        ${getStatusStyles()} ${expanded ? 'w-full' : 'max-w-[280px]'}`}
      onClick={() => tool.output && setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-5 h-5 rounded bg-muted/50 flex-shrink-0">
          <ToolIcon name={tool.name} className="w-3.5 h-3.5" />
        </div>
        <span className="text-xs font-medium whitespace-nowrap">{getToolLabel(tool.name)}</span>
        {target && (
          <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[100px]">{target}</span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {tool.status === 'running' && tool.elapsedTime !== undefined && (
            <span className="text-[11px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded animate-pulse">
              {tool.elapsedTime.toFixed(1)}s
            </span>
          )}
          {tool.status === 'running' && (
            <svg className="w-3.5 h-3.5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          )}
          {tool.status === 'success' && (
            <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          {tool.status === 'error' && (
            <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
          {tool.output && (
            <svg className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
        </div>
      </div>
      {expanded && tool.output && (
        <div className="mt-2 pt-2 border-t border-border/50 text-xs animate-in slide-in-from-top-1">
          <pre className="whitespace-pre-wrap text-muted-foreground max-h-[150px] overflow-auto font-mono text-[11px]">
            {tool.output.slice(0, 800)}{tool.output.length > 800 ? '...' : ''}
          </pre>
        </div>
      )}
    </button>
  );
}

function ChatPanel({ messages, input, isLoading, statusLabel, messagesEndRef, textareaRef, onInputChange, onSubmit, onStop, onKeyDown, workspaceId, uploadedFiles, setUploadedFiles }: {
  messages: Message[];
  input: string;
  isLoading: boolean;
  statusLabel?: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => Promise<void>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  workspaceId: string;
  uploadedFiles: { name: string; path: string }[];
  setUploadedFiles: React.Dispatch<React.SetStateAction<{ name: string; path: string }[]>>;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach(file => formData.append('files', file));

    try {
      const res = await fetch(`${basePath}/api/workspaces/${workspaceId}/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('Upload failed:', res.status, errorData);
        alert(errorData.error || 'Upload failed');
        return;
      }
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        setUploadedFiles(prev => [...prev, ...data.files]);
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileUpload(e.dataTransfer.files);
  };

  return (
    <div
      className="flex flex-col h-full relative"
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
    >
      {/* Drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary z-50 flex items-center justify-center">
          <div className="text-center">
            <svg className="w-10 h-10 text-primary mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <p className="text-sm font-medium text-primary">Drop files here</p>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-muted mb-3">
                <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                </svg>
              </div>
              <p className="text-sm text-muted-foreground">Start a conversation</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Ask the agent to create tables, charts, and more.</p>
            </div>
          )}
          {messages.map((message, i) => (
            <div key={message.id ?? i} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {message.role === 'user' ? (
                <div className="max-w-[90%] rounded-2xl px-4 py-2.5 bg-primary text-primary-foreground rounded-br-sm">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                </div>
              ) : (
                <div className="max-w-[90%] space-y-2">
                  {message.blocks && message.blocks.length > 0 ? (
                    message.blocks.map((block, j) => (
                      block.type === 'text' && block.text ? (
                        <div key={j} className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                          <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0 max-w-none">
                            <SafeMarkdown>{block.text}</SafeMarkdown>
                          </div>
                        </div>
                      ) : block.type === 'tools' && block.tools ? (
                        <div key={j} className="flex flex-wrap gap-1.5">
                          {block.tools.map((tool) => (
                            <ToolCard key={tool.id} tool={tool} />
                          ))}
                        </div>
                      ) : null
                    ))
                  ) : message.content ? (
                    <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5">
                      <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0 max-w-none">
                        <SafeMarkdown>{message.content}</SafeMarkdown>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
          {(() => {
            if (!isLoading) return null;
            const lastAssistant = [...messages].reverse().find((msg) => msg.role === 'assistant');
            const hasRunningTools = !!lastAssistant?.blocks?.some(
              (block) => block.type === 'tools' && block.tools?.some((tool) => tool.status === 'running')
            );
            const inferredLabel = hasRunningTools ? 'Running tools...' : 'Thinking...';
            const activeLabel = statusLabel && statusLabel.trim() ? statusLabel : inferredLabel;
            return (
              <div className="flex justify-start">
                <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>{activeLabel}</span>
                  </div>
                </div>
              </div>
            );
          })()}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border/50 p-4">
        {uploadedFiles.length > 0 && (
          <div className="mb-3">
            <div className="flex flex-wrap gap-1.5">
              {uploadedFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-muted rounded-lg px-2 py-1 text-xs">
                  <svg className="w-3 h-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  <span className="truncate max-w-[100px]">{file.name}</span>
                  <button type="button" onClick={() => setUploadedFiles(prev => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={onSubmit}>
          <div className="relative flex items-end gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-primary/50 transition-colors" data-tour="chat-input">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleFileUpload(e.target.files)} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex-shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Upload files"
              data-tour="upload-button"
            >
              {isUploading ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                </svg>
              )}
            </button>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              placeholder="Message..."
              disabled={isLoading}
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed focus:outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
            />
            {isLoading ? (
              <button
                type="button"
                onClick={onStop}
                className="flex-shrink-0 p-1.5 rounded-lg bg-red-500 text-white transition-opacity hover:opacity-90"
                title="Stop"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex-shrink-0 p-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-center text-muted-foreground/70">
            Enter to send · Shift+Enter for new line
          </p>
        </form>
      </div>
    </div>
  );
}
