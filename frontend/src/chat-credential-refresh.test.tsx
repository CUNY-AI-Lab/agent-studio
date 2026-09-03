import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { refreshModelCredential } from './api';
import { z } from 'zod';
import type { ChatOnFinishCallback, UIMessage } from 'ai';

let hookResult: ReturnType<typeof useAgentChat> | null = null;
const chatRequestSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
});

const csrfToken = 't'.repeat(64);
const documentCookieDescriptor = Object.getOwnPropertyDescriptor(document, 'cookie');

function fakeAgent() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const send = vi.fn((payload: string) => {
    const request = chatRequestSchema.safeParse(JSON.parse(payload)).data;
    if (request?.type !== 'cf_agent_use_chat_request' || !request.id) return;
    queueMicrotask(() => {
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

function Harness({
  agent,
  onFinish,
  syncMessagesToServer,
}: {
  agent: ReturnType<typeof fakeAgent>;
  onFinish?: ChatOnFinishCallback<UIMessage>;
  syncMessagesToServer?: boolean;
}) {
  const messages: UIMessage[] = [];
  hookResult = useAgentChat({
    agent,
    getInitialMessages: null,
    resume: false,
    messages,
    prepareSendMessagesRequest: async () => {
      await refreshModelCredential('workspace-1');
      return {};
    },
    onFinish,
    syncMessagesToServer,
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

  it('marks a preflight failure as an error after the SDK optimistic user message', async () => {
    const agent = fakeAgent();
    const onFinish = vi.fn<ChatOnFinishCallback<UIMessage>>();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 'internal_error', message: 'refresh failed' },
    }, { status: 503 })));
    render(<Harness agent={agent} onFinish={onFinish} />);
    await waitFor(() => expect(hookResult).toBeTruthy());

    await act(async () => {
      await hookResult?.sendMessage({ text: 'hello' });
    });

    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      isAbort: false,
      isDisconnect: false,
      isError: true,
    }));
    expect(hookResult?.status).toBe('error');
    expect(hookResult?.messages).toHaveLength(1);
    expect(hookResult?.messages[0]).toMatchObject({ role: 'user' });
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('hydrates messages locally without echoing them, while clear and regenerate stay wired', async () => {
    const agent = fakeAgent();
    render(<Harness agent={agent} syncMessagesToServer={false} />);
    await waitFor(() => expect(hookResult).toBeTruthy());

    const message: UIMessage = { id: 'local-user', role: 'user', parts: [{ type: 'text', text: 'from REST' }] };
    await act(async () => {
      hookResult?.setMessages([message]);
    });
    expect(hookResult?.messages).toEqual([message]);
    expect(agent.send).not.toHaveBeenCalled();

    await act(async () => {
      await hookResult?.sendMessage({ text: 'new turn' });
    });
    await act(async () => {
      await hookResult?.regenerate();
    });
    expect(agent.send.mock.calls.map(([payload]) => JSON.parse(payload).type)).toEqual([
      'cf_agent_use_chat_request',
      'cf_agent_use_chat_request',
    ]);

    await act(async () => {
      hookResult?.clearHistory();
    });
    expect(agent.send.mock.calls.map(([payload]) => JSON.parse(payload).type)).toContain('cf_agent_chat_clear');
  });
});
