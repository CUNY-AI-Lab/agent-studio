import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage, type ContentBlock, type ToolExecution } from '@/lib/storage';
import { createWorkspaceRuntime } from '@/lib/runtime';

// Store active queries for cancellation
// Key: sessionId:workspaceId, Value: AbortController
const activeQueries = new Map<string, AbortController>();

export function getActiveQuery(key: string): AbortController | undefined {
  return activeQueries.get(key);
}

export function removeActiveQuery(key: string): void {
  activeQueries.delete(key);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  const workspace = await storage.getWorkspace(id);
  if (!workspace) {
    return new Response(
      JSON.stringify({ error: 'Workspace not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let prompt: string | undefined;
  try {
    const body = await request.json();
    prompt = body.prompt;
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!prompt) {
    return new Response(
      JSON.stringify({ error: 'Prompt is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Get conversation history before adding new message
  const conversationHistory = await storage.getConversation(id);

  // Save user message
  await storage.appendMessage(id, { role: 'user', content: prompt });

  // Create runtime and stream response
  const runtime = createWorkspaceRuntime(workspace, storage);

  // Create AbortController for this query
  const abortController = new AbortController();
  const queryKey = `${sessionId}:${id}`;
  activeQueries.set(queryKey, abortController);

  const encoder = new TextEncoder();
  let fullResponse = '';

  // Track tool executions for block persistence
  const contentBlocks: ContentBlock[] = [];
  let currentTextBlock = '';
  const currentToolsGroup: ToolExecution[] = [];
  const toolMap = new Map<string, ToolExecution>();

  const flushText = () => {
    if (currentTextBlock.trim()) {
      contentBlocks.push({ type: 'text', text: currentTextBlock });
      currentTextBlock = '';
    }
  };

  const flushTools = () => {
    if (currentToolsGroup.length > 0) {
      contentBlocks.push({ type: 'tools', tools: [...currentToolsGroup] });
      currentToolsGroup.length = 0;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Set up keepalive interval to prevent connection timeout
      // SSE comments (lines starting with :) are ignored by clients
      const KEEPALIVE_INTERVAL = 15000; // 15 seconds
      const keepaliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          // Controller may be closed, ignore
        }
      }, KEEPALIVE_INTERVAL);

      try {
        for await (const event of runtime.query(prompt, conversationHistory, { abortController })) {
          // Check if aborted
          if (abortController.signal.aborted) {
            break;
          }

          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));

          // Capture both full text and deltas for the final message
          if ((event.type === 'text' || event.type === 'text_delta') && event.content) {
            fullResponse += event.content;
            currentTextBlock += event.content;
          } else if (event.type === 'tool_use' && event.toolId && event.toolName) {
            // Flush text before tools
            flushText();

            const tool: ToolExecution = {
              id: event.toolId,
              name: event.toolName,
              input: event.toolInput,
              status: 'running',
            };
            toolMap.set(event.toolId, tool);
            currentToolsGroup.push(tool);
          } else if (event.type === 'tool_result' && event.toolId) {
            const tool = toolMap.get(event.toolId);
            if (tool) {
              tool.status = event.isError ? 'error' : 'success';
              tool.output = event.toolResult;
            }
            // Flush tools after result
            flushTools();
          }
        }

        // Final flush
        flushText();
        flushTools();

        // Save assistant message with blocks
        if (fullResponse) {
          const content = abortController.signal.aborted
            ? fullResponse + '\n\n*[Response stopped by user]*'
            : fullResponse;
          await storage.appendMessage(id, {
            role: 'assistant',
            content,
            blocks: contentBlocks.length > 0 ? contentBlocks : undefined
          });
        }

        // Send done or aborted event
        if (abortController.signal.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`));
        }

        clearInterval(keepaliveInterval);
        controller.close();
      } catch (error) {
        clearInterval(keepaliveInterval);

        // Check if this was an abort
        if (error instanceof Error && error.name === 'AbortError') {
          flushText();
          flushTools();
          if (fullResponse) {
            await storage.appendMessage(id, {
              role: 'assistant',
              content: fullResponse + '\n\n*[Response stopped by user]*',
              blocks: contentBlocks.length > 0 ? contentBlocks : undefined
            });
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`));
          controller.close();
          return;
        }

        const errorEvent = {
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        controller.close();
      } finally {
        // Clean up
        activeQueries.delete(queryKey);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
