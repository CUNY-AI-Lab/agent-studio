import { mkdir } from 'fs/promises';
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { SandboxedStorage, WorkspaceConfig, Message } from '../storage';
import { getTools, ToolContext } from '../tools';
import { PanelUpdate, QueryOptions, StreamEvent, WorkspaceRuntime } from './types';
import { buildClaudeCodeProcessEnv } from './environment';
import { createWorkspaceResourceRegistrar } from './resources';

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

export const CLAUDE_CODE_BUILT_IN_ALLOWED_TOOLS = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

export interface WorkspaceRuntimePaths {
  workspaceRootDir: string;
  workspaceFilesDir: string;
  runtimeTmpDir: string;
}

export function getWorkspaceRuntimePaths(
  storage: Pick<SandboxedStorage, 'basePath'>,
  workspaceId: string
): WorkspaceRuntimePaths {
  const workspaceRootDir = path.join(storage.basePath, 'workspaces', workspaceId);

  return {
    workspaceRootDir,
    workspaceFilesDir: path.join(workspaceRootDir, 'files'),
    runtimeTmpDir: path.join(workspaceRootDir, '.runtime-tmp'),
  };
}

export function buildWorkspaceRuntimeSecurityOptions(args: {
  mcpToolNames: string[];
  paths: WorkspaceRuntimePaths;
  abortController?: AbortController;
  egressProxyPort?: number;
}) {
  const { mcpToolNames, paths, abortController, egressProxyPort } = args;
  const proxyUrl = egressProxyPort ? `http://127.0.0.1:${egressProxyPort}` : undefined;

  return {
    permissionMode: 'dontAsk' as const,
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
    allowedTools: [...mcpToolNames, ...CLAUDE_CODE_BUILT_IN_ALLOWED_TOOLS],
    cwd: paths.workspaceFilesDir,
    env: buildClaudeCodeProcessEnv({
      TMPDIR: paths.runtimeTmpDir,
      TMP: paths.runtimeTmpDir,
      TEMP: paths.runtimeTmpDir,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    }),
    settings: {
      permissions: {
        defaultMode: 'dontAsk' as const,
        disableBypassPermissionsMode: 'disable' as const,
      },
    },
    includePartialMessages: true,
    abortController,
    persistSession: false,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowAllUnixSockets: false,
          allowLocalBinding: false,
          ...(egressProxyPort ? { httpProxyPort: egressProxyPort } : {}),
        },
        filesystem: {
          allowWrite: [paths.workspaceFilesDir, paths.runtimeTmpDir],
          allowRead: [paths.workspaceFilesDir, paths.runtimeTmpDir],
        },
      },
  };
}

export function createInProcessWorkspaceRuntime(
  config: WorkspaceConfig,
  storage: SandboxedStorage,
  runtimeConfig?: {
    egressProxyPort?: number;
  }
): WorkspaceRuntime {
  return {
    config,
    storage,

    async *query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent> {
      await storage.listFiles(config.id, '');
      const runtimePaths = getWorkspaceRuntimePaths(storage, config.id);
      await mkdir(runtimePaths.runtimeTmpDir, { recursive: true });
      const panelQueue = createAsyncQueue<PanelUpdate[]>();
      const server = createSdkMcpServer({
        name: config.id,
        version: '1.0.0',
      });
      const resourceRegistrar = createWorkspaceResourceRegistrar({
        server: server.instance,
        storage,
        workspaceId: config.id,
      });
      const ctx: ToolContext = {
        storage,
        workspaceId: config.id,
        emitPanelUpdates: (updates) => panelQueue.push(updates),
        refreshMcpResources: async () => {
          await resourceRegistrar.sync();
        },
      };

      const tools = getTools(config.tools, ctx);
      tools.forEach((registeredTool) => {
        server.instance.registerTool(
          registeredTool.name,
          {
            description: registeredTool.description,
            inputSchema: registeredTool.inputSchema,
            ...(registeredTool.annotations ? { annotations: registeredTool.annotations } : {}),
          },
          registeredTool.handler
        );
      });
      await resourceRegistrar.sync();

      // Build context from conversation history and current workspace state
      let contextPrompt = '';
      contextPrompt += '<workspace_filesystem>\n';
      contextPrompt += `Workspace files directory: ${runtimePaths.workspaceFilesDir}\n`;
      contextPrompt += 'When using Bash, the current working directory is this workspace files directory.\n';
      contextPrompt += 'Durable outputs created with Bash must be written here or in a subdirectory here.\n';
      contextPrompt += 'Claude Code file tools should treat this directory as the workspace root.\n';
      contextPrompt += '</workspace_filesystem>\n\n';

      if (runtimeConfig?.egressProxyPort) {
        contextPrompt += '<workspace_network>\n';
        contextPrompt += 'Broad public internet access is available.\n';
        contextPrompt += 'Localhost, private IP ranges, cloud metadata endpoints, and internal-only hostnames are blocked.\n';
        contextPrompt += '</workspace_network>\n\n';
      }

      contextPrompt += '<workspace_mcp>\n';
      contextPrompt += `Workspace MCP server name: ${config.id}\n`;
      contextPrompt += 'Canvas-backed data and local app reference docs are exposed as MCP resources on this server.\n';
      contextPrompt += 'Use ReadMcpResource with this server name and a listed resource URI when you need that data.\n';
      contextPrompt += '</workspace_mcp>\n\n';

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
            contextPrompt += `Tiles: ${uiState.panels.map(p => `${p.type}${p.id ? `:${p.id}` : ''}${p.tableId ? ` (table:${p.tableId})` : ''}${p.chartId ? ` (chart:${p.chartId})` : ''}${p.cardsId ? ` (cards:${p.cardsId})` : ''}`).join(', ')}\n`;
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
          if (uiState?.groups && uiState.groups.length > 0) {
            contextPrompt += '\n<tile_groups>\n';
            for (const group of uiState.groups) {
              contextPrompt += `<group id="${group.id}"${group.name ? ` name="${group.name}"` : ''}>`;
              contextPrompt += group.panelIds.join(', ');
              contextPrompt += '</group>\n';
            }
            contextPrompt += '</tile_groups>\n';
            contextPrompt += 'Note: The user has grouped some tiles together. Operations on one tile in a group may be relevant to others in the same group.\n';
          }
          if (uiState?.connections && uiState.connections.length > 0) {
            contextPrompt += '\n<tile_connections>\n';
            for (const conn of uiState.connections) {
              contextPrompt += `${conn.sourceId} -> ${conn.targetId}\n`;
            }
            contextPrompt += '</tile_connections>\n';
            contextPrompt += 'Note: These tiles are connected - the target was created from context of the source.\n';
          }
          contextPrompt += '</current_workspace_state>\n\n';
        }
      }

      contextPrompt += `<user_message>${prompt}</user_message>`;

      const mcpToolNames = tools.map(t => `mcp__${config.id}__${t.name}`);
      const runtimeOptions = buildWorkspaceRuntimeSecurityOptions({
        mcpToolNames,
        paths: runtimePaths,
        abortController: options?.abortController,
        egressProxyPort: runtimeConfig?.egressProxyPort,
      });

      try {
        const messages = query({
          prompt: contextPrompt,
          options: {
            systemPrompt: config.systemPrompt,
            model: 'claude-opus-4-5-20251101',
            mcpServers: { [config.id]: server },
            ...runtimeOptions,
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
