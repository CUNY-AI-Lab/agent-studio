import { deleteByPrefix, getWorkspacePrefix } from './files';
import type { Env } from '../env';

export interface DownloadRequest {
  filename: string;
  data: unknown;
  format: 'csv' | 'json' | 'txt';
}

// Each queued download is stored as its OWN R2 object under `downloads/`, so
// appending is a plain PUT of a uniquely-keyed object — no read-modify-write and
// therefore no lost-write race under concurrent `addWorkspaceDownload` calls
// (AS-2-4). Reading lists the prefix, gets each object, and sorts by the stored
// sequence. Clearing deletes the whole prefix.
//
// The object key embeds a zero-padded creation timestamp plus a per-process
// counter and a random suffix, so keys sort chronologically (R2 list returns
// keys sorted) and never collide even within the same millisecond.

interface StoredDownload {
  seq: number;
  createdAt: string;
  download: DownloadRequest;
}

// Legacy single-blob key, kept only for backward reads (see getWorkspaceDownloads).
function getLegacyDownloadsKey(sessionId: string, workspaceId: string): string {
  return `${getWorkspacePrefix(sessionId, workspaceId)}downloads.json`;
}

function getDownloadsPrefix(sessionId: string, workspaceId: string): string {
  return `${getWorkspacePrefix(sessionId, workspaceId)}downloads/`;
}

let downloadCounter = 0;

function nextSequence(): number {
  // Date.now() is fine here: these run in the Worker request context, not the
  // restricted workflow-script context. Monotonic within a process; ties broken
  // by the random key suffix.
  return Date.now();
}

function makeDownloadKey(sessionId: string, workspaceId: string, seq: number): string {
  // Zero-pad seq to 16 digits so lexical order matches numeric order, then add a
  // monotonic counter + random suffix to guarantee uniqueness under bursts.
  const paddedSeq = String(seq).padStart(16, '0');
  const ordinal = String((downloadCounter = (downloadCounter + 1) % 1_000_000)).padStart(6, '0');
  const random = Math.random().toString(36).slice(2, 10);
  return `${getDownloadsPrefix(sessionId, workspaceId)}${paddedSeq}-${ordinal}-${random}.json`;
}

async function readLegacyDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<DownloadRequest[]> {
  const object = await env.WORKSPACE_FILES.get(getLegacyDownloadsKey(sessionId, workspaceId));
  if (!object) return [];
  try {
    const parsed = await object.json<DownloadRequest[]>();
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<DownloadRequest[]> {
  const prefix = getDownloadsPrefix(sessionId, workspaceId);
  const stored: StoredDownload[] = [];

  let cursor: string | undefined;
  do {
    const listing = await env.WORKSPACE_FILES.list({ prefix, cursor });
    const objects = await Promise.all(
      listing.objects.map(async (object) => {
        const body = await env.WORKSPACE_FILES.get(object.key);
        if (!body) return null;
        try {
          const parsed = await body.json<StoredDownload>();
          if (parsed && typeof parsed === 'object' && parsed.download) {
            return { key: object.key, value: parsed };
          }
        } catch {
          // ignore malformed objects
        }
        return null;
      })
    );
    for (const entry of objects) {
      if (entry) stored.push(entry.value);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  stored.sort((left, right) => left.seq - right.seq);
  const current = stored.map((entry) => entry.download);

  // Backward-read: fold in any pre-migration downloads.json content, preserving
  // its order ahead of the per-object entries. New writes only ever go to the
  // per-object prefix, so this blob is read-only legacy.
  const legacy = await readLegacyDownloads(env, sessionId, workspaceId);
  return legacy.length > 0 ? [...legacy, ...current] : current;
}

export async function addWorkspaceDownload(
  env: Env,
  sessionId: string,
  workspaceId: string,
  download: DownloadRequest
): Promise<void> {
  const seq = nextSequence();
  const stored: StoredDownload = {
    seq,
    createdAt: new Date(seq).toISOString(),
    download,
  };
  // Pure PUT of a fresh, uniquely-keyed object: concurrent adds cannot clobber
  // one another.
  await env.WORKSPACE_FILES.put(
    makeDownloadKey(sessionId, workspaceId, seq),
    JSON.stringify(stored),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
  );
}

export async function clearWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  await deleteByPrefix(env, getDownloadsPrefix(sessionId, workspaceId));
  // Also drop any legacy single-blob so a cleared workspace stays cleared.
  await env.WORKSPACE_FILES.delete(getLegacyDownloadsKey(sessionId, workspaceId));
}

/**
 * Bulk-write a set of downloads as individual per-object entries. Used by the
 * first-login migration to carry queued downloads from the anonymous namespace
 * to the subject namespace. Preserves order via a monotonic sequence.
 */
export async function putWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
  downloads: DownloadRequest[]
): Promise<void> {
  // Replace whatever is there so this is a faithful "set the list" operation.
  await clearWorkspaceDownloads(env, sessionId, workspaceId);
  let seq = nextSequence();
  for (const download of downloads) {
    const stored: StoredDownload = {
      seq,
      createdAt: new Date(seq).toISOString(),
      download,
    };
    await env.WORKSPACE_FILES.put(
      makeDownloadKey(sessionId, workspaceId, seq),
      JSON.stringify(stored),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
    seq += 1;
  }
}
