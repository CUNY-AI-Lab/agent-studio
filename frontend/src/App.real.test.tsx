import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as api from './api';
import type { WorkspaceFileInfo, WorkspaceResponse } from './types';

function workspaceResponse(id = 'workspace-1'): WorkspaceResponse {
  const workspace = {
    id,
    name: id === 'workspace-1' ? 'Workspace one' : 'Workspace two',
    description: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  return {
    workspace,
    state: {
      sessionId: null,
      workspace,
      panels: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [],
      connections: [],
    },
    messages: [],
    files: [],
    runtime: { provider: 'dynamic-workers', codemode: true, git: true, outbound: 'tool-only' },
    agent: { className: 'WorkspaceAgent', name: id },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/agent-studio/?workspace=workspace-1');
  document.cookie = 'cail_csrf_agentstudio=' + 'a'.repeat(64) + '; path=/';
  vi.spyOn(api, 'fetchWorkspaces').mockResolvedValue([]);
  vi.spyOn(api, 'fetchGalleryItems').mockResolvedValue([]);
  vi.spyOn(api, 'fetchModels').mockResolvedValue({ models: [], default: 'model' });
  vi.spyOn(api, 'fetchWorkspaceDownloads').mockResolvedValue([]);
  vi.spyOn(api, 'fetchWorkspaceFiles').mockResolvedValue([]);
  vi.spyOn(api, 'uploadWorkspaceFiles').mockResolvedValue(undefined);
  vi.spyOn(api, 'clearWorkspaceDownloads').mockResolvedValue(undefined);
  vi.spyOn(api, 'refreshModelCredential').mockResolvedValue(undefined);
  vi.spyOn(api, 'fetchWorkspace').mockResolvedValue(workspaceResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real App', () => {
  it('keeps home after refresh and Back', async () => {
    const user = userEvent.setup();
    const refresh = deferred<WorkspaceResponse>();
    vi.mocked(api.fetchWorkspace)
      .mockResolvedValueOnce(workspaceResponse())
      .mockReturnValueOnce(refresh.promise);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to home' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Refresh workspace' }));
    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(screen.getByRole('textbox', { name: 'What would you like to work on?' })).toBeInTheDocument();
    await act(async () => {
      refresh.resolve(workspaceResponse());
      await refresh.promise;
    });
    expect(screen.getByRole('textbox', { name: 'What would you like to work on?' })).toBeInTheDocument();
  });

  it('does not show the previous workspace while a new workspace is loading', async () => {
    const user = userEvent.setup();
    const next = workspaceResponse('workspace-2');
    const navigation = deferred<WorkspaceResponse>();
    vi.mocked(api.fetchWorkspace)
      .mockResolvedValueOnce(workspaceResponse())
      .mockReturnValueOnce(navigation.promise);
    vi.mocked(api.fetchWorkspaces).mockResolvedValue([next.workspace]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to home' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    await user.click(await screen.findByRole('button', { name: /Workspace two/ }));
    expect(screen.getByText('Loading workspace…')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Workspace one')).not.toBeInTheDocument();
    await act(async () => {
      navigation.resolve(next);
      await navigation.promise;
    });
    await waitFor(() => expect(screen.getByDisplayValue('Workspace two')).toBeInTheDocument());
  });

  it('keeps uploaded files after a stale file-list response', async () => {
    const user = userEvent.setup();
    const initialList = deferred<WorkspaceFileInfo[]>();
    const oldFiles = [{ name: 'old.txt', path: 'old.txt', isDirectory: false }];
    const uploadedFiles = [{ name: 'new.txt', path: 'new.txt', isDirectory: false }];
    vi.mocked(api.fetchWorkspaceFiles)
      .mockReturnValueOnce(initialList.promise)
      .mockResolvedValueOnce(uploadedFiles);
    render(<App />);
    await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.upload(
      screen.getByLabelText('Upload files to workspace'),
      new File(['new'], 'new.txt', { type: 'text/plain' }),
    );
    await waitFor(() => expect(api.fetchWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('new.txt')).toBeInTheDocument();
    await act(async () => {
      initialList.resolve(oldFiles);
      await initialList.promise;
    });
    expect(screen.getByText('new.txt')).toBeInTheDocument();
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument();
  });
});
