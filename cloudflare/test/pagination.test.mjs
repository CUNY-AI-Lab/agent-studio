import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listWorkspaceFiles } from '../src/lib/files.ts';
import { listWorkspaces } from '../src/lib/workspaces.ts';

class PagingR2 {
  constructor(pageSize = 2) {
    this.pageSize = pageSize;
    this.store = new Map();
    this.etag = 0;
  }

  async put(key, value) {
    const bytes = new TextEncoder().encode(String(value));
    const entry = { bytes, etag: String(this.etag += 1), uploaded: new Date(0) };
    this.store.set(key, entry);
    return { key, size: bytes.byteLength, etag: entry.etag, uploaded: entry.uploaded };
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      json: async () => JSON.parse(new TextDecoder().decode(entry.bytes)),
    };
  }

  async list({ prefix = '', delimiter, cursor } = {}) {
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const objects = [];
    const delimitedPrefixes = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const delimiterIndex = delimiter ? rest.indexOf(delimiter) : -1;
      if (delimiter && delimiterIndex >= 0) {
        delimitedPrefixes.add(prefix + rest.slice(0, delimiterIndex + 1));
      } else {
        const entry = this.store.get(key);
        objects.push({
          key,
          size: entry.bytes.byteLength,
          etag: entry.etag,
          uploaded: entry.uploaded,
        });
      }
    }

    const entries = [
      ...objects.map((object) => ({ kind: 'object', key: object.key, object })),
      ...[...delimitedPrefixes].map((key) => ({ kind: 'prefix', key })),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const offset = cursor ? Number(cursor) : 0;
    const page = entries.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < entries.length;

    return {
      objects: page.filter((entry) => entry.kind === 'object').map((entry) => entry.object),
      delimitedPrefixes: page.filter((entry) => entry.kind === 'prefix').map((entry) => entry.key),
      truncated,
      cursor: truncated ? String(nextOffset) : undefined,
    };
  }
}

test('listWorkspaces accumulates delimited prefixes across every R2 page', async () => {
  const r2 = new PagingR2();
  const env = { WORKSPACE_FILES: r2 };
  const sessionId = 'a'.repeat(32);
  const ids = ['ws-a', 'ws-b', 'ws-c', 'ws-d', 'ws-e'];

  for (const [index, id] of ids.entries()) {
    const workspace = {
      id,
      name: id,
      description: '',
      createdAt: new Date(index).toISOString(),
      updatedAt: new Date(index).toISOString(),
    };
    await r2.put(
      `agent-studio/sessions/${sessionId}/workspaces/${id}/workspace.json`,
      JSON.stringify(workspace),
    );
  }

  const workspaces = await listWorkspaces(env, sessionId);
  assert.deepEqual(workspaces.map((workspace) => workspace.id).sort(), ids);
});

test('listWorkspaceFiles accumulates objects across every R2 page', async () => {
  const r2 = new PagingR2();
  const env = { WORKSPACE_FILES: r2 };
  const sessionId = 'b'.repeat(32);
  const workspaceId = 'workspace';
  const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];

  for (const path of paths) {
    await r2.put(
      `agent-studio/sessions/${sessionId}/workspaces/${workspaceId}/files/${path}`,
      path,
    );
  }

  const files = await listWorkspaceFiles(env, sessionId, workspaceId);
  assert.deepEqual(files.map((file) => file.path), paths);
});
