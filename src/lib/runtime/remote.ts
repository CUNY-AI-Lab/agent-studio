import { parseSseEvents } from '../streaming/sse';
import { Message, SandboxedStorage, WorkspaceConfig } from '../storage';
import { QueryOptions, StreamEvent, WorkspaceRuntime } from './types';

const DEFAULT_REMOTE_RUNNER_BASE_URL = 'http://127.0.0.1:3200';
const REMOTE_RUNNER_SECRET_HEADER = 'x-agent-studio-runner-secret';

interface RemoteRunnerQueryRequest {
  userId: string;
  config: WorkspaceConfig;
  prompt: string;
  conversationHistory?: Message[];
  includeWorkspaceState?: boolean;
}

export function getRemoteRunnerBaseUrl(): string {
  return (process.env.WORKSPACE_RUNNER_BASE_URL || DEFAULT_REMOTE_RUNNER_BASE_URL).replace(/\/+$/, '');
}

export function getRemoteRunnerSharedSecret(): string | null {
  const secret = process.env.WORKSPACE_RUNNER_SHARED_SECRET?.trim();
  return secret ? secret : null;
}

export function createRemoteWorkspaceRuntime(
  config: WorkspaceConfig,
  storage: SandboxedStorage
): WorkspaceRuntime {
  return {
    config,
    storage,

    async *query(prompt: string, conversationHistory?: Message[], options?: QueryOptions): AsyncIterable<StreamEvent> {
      const requestBody: RemoteRunnerQueryRequest = {
        userId: storage.userId,
        config,
        prompt,
        conversationHistory,
        includeWorkspaceState: options?.includeWorkspaceState,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };

      const sharedSecret = getRemoteRunnerSharedSecret();
      if (sharedSecret) {
        headers[REMOTE_RUNNER_SECRET_HEADER] = sharedSecret;
      }

      let response: Response;
      try {
        response = await fetch(`${getRemoteRunnerBaseUrl()}/query`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: options?.abortController?.signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        throw new Error(
          `Remote workspace runner is unavailable at ${getRemoteRunnerBaseUrl()}. `
          + 'Start the runner service before sending queries.'
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `Remote runner request failed with ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Remote runner response did not include a body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const parsed = parseSseEvents(buffer, chunk);
          buffer = parsed.rest;

          for (const event of parsed.events) {
            yield event as StreamEvent;
          }
        }

        const tail = decoder.decode();
        if (tail) {
          const parsed = parseSseEvents(buffer, tail);
          for (const event of parsed.events) {
            yield event as StreamEvent;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
