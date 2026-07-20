import { describe, expect, it } from 'vitest';
import { agentBasePath, appPath } from './base-path';

describe('application base path', () => {
  it('prefixes HTTP and Agent routes with the Vite deployment base', () => {
    expect(appPath('/api/session')).toBe('/api/session');
    expect(agentBasePath('WorkspaceAgent', 'abc-123')).toBe('agents/workspace-agent/abc-123');
    expect(appPath('/api/session', '/agent-studio/')).toBe('/agent-studio/api/session');
    expect(agentBasePath('WorkspaceAgent', 'abc-123', '/agent-studio/'))
      .toBe('agent-studio/agents/workspace-agent/abc-123');
  });
});
