import assert from 'assert';
import { describe, it } from 'node:test';
import {
  createDefaultWorkspaceConfig,
  DEFAULT_WORKSPACE_TOOL_IDS,
  getDefaultWorkspaceSystemPrompt,
  normalizeWorkspaceConfig,
} from '../../src/lib/workspace/defaults';

describe('workspace defaults', () => {
  it('creates new workspaces with the Claude Code canvas contract', () => {
    const config = createDefaultWorkspaceConfig({
      id: 'ws-defaults',
      name: 'Defaults',
      description: 'Workspace description',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    });

    assert.deepEqual(config.tools, [...DEFAULT_WORKSPACE_TOOL_IDS]);
    assert.equal(config.systemPrompt, getDefaultWorkspaceSystemPrompt());
    assert.match(config.systemPrompt, /Claude Code style agent/);
    assert.match(config.systemPrompt, /There is no execute\/read\/write\/filter\/pick\/sort tool/);
  });

  it('normalizes legacy execute-era workspaces to the new defaults', () => {
    const normalized = normalizeWorkspaceConfig({
      id: 'ws-legacy',
      name: 'Legacy',
      description: '',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
      systemPrompt: 'You have an `execute` tool that runs JavaScript code.',
      tools: ['execute', 'read', 'ui.table', 'ui.message', 'custom.tool'],
    });

    assert.deepEqual(normalized.tools, [
      ...DEFAULT_WORKSPACE_TOOL_IDS,
      'custom.tool',
    ]);
    assert.equal(normalized.systemPrompt, getDefaultWorkspaceSystemPrompt());
  });
});
