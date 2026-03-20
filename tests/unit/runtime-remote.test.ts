import assert from 'assert';
import { describe, it } from 'node:test';
import { createRemoteWorkspaceRuntime } from '../../src/lib/runtime';

describe('remote workspace runtime', () => {
  it('streams SSE events from the remote runner', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              ': ready\n\n'
              + 'data: {"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}\n\n'
              + 'data: {"type":"panel_update","panelUpdates":[]}\n\n'
            )
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    }) as typeof fetch;

    try {
      const runtime = createRemoteWorkspaceRuntime(
        {
          id: 'ws-remote',
          name: 'Remote',
          description: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          systemPrompt: '',
          tools: [],
        },
        {
          userId: 'a'.repeat(32),
          basePath: '/tmp/agent-studio-test',
        } as Parameters<typeof createRemoteWorkspaceRuntime>[1]
      );

      const events: Array<{ type?: string }> = [];
      for await (const event of runtime.query('hi')) {
        events.push(event as { type?: string });
      }

      assert.deepEqual(events.map((event) => event.type), ['assistant', 'panel_update']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
