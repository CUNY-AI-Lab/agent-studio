import { describe, expect, it } from 'vitest';
import type { WorkspaceRecord } from '../types';
import { replaceWorkspaceInHomeList } from './workspaceHome';

const first: WorkspaceRecord = {
  id: 'workspace-1',
  name: 'New Workspace',
  description: '',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

const second: WorkspaceRecord = {
  ...first,
  id: 'workspace-2',
  name: 'Other workspace',
};

describe('replaceWorkspaceInHomeList', () => {
  it('updates only home-list metadata and leaves other entries intact', () => {
    const next = { ...first, name: 'Model-named workspace' };
    const result = replaceWorkspaceInHomeList([first, second], next);

    expect(result).toEqual([next, second]);
    expect(result[1]).toBe(second);
  });

  it('does not create a parent refresh when metadata is unchanged', () => {
    const current = [first];
    expect(replaceWorkspaceInHomeList(current, { ...first })).toBe(current);
  });
});
