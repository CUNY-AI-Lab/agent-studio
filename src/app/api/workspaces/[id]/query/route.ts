import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
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

  const stream = new ReadableStream({
    async start(controller) {
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
          }
        }

        // Save assistant message (even partial if aborted)
        if (fullResponse) {
          const content = abortController.signal.aborted
            ? fullResponse + '\n\n*[Response stopped by user]*'
            : fullResponse;
          await storage.appendMessage(id, { role: 'assistant', content });
        }

        // Send done or aborted event
        if (abortController.signal.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`));
        }

        controller.close();
      } catch (error) {
        // Check if this was an abort
        if (error instanceof Error && error.name === 'AbortError') {
          if (fullResponse) {
            await storage.appendMessage(id, { role: 'assistant', content: fullResponse + '\n\n*[Response stopped by user]*' });
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
