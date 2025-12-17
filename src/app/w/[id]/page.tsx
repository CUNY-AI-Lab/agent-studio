'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { DraggablePanel } from '@/components/canvas/DraggablePanel';
import {
  Bar, BarChart, Line, LineChart, Pie, PieChart, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Cell, ResponsiveContainer
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { SafeMarkdown } from '@/components/SafeMarkdown';
import { toPng } from 'html-to-image';
import { useTheme } from '@/components/ThemeProvider';
import { apiFetch, basePath } from '@/lib/api';
import { useStreamingQuery, type Message, type ToolExecution, type ContentBlock, type PanelUpdate } from '@/hooks/useStreamingQuery';
import { CapabilitiesPanel } from '@/components/CapabilitiesPanel';
import skills from '@/lib/skills/index.json';

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

interface PanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  groupId?: string;
}

interface UIPanel {
  id: string;
  type: 'chat' | 'table' | 'preview' | 'fileTree' | 'detail' | 'chart' | 'cards' | 'markdown';
  title?: string;
  layout?: PanelLayout;
  tableId?: string;
  chartId?: string;
  cardsId?: string;
  linkedTo?: string;
  content?: string;
}

interface UIState {
  panels: UIPanel[];
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
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
  const [chatOpen, setChatOpen] = useState(true);
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

  // Canvas state
  const [panelLayouts, setPanelLayouts] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewportLoaded, setViewportLoaded] = useState(false);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const viewportSaveTimeout = useRef<NodeJS.Timeout | null>(null);
  const currentViewport = useRef<{ x: number; y: number; scale: number }>({ x: -3100, y: -3400, scale: 1 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingQueryProcessed = useRef(false);
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Load workspace callback (forward declared for hook)
  const loadWorkspaceRef = useRef<((options?: { skipMessages?: boolean }) => Promise<void>) | undefined>(undefined);

  // Handle panel updates from streaming
  const handlePanelUpdates = useCallback((updates: PanelUpdate[]) => {
    for (const update of updates) {
      const { action, panel, data } = update;
      // Cast panel to UIPanel since we know server sends valid types
      const typedPanel = panel as unknown as UIPanel;

      if (action === 'add') {
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
      } else if (action === 'remove') {
        // Remove panel from UI state
        setUIState(prev => ({
          ...prev,
          panels: prev.panels.filter(p => p.id !== typedPanel.id)
        }));
      }
    }
  }, []);

  // Streaming query hook
  const { executeQuery, stopQuery, isLoadingRef } = useStreamingQuery({
    workspaceId,
    onMessagesUpdate: setMessages,
    onComplete: async () => {
      if (loadWorkspaceRef.current) {
        await loadWorkspaceRef.current({ skipMessages: true });
      }
    },
    onPanelUpdate: handlePanelUpdates,
  });

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

  // Close publish modal on Escape
  useEffect(() => {
    if (!publishModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPublishModalOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [publishModalOpen]);

  // Get artifact panels (everything except chat)
  const artifactPanels = useMemo(() =>
    uiState.panels.filter(p => p.type !== 'chat'),
    [uiState.panels]
  );

  // Initialize panel layouts when panels change
  // New panels appear in the center of the current viewport
  useEffect(() => {
    const gap = 40;

    // Calculate viewport center in canvas coordinates
    const vp = currentViewport.current;
    const container = canvasContainerRef.current;
    const viewportWidth = container?.clientWidth || 1200;
    const viewportHeight = container?.clientHeight || 700;
    const startX = Math.round((-vp.x + viewportWidth / 2) / vp.scale - 250); // offset to center panel
    const startY = Math.round((-vp.y + viewportHeight / 2) / vp.scale - 200);

    setPanelLayouts(prev => {
      const newLayouts = { ...prev };
      const occupiedRects: { x: number; y: number; width: number; height: number }[] = [];

      // Collect existing layouts
      Object.values(newLayouts).forEach(layout => occupiedRects.push(layout));

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
      for (const panel of artifactPanels) {
        if (!newLayouts[panel.id]) {
          const defaultSize = DEFAULT_PANEL_SIZES[panel.type] || { width: 500, height: 400 };
          const width = panel.layout?.width ?? defaultSize.width;
          const height = panel.layout?.height ?? defaultSize.height;

          let x: number, y: number;
          if (panel.layout?.x !== undefined && panel.layout?.y !== undefined) {
            x = panel.layout.x;
            y = panel.layout.y;
          } else {
            const pos = findPosition(width, height);
            x = pos.x;
            y = pos.y;
          }

          newLayouts[panel.id] = { x, y, width, height };
          occupiedRects.push(newLayouts[panel.id]);
        }
      }

      // Remove layouts for deleted panels
      const panelIds = new Set(artifactPanels.map(p => p.id));
      Object.keys(newLayouts).forEach(id => {
        if (!panelIds.has(id)) delete newLayouts[id];
      });

      return newLayouts;
    });
  }, [artifactPanels]);

  // Handle panel layout change (during drag/resize)
  const handleLayoutChange = useCallback((id: string, layout: Partial<{ x: number; y: number; width: number; height: number }>) => {
    setPanelLayouts(prev => ({
      ...prev,
      [id]: { ...prev[id], ...layout },
    }));
  }, []);

  // Resolve collisions and save layout after drag ends
  const handleDragEnd = useCallback((movedPanelId: string) => {
    setPanelLayouts(prev => {
      // Deep copy so we can mutate positions directly
      const layouts: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const [id, layout] of Object.entries(prev)) {
        layouts[id] = { ...layout };
      }

      const gap = 20;
      const maxIterations = 15;
      const panelIds = Object.keys(layouts);

      // Helper to check if two rectangles overlap (with gap)
      const rectsOverlap = (a: typeof layouts[string], b: typeof layouts[string]) => {
        return !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x ||
                 a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
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
            hadCollision = true;

            // Determine which panel moves: the moved panel stays put
            // If neither is the moved panel, move the one lower/righter
            let toMoveId: string;
            let stayId: string;
            if (idA === movedPanelId) {
              toMoveId = idB;
              stayId = idA;
            } else if (idB === movedPanelId) {
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
            let pushRight = 0, pushLeft = 0, pushDown = 0, pushUp = 0;

            // How much to push right so move's left edge clears stay's right edge
            pushRight = (stay.x + stay.width + gap) - move.x;
            // How much to push left so move's right edge clears stay's left edge
            pushLeft = (move.x + move.width + gap) - stay.x;
            // How much to push down so move's top edge clears stay's bottom edge
            pushDown = (stay.y + stay.height + gap) - move.y;
            // How much to push up so move's bottom edge clears stay's top edge
            pushUp = (move.y + move.height + gap) - stay.y;

            // Choose minimum push in the natural direction (away from stay's center)
            const pushX = moveCx >= stayCx ? pushRight : pushLeft;
            const pushY = moveCy >= stayCy ? pushDown : pushUp;

            // Push in the direction requiring minimum movement
            if (pushX > 0 && pushX <= pushY) {
              const dx = moveCx >= stayCx ? pushRight : -pushLeft;
              layouts[toMoveId] = {
                ...move,
                x: Math.max(0, move.x + dx),
              };
            } else if (pushY > 0) {
              const dy = moveCy >= stayCy ? pushDown : -pushUp;
              layouts[toMoveId] = {
                ...move,
                y: Math.max(0, move.y + dy),
              };
            }
          }
        }

        if (!hadCollision) break;
      }

      // Save to server
      apiFetch(`/api/workspaces/${workspaceId}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ panels: layouts }),
      }).catch(console.error);

      return layouts;
    });
  }, [workspaceId]);


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
    if (!options?.skipMessages && data.messages) setMessages(data.messages);
    if (data.uiState) {
      setUIState(data.uiState);
      setViewportLoaded(true);
    }
  }, [workspaceId]);

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
    setIsLoading(true);
    try {
      await executeQuery(userMessage);
    } finally {
      setIsLoading(false);
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      await executeQuery(userMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

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
      default:
        return <div className="text-muted-foreground text-sm">Unknown type: {panel.type}</div>;
    }
  };

  // Get panel title
  const getPanelTitle = (panel: UIPanel): string => {
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
  };

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

  const removePanel = async (panelId: string) => {
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/panels/${panelId}`, { method: 'DELETE' });
      // Clean up panel ref to avoid memory leak
      delete panelRefs.current[panelId];
      setUIState(prev => ({
        ...prev,
        panels: prev.panels.filter(p => p.id !== panelId)
      }));
    } catch (error) {
      console.error('Failed to remove panel:', error);
    }
  };

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
          className={`flex-1 canvas-bg overflow-hidden transition-all duration-300 ${chatOpen ? 'md:mr-[400px]' : ''}`}
        >
          {artifactPanels.length === 0 ? (
            <div className="canvas-empty">
              <svg className="canvas-empty-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <h3>Your canvas is empty</h3>
              <p>Chat with the agent to create tables, charts, and other artifacts. They'll appear here as draggable cards.</p>
            </div>
          ) : (
            <>
            <TransformWrapper
              initialScale={uiState.viewport?.zoom || 1}
              initialPositionX={uiState.viewport?.x ?? -3100}
              initialPositionY={uiState.viewport?.y ?? -3400}
              minScale={0.5}
              maxScale={2.5}
              wheel={{ step: 0.1, excluded: ['no-zoom-scroll'] }}
              panning={{ velocityDisabled: true }}
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
              {({ zoomIn, zoomOut, resetTransform }) => (
                <>
                  {/* Zoom Controls */}
                  <div className="fixed bottom-4 left-4 z-40 flex items-center gap-1 bg-card/90 backdrop-blur border border-border rounded-lg p-1 shadow-lg">
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

                  <TransformComponent
                    wrapperStyle={{ width: '100%', height: '100%' }}
                    contentStyle={{ width: '8000px', height: '8000px' }}
                  >
                    <div className="canvas-content relative" style={{ width: '8000px', height: '8000px' }}>
                      {artifactPanels.filter(p => !minimizedPanels.has(p.id)).map((panel) => {
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
                            onDragEnd={handleDragEnd}
                            onFocus={setFocusedPanelId}
                            onOpenMenu={setOpenMenuId}
                            isMenuOpen={openMenuId === panel.id}
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
                                <button
                                  onClick={() => { setMinimizedPanels(prev => new Set(prev).add(panel.id)); setOpenMenuId(null); }}
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
                    </div>
                  </TransformComponent>
                </>
              )}
            </TransformWrapper>
            </>
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
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Artifact Content Components
// ═══════════════════════════════════════════════════════════════════════════

function TableContent({ table }: { table: TableData | null }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  if (!table || table.data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No data
      </div>
    );
  }

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedData = useMemo(() => {
    if (!sortKey) return table.data;

    return [...table.data].sort((a, b) => {
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
  }, [table.data, sortKey, sortDir]);

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
  const COLORS = ['oklch(var(--chart-1))', 'oklch(var(--chart-2))', 'oklch(var(--chart-3))', 'oklch(var(--chart-4))', 'oklch(var(--chart-5))'];

  const chartConfig = {
    [yKey]: {
      label: yKey.charAt(0).toUpperCase() + yKey.slice(1),
      color: 'oklch(var(--chart-1))',
    },
  };

  return (
    <div className="h-full w-full bg-card rounded-lg">
      <ChartContainer config={chartConfig} className="h-full w-full">
        {chart.type === 'bar' ? (
          <BarChart data={chart.data} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey={yKey} fill="oklch(var(--chart-1))" radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : chart.type === 'line' ? (
          <LineChart data={chart.data} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey={yKey} stroke="oklch(var(--chart-1))" strokeWidth={2} dot={{ fill: 'oklch(var(--chart-1))' }} />
          </LineChart>
        ) : chart.type === 'area' ? (
          <AreaChart data={chart.data} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey={xKey} tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={50} className="fill-muted-foreground" />
            <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey={yKey} stroke="oklch(var(--chart-2))" strokeWidth={2} fill="oklch(var(--chart-2) / 0.5)" />
          </AreaChart>
        ) : chart.type === 'pie' ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={chart.data} dataKey={yKey} nameKey={xKey} cx="50%" cy="50%" outerRadius="70%" label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`} labelLine={false}>
              {chart.data.map((_, index) => (
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
    if (!content) {
      setPreviewUrl(null);
      return;
    }

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

function ChatPanel({ messages, input, isLoading, messagesEndRef, textareaRef, onInputChange, onSubmit, onStop, onKeyDown, workspaceId, uploadedFiles, setUploadedFiles }: {
  messages: Message[];
  input: string;
  isLoading: boolean;
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
            <div key={i} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
          {isLoading && (() => {
            const lastMsg = messages[messages.length - 1];
            const hasContent = lastMsg?.role === 'assistant' && (lastMsg.content || (lastMsg.blocks && lastMsg.blocks.length > 0));
            if (hasContent) return null;
            return (
              <div className="flex justify-start">
                <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Thinking...</span>
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
          <div className="relative flex items-end gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-primary/50 transition-colors">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleFileUpload(e.target.files)} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex-shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Upload files"
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
