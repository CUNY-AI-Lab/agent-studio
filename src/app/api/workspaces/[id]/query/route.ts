import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
import { createWorkspaceRuntime } from '@/lib/runtime';
import { createStreamAccumulator, type StreamAccumulatorState } from '@/lib/streaming/accumulator';

export const dynamic = 'force-dynamic';

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
  let skipConversation = false;
  try {
    const body = await request.json();
    prompt = body.prompt;
    skipConversation = Boolean(body.skipConversation);
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
  const conversationHistory = skipConversation ? [] : await storage.getConversation(id);

  // Save user message unless it's a contextual (side) chat
  if (!skipConversation) {
    await storage.appendMessage(id, { role: 'user', content: prompt });
  }

  // Create runtime and stream response
  const runtime = createWorkspaceRuntime(workspace, storage);

  // Create AbortController for this query
  const abortController = new AbortController();
  const queryKey = `${sessionId}:${id}`;
  if (!skipConversation) {
    activeQueries.set(queryKey, abortController);
  }

  const encoder = new TextEncoder();
  const accumulator = createStreamAccumulator();
  let finalState: StreamAccumulatorState | null = null;

  const finalizeAccumulator = () => {
    if (!finalState) {
      finalState = accumulator.finalize();
    }
    return finalState;
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Initial comment to force headers/body to flush in some proxies.
      controller.enqueue(encoder.encode(': ready\n\n'));

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
        for await (const event of runtime.query(prompt, conversationHistory, {
          abortController,
          includeWorkspaceState: !skipConversation,
        })) {
          // Check if aborted
          if (abortController.signal.aborted) {
            break;
          }

          if (event.type === 'done') {
            continue;
          }

          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));

          accumulator.ingest(event);
        }

        const { fullResponse, contentBlocks } = finalizeAccumulator();

        // Send done or aborted event before persistence to avoid UI stalls.
        const wasAborted = abortController.signal.aborted;
        if (wasAborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
        }

        // Save assistant message with blocks (if this isn't a contextual query)
        if (fullResponse && !skipConversation) {
          const content = wasAborted
            ? fullResponse + '\n\n*[Response stopped by user]*'
            : fullResponse;
          await storage.appendMessage(id, {
            role: 'assistant',
            content,
            blocks: contentBlocks.length > 0 ? contentBlocks : undefined
          });
        }

        clearInterval(keepaliveInterval);
        controller.close();
      } catch (error) {
        clearInterval(keepaliveInterval);

        // Check if this was an abort
        if (error instanceof Error && error.name === 'AbortError') {
          const { fullResponse, contentBlocks } = finalizeAccumulator();
          if (fullResponse && !skipConversation) {
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
        if (!skipConversation) {
          activeQueries.delete(queryKey);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
