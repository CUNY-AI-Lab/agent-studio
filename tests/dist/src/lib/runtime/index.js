"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPanelUpdates = extractPanelUpdates;
exports.createWorkspaceRuntime = createWorkspaceRuntime;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const tools_1 = require("../tools");
// Parse panel updates from tool result
function extractPanelUpdates(toolResult) {
    const marker = /__PANEL_UPDATES_START__([\s\S]*?)__PANEL_UPDATES_END__/;
    const match = toolResult.match(marker);
    if (match) {
        try {
            const panelUpdates = JSON.parse(match[1]);
            const cleanResult = toolResult.replace(marker, '').trim();
            return { cleanResult, panelUpdates };
        }
        catch {
            return { cleanResult: toolResult, panelUpdates: [] };
        }
    }
    return { cleanResult: toolResult, panelUpdates: [] };
}
function createWorkspaceRuntime(config, storage) {
    return {
        config,
        storage,
        async *query(prompt, conversationHistory, options) {
            var _a;
            const ctx = {
                storage,
                workspaceId: config.id,
            };
            const tools = (0, tools_1.getTools)(config.tools, ctx);
            const server = (0, claude_agent_sdk_1.createSdkMcpServer)({
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
                // Include panel groups if any exist
                if ((uiState === null || uiState === void 0 ? void 0 : uiState.groups) && uiState.groups.length > 0) {
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
                if ((uiState === null || uiState === void 0 ? void 0 : uiState.connections) && uiState.connections.length > 0) {
                    contextPrompt += '\n<panel_connections>\n';
                    for (const conn of uiState.connections) {
                        contextPrompt += `${conn.sourceId} -> ${conn.targetId}\n`;
                    }
                    contextPrompt += '</panel_connections>\n';
                    contextPrompt += 'Note: These panels are connected - the target was created from context of the source.\n';
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
                'Bash', // Execute Python via sandbox (fast, local)
                'WebFetch', // Fetch and parse web content (safe - external only)
                'WebSearch', // Search the web (safe - external only)
                'Skill', // Use skills from .claude/skills/
            ];
            try {
                const messages = (0, claude_agent_sdk_1.query)({
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
                        abortController: options === null || options === void 0 ? void 0 : options.abortController,
                        persistSession: false, // Don't save to ~/.claude/projects/ - keeps app sessions separate from Claude Code
                        sandbox: {
                            enabled: true,
                            autoAllowBashIfSandboxed: true,
                        },
                    },
                });
                for await (const event of messages) {
                    // Handle streaming deltas (token-level streaming)
                    if (event.type === 'stream_event') {
                        const streamEvent = event.event;
                        if (streamEvent.type === 'content_block_delta' && ((_a = streamEvent.delta) === null || _a === void 0 ? void 0 : _a.type) === 'text_delta') {
                            yield { type: 'text_delta', content: streamEvent.delta.text };
                        }
                    }
                    else if (event.type === 'assistant') {
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
                    }
                    else if (event.type === 'user') {
                        // Tool results come back as user messages
                        for (const block of event.message.content) {
                            if (typeof block === 'string')
                                continue; // Skip string content
                            if (block.type === 'tool_result') {
                                const rawResultText = typeof block.content === 'string'
                                    ? block.content
                                    : Array.isArray(block.content)
                                        ? block.content
                                            .filter((c) => c.type === 'text')
                                            .map((c) => c.text)
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
            }
            catch (error) {
                yield {
                    type: 'error',
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    };
}
