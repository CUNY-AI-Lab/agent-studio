import { describe, expect, it } from 'vitest';
import type { WorkspaceRecord } from '../types';
import { reconcileWorkspaceDraft } from './workspaceDraft';

const previous: WorkspaceRecord = {
  id: 'workspace-1',
  name: 'New Workspace',
  description: '',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  model: '@cf/openai/gpt-oss-20b',
};

const next: WorkspaceRecord = {
  ...previous,
  name: 'Researching title ownership',
  description: 'A model-named workspace',
  model: '@cf/zai-org/glm-5.2',
};

describe('reconcileWorkspaceDraft', () => {
  it('updates every clean local field from the DO state', () => {
    expect(reconcileWorkspaceDraft(
      {
        name: previous.name,
        description: previous.description,
        model: previous.model,
      },
      previous,
      next,
    )).toEqual({
      name: next.name,
      description: next.description,
      model: next.model,
    });
  });

  it('keeps a dirty field while applying independent clean fields', () => {
    expect(reconcileWorkspaceDraft(
      {
        name: 'My manual title',
        description: previous.description,
        model: previous.model,
      },
      previous,
      next,
    )).toEqual({
      name: 'My manual title',
      description: next.description,
      model: next.model,
    });
  });
});
