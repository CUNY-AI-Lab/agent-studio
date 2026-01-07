'use client';

import { useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { parseSseEvents } from '@/lib/streaming/sse';

export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'success' | 'error';
  output?: string;
  startTime: number;
  elapsedTime?: number;
}

export interface ContentBlock {
  type: 'text' | 'tools';
  text?: string;
  tools?: ToolExecution[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  blocks?: ContentBlock[];
  id?: string;
}

export interface StreamStatusEvent {
  status: 'thinking' | 'tool_running' | 'responding' | 'complete';
  label?: string;
  toolName?: string;
}

// Panel update type matching runtime
export interface PanelUpdate {
  action: 'add' | 'update' | 'remove';
  panel: {
    id: string;
    type: string;
    title?: string;
    tableId?: string;
    chartId?: string;
    cardsId?: string;
    content?: string;
    layout?: { x?: number; y?: number; width?: number; height?: number };
  };
  data?: {
    table?: unknown;
    chart?: unknown;
    cards?: unknown;
    content?: string;
  };
}

export interface PanelUpdateContext {
  sourcePanelId?: string | null;
  sourceGroupId?: string | null;
}

interface UseStreamingQueryOptions {
  workspaceId: string;
  onMessagesUpdate: (updater: (prev: Message[]) => Message[]) => void;
  onComplete: () => Promise<void>;
  onPanelUpdate?: (updates: PanelUpdate[], context?: PanelUpdateContext) => void;
  onStatusUpdate?: (event: StreamStatusEvent) => void;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export function useStreamingQuery({
  workspaceId,
  onMessagesUpdate,
  onComplete,
  onPanelUpdate,
  onStatusUpdate,
}: UseStreamingQueryOptions) {
  const messageIdRef = useRef(0);
  const isLoadingRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track running tools separately from tool data - only used for timer and cancellation
  const runningToolIdsRef = useRef<Set<string>>(new Set());

  const makeMessageId = useCallback(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    messageIdRef.current += 1;
    return `msg-${Date.now()}-${messageIdRef.current}`;
  }, []);

  // Stop timer
  const stopToolTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopQuery = useCallback(async (): Promise<void> => {
    if (!isLoadingRef.current) return;

    try {
      await apiFetch(`/api/workspaces/${workspaceId}/query/abort`, {
        method: 'POST',
      });

      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current = null;
      }

      stopToolTimer();
    } catch (error) {
      console.error('Stop query error:', error);
    }
  }, [workspaceId, stopToolTimer]);

  const executeQuery = useCallback(async (
    prompt: string,
    options?: {
      skipMainChat?: boolean;
      onTextDelta?: (delta: string, fullText: string) => void;
      onStatusUpdate?: (event: StreamStatusEvent) => void;
      panelContext?: PanelUpdateContext;
    },
    retryCount = 0,
    // Preserve state across retries to prevent duplicate tools
    retryState?: {
      contentBlocks: ContentBlock[];
      processedToolIds: Set<string>;
      toolIdMap: Map<string, ToolExecution>;
    }
  ): Promise<string> => {
    const skipMainChat = options?.skipMainChat ?? false;
    const trackLoading = !skipMainChat;
    const statusHandler = options?.onStatusUpdate ?? (trackLoading ? onStatusUpdate : undefined);
    if (trackLoading && isLoadingRef.current && retryCount === 0) return '';
    if (trackLoading) {
      isLoadingRef.current = true;
    }

    // Content blocks - directly store tools here (like site-studio pattern)
    // On retry, reuse existing state to preserve deduplication
    const contentBlocks: ContentBlock[] = retryState?.contentBlocks ?? [];
    let currentSectionText = '';
    let currentToolsGroup: ToolExecution[] = [];
    const processedToolIds = retryState?.processedToolIds ?? new Set<string>(); // Deduplication
    const toolIdMap = retryState?.toolIdMap ?? new Map<string, ToolExecution>(); // O(1) lookup for tool results
    const runningToolIds = trackLoading ? runningToolIdsRef.current : new Set<string>();
    let lineBuffer = '';
    let completionTriggered = false;
    let streamErrorMessage: string | null = null;
    let terminalEvent: 'done' | 'aborted' | null = null;
    let receivedStreamEvents = false;

    const triggerComplete = () => {
      if (completionTriggered) return;
      completionTriggered = true;
      if (!trackLoading) return;
      void onComplete().catch((error) => {
        console.error('onComplete error:', error);
      });
    };

    // Only add placeholder on first attempt (skip for contextual chats)
    if (retryCount === 0 && !skipMainChat) {
      onMessagesUpdate((prev) => [
        ...prev,
        { id: makeMessageId(), role: 'assistant', content: '', blocks: [] },
      ]);
    }

    // Flush current text into blocks
    const flushText = () => {
      if (currentSectionText.trim()) {
        contentBlocks.push({ type: 'text', text: currentSectionText });
        currentSectionText = '';
      }
    };

    // Flush current tools group into blocks
    const flushTools = () => {
      if (currentToolsGroup.length > 0) {
        contentBlocks.push({ type: 'tools', tools: [...currentToolsGroup] });
        currentToolsGroup = [];
      }
    };

    const flushToolsBeforeText = () => {
      if (currentToolsGroup.length > 0) {
        flushTools();
      }
    };

    const formatToolName = (name?: string) => {
      if (!name) return 'tool';
      const base = name.split('__').pop() || name;
      return base.replace(/_/g, ' ');
    };

    const setStatus = (status: StreamStatusEvent['status'], label?: string, toolName?: string) => {
      if (!statusHandler) return;
      statusHandler({ status, label, toolName });
    };

    const appendText = (text: string, options?: { fromStream?: boolean; onTextDelta?: (delta: string, fullText: string) => void }) => {
      if (!text) return;
      flushToolsBeforeText();
      currentSectionText += text;
      if (options?.fromStream) {
        receivedStreamEvents = true;
      }
      setStatus('responding', 'Responding...');
      if (options?.onTextDelta) {
        options.onTextDelta(text, buildFullText());
      }
      updateMessage();
    };

    const handleToolUse = (toolId?: string, toolName?: string, toolInput?: unknown) => {
      if (!toolId) return;
      const existingTool = toolIdMap.get(toolId);
      if (existingTool) {
        let updated = false;
        if (toolName && existingTool.name !== toolName) {
          existingTool.name = toolName;
          updated = true;
        }
        if (toolInput !== undefined && existingTool.input !== toolInput) {
          existingTool.input = toolInput;
          updated = true;
        }
        if (updated) {
          updateMessage();
        }
        return;
      }

      processedToolIds.add(toolId);
      flushText();
      receivedStreamEvents = false;

      const tool: ToolExecution = {
        id: toolId,
        name: toolName || 'tool',
        input: toolInput,
        status: 'running',
        startTime: Date.now(),
        elapsedTime: 0,
      };

      toolIdMap.set(toolId, tool);
      runningToolIds.add(toolId);
      currentToolsGroup.push(tool);

      setStatus('tool_running', `Using ${formatToolName(toolName)}...`, toolName);
      startToolTimer();
      updateMessage();
    };

    const handleToolResult = (toolId?: string, isError?: boolean, output?: string) => {
      if (!toolId) return;
      const tool = toolIdMap.get(toolId);
      if (tool) {
        tool.status = isError ? 'error' : 'success';
        tool.output = output;
        tool.elapsedTime = Math.round((Date.now() - tool.startTime) / 100) / 10;
      }

      runningToolIds.delete(toolId);
      if (runningToolIds.size === 0) {
        if (trackLoading) {
          stopToolTimer();
        }
        setStatus('thinking', 'Thinking...');
      }

      updateMessage();
    };

    const updateMessage = () => {
      // Skip main chat updates for contextual chats
      if (skipMainChat) return;

      // Build full text for content field
      const fullText = contentBlocks
        .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text' && !!b.text)
        .map(b => b.text)
        .join('') + currentSectionText;

      // Build blocks array including current pending text/tools
      const blocks: ContentBlock[] = [...contentBlocks];

      // Add pending tools group if any
      if (currentToolsGroup.length > 0) {
        // Check if last block is tools - if so, update it; otherwise add new
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === 'tools') {
          lastBlock.tools = [...currentToolsGroup];
        } else {
          blocks.push({ type: 'tools', tools: [...currentToolsGroup] });
        }
      }

      // Add pending text if any
      if (currentSectionText) {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === 'text') {
          lastBlock.text = currentSectionText;
        } else {
          blocks.push({ type: 'text', text: currentSectionText });
        }
      }

      onMessagesUpdate((prev) => {
        const updated = [...prev];
        const lastMessage = updated[updated.length - 1];
        updated[updated.length - 1] = {
          id: lastMessage?.id ?? makeMessageId(),
          role: 'assistant',
          content: fullText,
          blocks: blocks.length > 0 ? blocks : undefined
        };
        return updated;
      });
    };

    const buildFullText = () => (
      contentBlocks
        .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text' && !!b.text)
        .map(b => b.text)
        .join('') + currentSectionText
    );

    const appendErrorNote = (message: string) => {
      const note = `\n\n*[Error: ${message}]*`;
      if (currentSectionText.trim()) {
        currentSectionText += note;
        return;
      }

      for (let i = contentBlocks.length - 1; i >= 0; i -= 1) {
        const block = contentBlocks[i];
        if (block.type === 'text' && block.text) {
          block.text += note;
          return;
        }
      }

      currentSectionText = `*[Error: ${message}]*`;
    };

    // Start timer for elapsed time updates
    const startToolTimer = () => {
      if (!trackLoading) return;
      if (timerRef.current) return;
      timerRef.current = setInterval(() => {
        const now = Date.now();
        let hasUpdates = false;

        for (const tool of toolIdMap.values()) {
          if (tool.status === 'running') {
            tool.elapsedTime = Math.round((now - tool.startTime) / 100) / 10;
            hasUpdates = true;
          }
        }

        if (hasUpdates) {
          updateMessage();
        } else {
          // No running tools, stop timer
          stopToolTimer();
        }
      }, 100);
    };

    try {
      const response = await apiFetch(`/api/workspaces/${workspaceId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, skipConversation: skipMainChat }),
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader');
      if (trackLoading) {
        readerRef.current = reader;
      }

      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const { events, rest } = parseSseEvents(lineBuffer, chunk);
          lineBuffer = rest;
          let shouldStop = false;
          for (const event of events) {
            if (!event || typeof event !== 'object') continue;
            const typedEvent = event as {
              type?: string;
              event?: {
                type?: string;
                delta?: { type?: string; text?: string };
                content_block?: { type?: string; id?: string; name?: string; input?: unknown; text?: string };
              };
              message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
              panelUpdates?: PanelUpdate[];
              error?: string;
            };

            // Process the parsed event
            if (typedEvent.type === 'stream_event' && typedEvent.event) {
              const streamEvent = typedEvent.event;
              if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
                appendText(streamEvent.delta.text || '', { fromStream: true });
              } else if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'text') {
                appendText(streamEvent.content_block.text || '', { fromStream: true });
              } else if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
                handleToolUse(
                  streamEvent.content_block.id,
                  streamEvent.content_block.name,
                  streamEvent.content_block.input
                );
              }
            } else if (typedEvent.type === 'tool_approval_request') {
              setStatus('thinking', 'Waiting for approval...');
            } else if (typedEvent.type === 'assistant' && typedEvent.message?.content) {
              const skipText = receivedStreamEvents;
              for (const block of typedEvent.message.content) {
                if (block.type === 'tool_use') {
                  handleToolUse(block.id, block.name, block.input);
                } else if (!skipText && block.type === 'text' && typeof block.text === 'string') {
                  appendText(block.text);
                }
              }
            } else if (typedEvent.type === 'user' && typedEvent.message?.content) {
              for (const block of typedEvent.message.content) {
                if (block.type === 'tool_result') {
                  const output = Array.isArray(block.content)
                    ? block.content
                        .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
                        .map((c: { type: 'text'; text: string }) => c.text)
                        .join('\n')
                    : block.content;
                  handleToolResult(block.tool_use_id, block.is_error, typeof output === 'string' ? output : '');
                }
              }
            } else if (typedEvent.type === 'panel_update') {
              // Handle panel updates from server
              if (onPanelUpdate && typedEvent.panelUpdates) {
                onPanelUpdate(typedEvent.panelUpdates, options?.panelContext);
              }
            } else if (typedEvent.type === 'error') {
              streamErrorMessage = typedEvent.error || 'Something went wrong. Please try again.';
              shouldStop = true;
              break;
            } else if (typedEvent.type === 'done' || typedEvent.type === 'aborted') {
              terminalEvent = typedEvent.type;
              if (trackLoading) {
                stopToolTimer();
                readerRef.current = null;
              }

              // Final update to ensure everything is captured
              flushText();
              flushTools();
              updateMessage();

              if (statusHandler) {
                statusHandler({ status: 'complete' });
              }
              triggerComplete();
              shouldStop = true;
              break;
            }
          }

          if (shouldStop) {
            void reader.cancel();
            break;
          }
        }

        if (streamErrorMessage) {
          appendErrorNote(streamErrorMessage);

          if (trackLoading) {
            stopToolTimer();
            readerRef.current = null;
          }

          flushText();
          flushTools();
          updateMessage();
          triggerComplete();

          return buildFullText();
        }

        if (terminalEvent) {
          return buildFullText();
        }

        // Stream ended - final flush
        flushText();
        flushTools();
        updateMessage();

        // Return the final text content
        const finalText = contentBlocks
          .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text' && !!b.text)
          .map(b => b.text)
          .join('');
        return finalText;

      } finally {
        if (trackLoading) {
          stopToolTimer();
        }
      }
    } catch (error: unknown) {
      console.error('Query error:', error);

      // Check for network/connection errors that are worth retrying
      const isNetworkError = (() => {
        if (error instanceof TypeError) {
          // Common fetch() errors
          const msg = error.message?.toLowerCase() || '';
          return msg.includes('network') || msg.includes('fetch') || msg.includes('failed');
        }
        if (error instanceof DOMException) {
          // AbortError from signal abort, NetworkError from connection issues
          return error.name === 'AbortError' || error.name === 'NetworkError';
        }
        // Check for generic Error with network-related messages
        if (error instanceof Error) {
          const msg = error.message?.toLowerCase() || '';
          return msg.includes('network') || msg.includes('connection') || msg.includes('timeout');
        }
        return false;
      })();

      if (isNetworkError && retryCount < MAX_RETRIES) {
        console.log(`Network error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Preserve state across retries to prevent duplicate tools
        return executeQuery(prompt, options, retryCount + 1, {
          contentBlocks,
          processedToolIds,
          toolIdMap,
        });
      }

      // Show error message
      const errorMessage = isNetworkError
        ? 'Connection lost. Please check your network and try again.'
        : 'Something went wrong. Please try again.';

      if (!skipMainChat) {
        onMessagesUpdate((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && !prev[prev.length - 1].content) {
            const updated = [...prev];
            const lastMessage = updated[updated.length - 1];
            updated[updated.length - 1] = {
              id: lastMessage?.id ?? makeMessageId(),
              role: 'assistant',
              content: errorMessage,
            };
            return updated;
          }
          return [...prev, { id: makeMessageId(), role: 'assistant', content: errorMessage }];
        });
      }
      return errorMessage;
    } finally {
      if (trackLoading) {
        isLoadingRef.current = false;
        stopToolTimer();
      }

      if (trackLoading) {
        // Mark any still-running tools as interrupted (but don't clear toolIdMap!)
          for (const id of runningToolIdsRef.current) {
            const tool = toolIdMap.get(id);
            if (tool && tool.status === 'running') {
              tool.status = 'error';
              tool.output = tool.output || 'Operation interrupted';
            }
        }
        runningToolIdsRef.current.clear();

        // Final update to show interrupted state
        updateMessage();
      }
    }
  }, [workspaceId, onMessagesUpdate, onComplete, stopToolTimer, onPanelUpdate, onStatusUpdate, makeMessageId]);

  return { executeQuery, stopQuery, isLoadingRef };
}
