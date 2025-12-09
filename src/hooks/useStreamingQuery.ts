'use client';

import { useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';

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
    layout?: { x?: number; y?: number; w?: number; h?: number };
  };
  data?: {
    table?: unknown;
    chart?: unknown;
    cards?: unknown;
    content?: string;
  };
}

interface UseStreamingQueryOptions {
  workspaceId: string;
  onMessagesUpdate: (updater: (prev: Message[]) => Message[]) => void;
  onComplete: () => Promise<void>;
  onPanelUpdate?: (updates: PanelUpdate[]) => void;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export function useStreamingQuery({
  workspaceId,
  onMessagesUpdate,
  onComplete,
  onPanelUpdate,
}: UseStreamingQueryOptions) {
  const isLoadingRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track running tools separately from tool data - only used for timer and cancellation
  const runningToolIdsRef = useRef<Set<string>>(new Set());

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

  const executeQuery = useCallback(async (prompt: string, retryCount = 0): Promise<void> => {
    if (isLoadingRef.current && retryCount === 0) return;
    isLoadingRef.current = true;

    // Content blocks - directly store tools here (like site-studio pattern)
    const contentBlocks: ContentBlock[] = [];
    let currentSectionText = '';
    let currentToolsGroup: ToolExecution[] = [];
    const processedToolIds = new Set<string>(); // Deduplication
    const toolIdMap = new Map<string, ToolExecution>(); // O(1) lookup for tool results
    let lineBuffer = '';

    // Only add placeholder on first attempt
    if (retryCount === 0) {
      onMessagesUpdate((prev) => [...prev, { role: 'assistant', content: '', blocks: [] }]);
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

    const updateMessage = () => {
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
        updated[updated.length - 1] = {
          role: 'assistant',
          content: fullText,
          blocks: blocks.length > 0 ? blocks : undefined
        };
        return updated;
      });
    };

    // Start timer for elapsed time updates
    const startToolTimer = () => {
      if (timerRef.current) return;
      timerRef.current = setInterval(() => {
        const now = Date.now();
        let hasUpdates = false;

        for (const [id, tool] of toolIdMap) {
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
        body: JSON.stringify({ prompt }),
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader');
      readerRef.current = reader;

      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const fullChunk = lineBuffer + chunk;
          lineBuffer = '';

          const lines = fullChunk.split('\n');

          // If chunk doesn't end with newline, last line is incomplete
          if (!fullChunk.endsWith('\n')) {
            lineBuffer = lines.pop() || '';
          }

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const event = JSON.parse(data);

              if (event.type === 'text' || event.type === 'text_delta') {
                currentSectionText += event.content;
                updateMessage();
              } else if (event.type === 'tool_use') {
                // Deduplicate
                if (processedToolIds.has(event.toolId)) continue;
                processedToolIds.add(event.toolId);

                // Flush current text before starting tools
                flushText();

                const tool: ToolExecution = {
                  id: event.toolId,
                  name: event.toolName,
                  input: event.toolInput,
                  status: 'running',
                  startTime: Date.now(),
                  elapsedTime: 0,
                };

                toolIdMap.set(event.toolId, tool);
                runningToolIdsRef.current.add(event.toolId);
                currentToolsGroup.push(tool);

                startToolTimer();
                updateMessage();
              } else if (event.type === 'tool_result') {
                const tool = toolIdMap.get(event.toolId);
                if (tool) {
                  tool.status = event.isError ? 'error' : 'success';
                  tool.output = event.toolResult;
                  tool.elapsedTime = Math.round((Date.now() - tool.startTime) / 100) / 10;
                }

                runningToolIdsRef.current.delete(event.toolId);

                // Stop timer if no more running tools
                if (runningToolIdsRef.current.size === 0) {
                  stopToolTimer();
                }

                // Tool completed - flush the tools group and reset for next text section
                flushTools();

                updateMessage();
              } else if (event.type === 'panel_update') {
                // Handle panel updates from server
                if (onPanelUpdate && event.panelUpdates) {
                  onPanelUpdate(event.panelUpdates);
                }
              } else if (event.type === 'done' || event.type === 'aborted') {
                stopToolTimer();
                readerRef.current = null;

                // Final update to ensure everything is captured
                flushText();
                flushTools();
                updateMessage();

                await onComplete();
              }
            } catch {
              // Ignore parse errors for incomplete JSON
            }
          }
        }

        // Stream ended - final flush
        flushText();
        flushTools();
        updateMessage();

      } finally {
        stopToolTimer();
      }
    } catch (error: unknown) {
      console.error('Query error:', error);

      // Check for network errors and retry
      const isNetworkError = error instanceof TypeError &&
        (error.message?.includes('network') || error.message?.includes('fetch') || error.message?.includes('Failed'));

      if (isNetworkError && retryCount < MAX_RETRIES) {
        console.log(`Network error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        return executeQuery(prompt, retryCount + 1);
      }

      // Show error message
      const errorMessage = isNetworkError
        ? 'Connection lost. Please check your network and try again.'
        : 'Something went wrong. Please try again.';

      onMessagesUpdate((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && !prev[prev.length - 1].content) {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: errorMessage };
          return updated;
        }
        return [...prev, { role: 'assistant', content: errorMessage }];
      });
    } finally {
      isLoadingRef.current = false;
      stopToolTimer();

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
  }, [workspaceId, onMessagesUpdate, onComplete, stopToolTimer]);

  return { executeQuery, stopQuery, isLoadingRef };
}
