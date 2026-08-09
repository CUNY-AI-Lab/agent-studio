import { deleteByPrefix, getWorkspacePrefix } from './files';
import { nextR2Cursor } from './r2-pagination';
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

export interface ReadDownloadsOptions {
  /**
   * What to do when a download object EXISTS in R2 but cannot be parsed (or
   * fails the shape check). A missing object is always treated as "no
   * downloads" — that is the only case that genuinely means absence.
   *
   * - 'skip' (default): log the corrupt key and omit that entry, so one bad
   *   object cannot take down the whole listing. Used by the read/serve
   *   routes, where partial results beat a 500 for content the user can
   *   regenerate.
   * - 'throw': log and propagate an error. Used by the first-login migration,
   *   where a corrupt record must NOT be read as "nothing to migrate": the
   *   anonymous namespace is deleted after migration, so silently equating
   *   corruption with absence would permanently drop queued deliverables.
   *   Throwing routes into the migration's fail-and-retry path instead.
   */
  onCorrupt?: 'skip' | 'throw';
}

export const MAX_DOWNLOAD_CORRUPT_EVENTS_PER_READ = 20;

interface CorruptEventBudget {
  remaining: number;
}

function reportCorruptDownloadObject(
  key: string,
  error: unknown,
  onCorrupt: 'skip' | 'throw',
  eventBudget: CorruptEventBudget,
): void {
  eventBudget.remaining = Math.max(0, eventBudget.remaining - 1);
  if (onCorrupt === 'throw') {
    throw new Error(`downloads: corrupt stored download object at ${key}`, { cause: error });
  }
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


export async function getWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
  options: ReadDownloadsOptions = {}
): Promise<DownloadRequest[]> {
  const onCorrupt = options.onCorrupt ?? 'skip';
  const eventBudget: CorruptEventBudget = { remaining: MAX_DOWNLOAD_CORRUPT_EVENTS_PER_READ };
  const prefix = getDownloadsPrefix(sessionId, workspaceId);
  const stored: StoredDownload[] = [];

  let cursor: string | undefined;
  do {
    const listing = await env.WORKSPACE_FILES.list({ prefix, cursor });
    const objects = await Promise.all(
      listing.objects.map(async (object) => {
        const body = await env.WORKSPACE_FILES.get(object.key);
        // Absent despite being listed = deleted between list and get (e.g. a
        // concurrent clear) — genuinely gone, safe to skip silently.
        if (!body) return null;
        let parsed: StoredDownload;
        try {
          parsed = await body.json<StoredDownload>();
        } catch (error) {
          reportCorruptDownloadObject(object.key, error, onCorrupt, eventBudget);
          return null;
        }
        if (!(parsed && typeof parsed === 'object' && parsed.download)) {
          reportCorruptDownloadObject(
            object.key,
            new Error('missing download payload'),
            onCorrupt,
            eventBudget
          );
          return null;
        }
        return { key: object.key, value: parsed };
      })
    );
    for (const entry of objects) {
      if (entry) stored.push(entry.value);
    }
    cursor = nextR2Cursor(listing, 'download listing');
  } while (cursor);

  stored.sort((left, right) => left.seq - right.seq);
  return stored.map((entry) => entry.download);
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
}

/** Replace the current per-object queue with a deterministic ordered set. */
export async function putWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
  downloads: DownloadRequest[],
): Promise<void> {
  const prefix = getDownloadsPrefix(sessionId, workspaceId);
  for (const [index, download] of downloads.entries()) {
    const stored: StoredDownload = {
      seq: index,
      createdAt: new Date(0).toISOString(),
      download,
    };
    await env.WORKSPACE_FILES.put(
      `${prefix}import-${String(index).padStart(8, '0')}.json`,
      JSON.stringify(stored),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
    );
  }
}
