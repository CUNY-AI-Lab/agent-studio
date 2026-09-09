import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { refreshModelCredential, respondToModelCredentialRefresh } from './api';
import { z } from 'zod';
import type { UIMessage } from 'ai';

let hookResult: ReturnType<typeof useAgentChat> | null = null;
const chatRequestSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
});
const csrfToken = 't'.repeat(64);
const documentCookieDescriptor = Object.getOwnPropertyDescriptor(document, 'cookie');

function fakeAgent(refreshRequestId?: string) {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const send = vi.fn((payload: string) => {
    const request = chatRequestSchema.safeParse(JSON.parse(payload)).data;
    if (request?.type !== 'cf_agent_use_chat_request' || !request.id) return;
    queueMicrotask(() => {
      if (refreshRequestId) {
        const refresh = new MessageEvent('message', {
          data: JSON.stringify({
            type: 'cf_agent_use_chat_response', id: request.id,
            body: JSON.stringify({ type: 'data-credential-refresh', data: { requestId: refreshRequestId }, transient: true }),
            done: false,
          }),
        });
        listeners.get('message')?.forEach((listener) => listener(refresh));
      }
      const event = new MessageEvent('message', {
        data: JSON.stringify({
          type: 'cf_agent_use_chat_response',
          id: request.id,
          body: JSON.stringify({ type: 'finish' }),
          done: true,
        }),
      });
      listeners.get('message')?.forEach((listener) => listener(event));
    });
  });
  return {
    agent: 'WorkspaceAgent',
    name: 'a'.repeat(32) + '-workspace-1',
    path: undefined,
    _pk: 'agent-pk',
    connectionError: null,
    getHttpUrl: () => 'https://studio.test/agents/workspace-agent/a'.repeat(1),
    send,
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      listeners.get(type)?.delete(listener);
    }),
  };
}

function Harness({ agent, signal }: { agent: ReturnType<typeof fakeAgent>; signal?: AbortSignal }) {
  const messages: UIMessage[] = [];
  hookResult = useAgentChat({
    agent,
    getInitialMessages: null,
    resume: false,
    messages,
    onData: (part) => {
      void respondToModelCredentialRefresh(part, 'workspace-1', signal ?? new AbortController().signal);
    },
    prepareSendMessagesRequest: async () => {
      await refreshModelCredential('workspace-1');
      return {};
    },
  });
  return null;
}

describe('useAgentChat credential refresh preparation', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `cail_csrf_agentstudio=${csrfToken}`,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (documentCookieDescriptor) Object.defineProperty(document, 'cookie', documentCookieDescriptor);
    hookResult = null;
  });

  it('refreshes immediately before submit and regenerate transport sends', async () => {
    const agent = fakeAgent();
    render(<Harness agent={agent} />);
    await waitFor(() => expect(hookResult).toBeTruthy());

    await act(async () => {
      await hookResult?.sendMessage({ text: 'hello' });
    });
    await act(async () => {
      await hookResult?.regenerate();
    });

    const calls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/model-credential'));
    expect(calls).toHaveLength(2);
    expect(calls.map(([, init]) => init?.method)).toEqual(['POST', 'POST']);
    expect(agent.send).toHaveBeenCalledTimes(2);
    const requestBodies = agent.send.mock.calls.map(([payload]) => JSON.parse(payload).init.body);
    expect(requestBodies.map((body: string) => JSON.parse(body).trigger)).toEqual([
      'submit-message',
      'regenerate-message',
    ]);
  });

  it('does not send a WebSocket request when credential refresh fails', async () => {
    const agent = fakeAgent();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 'internal_error', message: 'refresh failed' },
    }, { status: 503 })));
    render(<Harness agent={agent} />);
    await waitFor(() => expect(hookResult).toBeTruthy());

    await act(async () => {
      await hookResult?.sendMessage({ text: 'hello' });
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/model-credential',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('renews on a transient SDK data event without another chat send or persisted tool', async () => {
    const agent = fakeAgent('00000000-0000-4000-8000-000000000001');
    render(<Harness agent={agent} />);
    await act(async () => { await hookResult?.sendMessage({ text: 'hello' }); });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    const renewal = vi.mocked(fetch).mock.calls[1][1];
    expect(renewal?.body).toBe(JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001' }));
    expect(new Headers(renewal?.headers).get('Content-Type')).toBe('application/json');
    expect(agent.send).toHaveBeenCalledOnce();
    expect(hookResult?.messages.some((message) => message.parts.some((part) => part.type === 'data-credential-refresh'))).toBe(false);
  });

  it('leaves failed renewal to the server wait without another socket request', async () => {
    const agent = fakeAgent('00000000-0000-4000-8000-000000000002');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'upstream_error', message: 'failed' } }, { status: 503 }));
    render(<Harness agent={agent} />);
    await act(async () => { await hookResult?.sendMessage({ text: 'hello' }); });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(agent.send).toHaveBeenCalledOnce();
  });

  it('allows a second tab to complete the same renewal after the first tab fails', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('connection failed'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const event = {
      type: 'data-credential-refresh' as const,
      data: { requestId: '00000000-0000-4000-8000-000000000004' },
    };
    await expect(Promise.all([
      respondToModelCredentialRefresh(event, 'workspace-1', new AbortController().signal),
      respondToModelCredentialRefresh(event, 'workspace-1', new AbortController().signal),
    ])).resolves.toEqual([undefined, undefined]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ requestId: event.data.requestId }),
      JSON.stringify({ requestId: event.data.requestId }),
    ]);
  });

  it('aborts renewal HTTP without acknowledging cancellation as a failed credential', async () => {
    const agent = fakeAgent('00000000-0000-4000-8000-000000000003');
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    render(<Harness agent={agent} signal={controller.signal} />);
    await act(async () => { await hookResult?.sendMessage({ text: 'hello' }); });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    await act(async () => { controller.abort(); });
    expect(vi.mocked(fetch).mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(agent.send).toHaveBeenCalledOnce();
  });
});
