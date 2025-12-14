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
}

export interface WorkspaceRuntime {
  config: WorkspaceConfig;
  storage: SandboxedStorage;

  query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent>;
}

export interface StreamEvent {
  type: 'text' | 'text_delta' | 'tool_use' | 'tool_result' | 'panel_update' | 'error' | 'done';
  content?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
  error?: string;
  // For panel_update events
  panelUpdates?: PanelUpdate[];
}

// Parse panel updates from tool result
function extractPanelUpdates(toolResult: string): { cleanResult: string; panelUpdates: PanelUpdate[] } {
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

export function createWorkspaceRuntime(
  config: WorkspaceConfig,
  storage: SandboxedStorage
): WorkspaceRuntime {
  return {
    config,
    storage,

    async *query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent> {
      const ctx: ToolContext = {
        storage,
        workspaceId: config.id,
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
        contextPrompt += '</current_workspace_state>\n\n';
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
            model: 'claude-sonnet-4-20250514', // Use Sonnet to avoid Haiku overload
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            mcpServers: { [config.id]: server },
            allowedTools,
            settingSources: ['project'], // Load skills from .claude/skills/
            includePartialMessages: true, // Enable token-level streaming
            abortController: options?.abortController,
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
            },
          },
        });

        for await (const event of messages) {
          // Handle streaming deltas (token-level streaming)
          if (event.type === 'stream_event') {
            const streamEvent = (event as { event: { type: string; delta?: { type: string; text?: string } } }).event;
            if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
              yield { type: 'text_delta', content: streamEvent.delta.text };
            }
          } else if (event.type === 'assistant') {
            // Full message (for tool use blocks which aren't streamed as deltas)
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                yield {
                  type: 'tool_use',
                  toolId: block.id,
                  toolName: block.name,
                  toolInput: block.input,
                };
              }
              // Don't yield text here - we get it from stream_event deltas
            }
          } else if (event.type === 'user') {
            // Tool results come back as user messages
            for (const block of event.message.content) {
              if (typeof block === 'string') continue; // Skip string content
              if (block.type === 'tool_result') {
                const rawResultText =
                  typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                    ? block.content
                        .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
                        .map((c: { type: 'text'; text: string }) => c.text)
                        .join('\n')
                    : '';

                // Extract panel updates from result
                const { cleanResult, panelUpdates } = extractPanelUpdates(rawResultText);

                yield {
                  type: 'tool_result',
                  toolId: block.tool_use_id,
                  toolResult: cleanResult,
                  isError: block.is_error,
                };

                // Emit panel updates as separate event if any
                if (panelUpdates.length > 0) {
                  yield {
                    type: 'panel_update',
                    panelUpdates,
                  };
                }
              }
            }
          }
        }

        yield { type: 'done' };
      } catch (error) {
        yield {
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  };
}
