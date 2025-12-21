import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { SandboxedStorage, WorkspaceConfig, Message, UIPanel, Table, ChartData, CardsData } from '../storage';
import { getTools, ToolContext } from '../tools';

// Panel update type matching execute.ts
export interface PanelUpdate {
  action: 'add' | 'update' | 'remove';
  panel: UIPanel;
  data?: {
    table?: Table;
    chart?: ChartData;
    cards?: CardsData;
    content?: string;
  };
}

export interface QueryOptions {
  abortController?: AbortController;
  includeWorkspaceState?: boolean;
}

export interface WorkspaceRuntime {
  config: WorkspaceConfig;
  storage: SandboxedStorage;

  query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent>;
}

export type SdkEvent = { type: string; [key: string]: unknown };

export type StreamEvent =
  | SdkEvent
  | {
      type: 'panel_update';
      panelUpdates: PanelUpdate[];
    }
  | {
      type: 'error';
      error: string;
    };

// Parse panel updates from tool result
export function extractPanelUpdates(toolResult: string): { cleanResult: string; panelUpdates: PanelUpdate[] } {
  const marker = /__PANEL_UPDATES_START__([\s\S]*?)__PANEL_UPDATES_END__/;
  const match = toolResult.match(marker);
  if (match) {
    try {
      const panelUpdates = JSON.parse(match[1]) as PanelUpdate[];
      const cleanResult = toolResult.replace(marker, '').trim();
      return { cleanResult, panelUpdates };
    } catch {
      return { cleanResult: toolResult, panelUpdates: [] };
    }
  }
  return { cleanResult: toolResult, panelUpdates: [] };
}

type QueueResult<T> = { value: T | null; done: boolean };

function createAsyncQueue<T>() {
  let closed = false;
  const items: T[] = [];
  let resolver: ((result: QueueResult<T>) => void) | null = null;

  return {
    push(value: T) {
      if (closed) return;
      if (resolver) {
        const resolve = resolver;
        resolver = null;
        resolve({ value, done: false });
      } else {
        items.push(value);
      }
    },
    next(): Promise<QueueResult<T>> {
      if (items.length > 0) {
        return Promise.resolve({ value: items.shift() as T, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: null, done: true });
      }
      return new Promise((resolve) => {
        resolver = resolve;
      });
    },
    drain(): T[] {
      return items.splice(0, items.length);
    },
    close() {
      closed = true;
      if (resolver) {
        const resolve = resolver;
        resolver = null;
        resolve({ value: null, done: true });
      }
    },
  };
}

export function createWorkspaceRuntime(
  config: WorkspaceConfig,
  storage: SandboxedStorage
): WorkspaceRuntime {
  return {
    config,
    storage,

    async *query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent> {
      const panelQueue = createAsyncQueue<PanelUpdate[]>();
      const ctx: ToolContext = {
        storage,
        workspaceId: config.id,
        emitPanelUpdates: (updates) => panelQueue.push(updates),
      };

      const tools = getTools(config.tools, ctx);

      const server = createSdkMcpServer({
        name: config.id,
        version: '1.0.0',
        tools,
      });

      // Build context from conversation history and current workspace state
      let contextPrompt = '';

      // Add conversation history (last 10 messages for context)
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-10);
        contextPrompt += '<conversation_history>\n';
        for (const msg of recentHistory) {
          contextPrompt += `<${msg.role}>${msg.content}</${msg.role}>\n`;
        }
        contextPrompt += '</conversation_history>\n\n';
      }

      if (options?.includeWorkspaceState !== false) {
        // Add current workspace state
        const uiState = await storage.getUIState(config.id);
        const tables = await storage.listTables(config.id);
        const charts = await storage.listCharts(config.id);
        const cards = await storage.listCards(config.id);

        if (uiState || tables.length > 0 || charts.length > 0 || cards.length > 0) {
          contextPrompt += '<current_workspace_state>\n';
          if (uiState) {
            contextPrompt += `Panels: ${uiState.panels.map(p => `${p.type}${p.id ? `:${p.id}` : ''}${p.tableId ? ` (table:${p.tableId})` : ''}${p.chartId ? ` (chart:${p.chartId})` : ''}${p.cardsId ? ` (cards:${p.cardsId})` : ''}`).join(', ')}\n`;
          }
          if (tables.length > 0) {
            contextPrompt += `Tables: ${tables.map(t => `${t.id} ("${t.title}", ${t.data.length} rows)`).join(', ')}\n`;
          }
          if (charts.length > 0) {
            contextPrompt += `Charts: ${charts.map(c => `${c.id} ("${c.title}", type: ${c.type})`).join(', ')}\n`;
          }
          if (cards.length > 0) {
            contextPrompt += `Cards: ${cards.map(c => `${c.id} ("${c.title}")`).join(', ')}\n`;
          }
          // Include panel groups if any exist
          if (uiState?.groups && uiState.groups.length > 0) {
            contextPrompt += '\n<panel_groups>\n';
            for (const group of uiState.groups) {
              contextPrompt += `<group id="${group.id}"${group.name ? ` name="${group.name}"` : ''}>`;
              contextPrompt += group.panelIds.join(', ');
              contextPrompt += '</group>\n';
            }
            contextPrompt += '</panel_groups>\n';
            contextPrompt += 'Note: The user has grouped some panels together. Operations on one panel in a group may be relevant to others in the same group.\n';
          }
          // Include panel connections if any exist
          if (uiState?.connections && uiState.connections.length > 0) {
            contextPrompt += '\n<panel_connections>\n';
            for (const conn of uiState.connections) {
              contextPrompt += `${conn.sourceId} -> ${conn.targetId}\n`;
            }
            contextPrompt += '</panel_connections>\n';
            contextPrompt += 'Note: These panels are connected - the target was created from context of the source.\n';
          }
          contextPrompt += '</current_workspace_state>\n\n';
        }
      }

      contextPrompt += `<user_message>${prompt}</user_message>`;

      // Build allowed tools list:
      // - Our custom MCP tools (prefixed as mcp__{serverName}__{toolName})
      // - Safe built-in SDK tools that don't access local filesystem
      // - Bash for Python execution (sandboxed)
      const allowedTools = [
        ...tools.map(t => `mcp__${config.id}__${t.name}`),
        'Bash',       // Execute Python via sandbox (fast, local)
        'WebFetch',   // Fetch and parse web content (safe - external only)
        'WebSearch',  // Search the web (safe - external only)
        'Skill',      // Use skills from .claude/skills/
      ];

      try {
        const messages = query({
          prompt: contextPrompt,
          options: {
            systemPrompt: config.systemPrompt,
            model: 'claude-opus-4-5-20251101',
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            mcpServers: { [config.id]: server },
            allowedTools,
            settingSources: ['project'], // Load skills from .claude/skills/
            includePartialMessages: true, // Enable token-level streaming
            abortController: options?.abortController,
            persistSession: false, // Don't save to ~/.claude/projects/ - keeps app sessions separate from Claude Code
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
            },
          },
        });

        const iterator = messages[Symbol.asyncIterator]();
        let nextMessage = iterator.next();
        let nextPanel = panelQueue.next();

        while (true) {
          const race = await Promise.race([
            nextMessage.then((result) => ({ source: 'llm' as const, result })),
            nextPanel.then((result) => ({ source: 'panel' as const, result })),
          ]);

          if (race.source === 'panel') {
            if (!race.result.done && race.result.value) {
              yield {
                type: 'panel_update',
                panelUpdates: race.result.value,
              };
            }
            nextPanel = panelQueue.next();
            continue;
          }

          const { value: event, done } = race.result;
          if (done) break;

          const isResultEvent = event.type === 'result';

          if (event.type === 'user' && Array.isArray(event.message?.content)) {
            const panelUpdates: PanelUpdate[] = [];
            const nextContent = event.message.content.map((block: { type?: string; content?: unknown }) => {
              if (typeof block === 'string' || block.type !== 'tool_result') return block;
              const rawResultText =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                  ? block.content
                      .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
                      .map((c: { type: 'text'; text: string }) => c.text)
                      .join('\n')
                  : '';

              if (!rawResultText) return block;
              const { cleanResult, panelUpdates: extracted } = extractPanelUpdates(rawResultText);
              if (extracted.length > 0) {
                panelUpdates.push(...extracted);
              }
              return { ...block, content: cleanResult };
            });

            if (panelUpdates.length > 0) {
              yield { type: 'panel_update', panelUpdates };
            }

            yield {
              ...event,
              message: {
                ...event.message,
                content: nextContent,
              },
            } as StreamEvent;
          } else {
            yield event as StreamEvent;
          }

          if (isResultEvent) {
            break;
          }

          nextMessage = iterator.next();
        }

        panelQueue.close();
        const pendingPanelUpdates = panelQueue.drain();
        for (const updates of pendingPanelUpdates) {
          yield {
            type: 'panel_update',
            panelUpdates: updates,
          };
        }

      } catch (error) {
        yield {
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  };
}
