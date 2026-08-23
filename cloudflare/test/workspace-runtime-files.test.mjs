import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCloudflareStub } from './helpers/env.mjs';

registerCloudflareStub();
const { WorkspaceAgent } = await import('../src/agent/workspace-agent.ts');

const timestamp = Date.parse('2026-08-23T12:00:00.000Z');

function fileEntry(path, name, type, size = 0) {
  return {
    path,
    name,
    type,
    mimeType: type === 'directory' ? 'application/octet-stream' : 'text/plain',
    size,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('runtime listing uses public glob metadata and keeps directories first', async () => {
  const globCalls = [];
  const agent = {
    getRuntimeWorkspace() {
      return {
        glob: async (pattern) => {
          globCalls.push(pattern);
          return [
            fileEntry('/', '', 'directory'),
            fileEntry('/z.txt', 'z.txt', 'file', 3),
            fileEntry('/nested', 'nested', 'directory'),
            { ...fileEntry('/nested/link', 'link', 'symlink'), target: '/z.txt' },
            fileEntry('/nested/a.txt', 'a.txt', 'file', 5),
          ];
        },
        lstat: async () => {
          throw new Error('listing must not issue a redundant lstat');
        },
      };
    },
  };

  const files = await WorkspaceAgent.prototype.listRuntimeFiles.call(agent);

  assert.deepEqual(globCalls, ['/**']);
  assert.deepEqual(files, [
    {
      name: 'nested',
      path: 'nested',
      isDirectory: true,
      size: undefined,
      uploadedAt: '2026-08-23T12:00:00.000Z',
      modifiedAt: '2026-08-23T12:00:00.000Z',
    },
    {
      name: 'a.txt',
      path: 'nested/a.txt',
      isDirectory: false,
      size: 5,
      uploadedAt: '2026-08-23T12:00:00.000Z',
      modifiedAt: '2026-08-23T12:00:00.000Z',
    },
    {
      name: 'z.txt',
      path: 'z.txt',
      isDirectory: false,
      size: 3,
      uploadedAt: '2026-08-23T12:00:00.000Z',
      modifiedAt: '2026-08-23T12:00:00.000Z',
    },
  ]);
});

test('runtime cleanup uses public glob and removes deepest paths first', async () => {
  const globCalls = [];
  const removals = [];
  const agent = {
    getRuntimeWorkspace() {
      return {
        glob: async (pattern) => {
          globCalls.push(pattern);
          return [
            fileEntry('/', '', 'directory'),
            fileEntry('/nested', 'nested', 'directory'),
            fileEntry('/nested/deep', 'deep', 'directory'),
            fileEntry('/nested/deep/file.txt', 'file.txt', 'file', 4),
            { ...fileEntry('/nested/link', 'link', 'symlink'), target: '/nested/deep/file.txt' },
          ];
        },
        rm: async (path, options) => removals.push({ path, options }),
      };
    },
  };

  await WorkspaceAgent.prototype.clearRuntimeFilesUnchecked.call(agent);

  assert.deepEqual(globCalls, ['/**']);
  assert.deepEqual(removals, [
    { path: '/nested/deep/file.txt', options: { recursive: true, force: true } },
    { path: '/nested/deep', options: { recursive: true, force: true } },
    { path: '/nested/link', options: { recursive: true, force: true } },
    { path: '/nested', options: { recursive: true, force: true } },
  ]);
});
