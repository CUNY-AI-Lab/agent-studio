import assert from 'assert';
import { describe, it } from 'node:test';
import {
  createWorkspaceRunner,
} from '../../src/lib/runtime';

describe('runtime runner factory', () => {
  it('creates the remote runner from the factory', () => {
    process.env.WORKSPACE_RUNNER_BASE_URL = 'http://127.0.0.1:3200';
    const runner = createWorkspaceRunner(
      {
        id: 'ws-runner',
        name: 'Runner',
        description: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        systemPrompt: '',
        tools: [],
      },
      { basePath: '/tmp/agent-studio-test' } as { basePath: string } & Parameters<typeof createWorkspaceRunner>[1]
    );

    assert.equal(runner.config.id, 'ws-runner');
    assert.equal(typeof runner.query, 'function');
    delete process.env.WORKSPACE_RUNNER_BASE_URL;
  });
});
