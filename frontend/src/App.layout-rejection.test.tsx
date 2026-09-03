import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import App from './App';
import * as api from './api';
import type { WorkspaceResponse } from './types';

const socketMessageSchema = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  method: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  probeId: z.string().optional(),
}).passthrough();

class TestWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly rpcMessages: Array<{ id: string; method: string; args: unknown[] }> = [];
  static shouldRejectNextRpc = true;

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  binaryType = 'blob';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      this.readyState = TestWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    const message = socketMessageSchema.parse(JSON.parse(data));

    if (message.type === 'rpc' && message.id && message.method && message.args) {
      TestWebSocket.rpcMessages.push({ id: message.id, method: message.method, args: message.args });
      const shouldReject = TestWebSocket.shouldRejectNextRpc;
      TestWebSocket.shouldRejectNextRpc = false;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'rpc',
          id: message.id,
          success: !shouldReject,
          ...(shouldReject
            ? { error: 'offline' }
            : { result: workspaceResponse().state }),
        }),
      })));
      return;
    }

    if (message.type === 'cf_agent_stream_resume_request') {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'cf_agent_stream_resume_none',
          reason: 'idle',
          probeId: message.probeId,
        }),
      })));
    }
  }

  close(): void {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

function workspaceResponse(
  panels: WorkspaceResponse['state']['panels'] = [
    {
      id: 'panel-one',
      type: 'markdown',
      title: 'One',
      content: 'One',
      layout: { x: 40, y: 40, width: 360, height: 220 },
    },
  ],
): WorkspaceResponse {
  const workspace = {
    id: 'workspace-1',
    name: 'Workspace one',
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  return {
    workspace,
    state: {
      sessionId: null,
      workspace,
      panels,
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    messages: [],
    files: [],
    runtime: { provider: 'dynamic-workers', codemode: true, git: true, outbound: 'tool-only' },
    agent: { className: 'WorkspaceAgent', name: 'workspace-1' },
  };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/agent-studio/?workspace=workspace-1');
  document.cookie = 'cail_csrf_agentstudio=' + 'a'.repeat(64) + '; path=/';
  vi.spyOn(api, 'fetchWorkspaces').mockResolvedValue([]);
  vi.spyOn(api, 'fetchGalleryItems').mockResolvedValue([]);
  vi.spyOn(api, 'fetchModels').mockResolvedValue({ models: [], default: 'model' });
  vi.spyOn(api, 'fetchWorkspaceDownloads').mockResolvedValue([]);
  vi.spyOn(api, 'fetchWorkspaceFiles').mockResolvedValue([]);
  vi.spyOn(api, 'refreshModelCredential').mockResolvedValue(undefined);
  vi.spyOn(api, 'fetchWorkspace').mockResolvedValue(workspaceResponse());
  TestWebSocket.rpcMessages.length = 0;
  TestWebSocket.shouldRejectNextRpc = true;
  vi.stubGlobal('WebSocket', TestWebSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real App layout-save failure handling', () => {
  it('shows a sticky recovery warning after rejection while later movement can save', async () => {
    render(<App />);
    const tile = await screen.findByRole('group', { name: 'One (markdown tile)' });

    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    await waitFor(() => expect(TestWebSocket.rpcMessages).toHaveLength(1));
    expect(TestWebSocket.rpcMessages[0]).toMatchObject({
      method: 'applyLayoutPatch',
      args: [{ panels: { 'panel-one': { x: 56, y: 40, width: 360, height: 220 } } }],
    });
    expect(await screen.findByText(
      'Some layout changes were not saved. Reload to restore the saved workspace; unsaved changes will be lost.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload saved workspace' })).toBeInTheDocument();

    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    await waitFor(() => expect(TestWebSocket.rpcMessages).toHaveLength(2));
    expect(TestWebSocket.rpcMessages[1]).toMatchObject({
      method: 'applyLayoutPatch',
      args: [{ panels: { 'panel-one': { x: 72, y: 40, width: 360, height: 220 } } }],
    });
    expect(screen.getAllByText(
      'Some layout changes were not saved. Reload to restore the saved workspace; unsaved changes will be lost.',
    )).not.toHaveLength(0);
  });

  it('sends only the moved panel when another existing overlap is unrelated', async () => {
    const panels: WorkspaceResponse['state']['panels'] = [
      {
        id: 'panel-a',
        type: 'markdown',
        title: 'A',
        content: 'A',
        layout: { x: 700, y: 40, width: 360, height: 220 },
      },
      {
        id: 'panel-b',
        type: 'markdown',
        title: 'B',
        content: 'B',
        layout: { x: 40, y: 40, width: 360, height: 220 },
      },
      {
        id: 'panel-c',
        type: 'markdown',
        title: 'C',
        content: 'C',
        layout: { x: 100, y: 40, width: 360, height: 220 },
      },
    ];
    vi.mocked(api.fetchWorkspace).mockResolvedValue(workspaceResponse(panels));
    TestWebSocket.shouldRejectNextRpc = false;

    render(<App />);
    const tile = await screen.findByRole('group', { name: 'A (markdown tile)' });

    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    await waitFor(() => expect(TestWebSocket.rpcMessages).toHaveLength(1));

    expect(TestWebSocket.rpcMessages[0]).toEqual({
      id: expect.any(String),
      method: 'applyLayoutPatch',
      args: [{ panels: { 'panel-a': { x: 716, y: 40, width: 360, height: 220 } } }],
    });
  });
});
