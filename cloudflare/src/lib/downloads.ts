import { deleteByPrefix, getWorkspacePrefix } from './files';
import { legacyAccountCompatibilityAllowed, type Env } from '../env';
import { LOG_PRODUCT, STUDIO_EVENTS, studioLogger } from './logging';

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
  /** Testable clock for the temporary legacy-blob compatibility window. */
  now?: number;
}

// Every corrupt-object sighting is logged — a parse failure on an existing
// object is never silently equated with absence. The structured event is
// metadata only (the R2 key embeds session/workspace ids + a filename, which
// are not on the safe-to-log allowlist); the 'throw' path keeps the key in
// the thrown Error so the migration's fail-and-retry path stays actionable.
function reportCorruptDownloadObject(
  env: Env,
  key: string,
  error: unknown,
  onCorrupt: 'skip' | 'throw'
): void {
  studioLogger(env).emit(STUDIO_EVENTS.DOWNLOAD_CORRUPT, {
    product_id: LOG_PRODUCT,
    terminal: { outcome: 'error', reason: 'application_failure' },
    error_type: 'corrupt_download_object',
  });
  if (onCorrupt === 'throw') {
    throw new Error(`downloads: corrupt stored download object at ${key}`, { cause: error });
  }
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
  workspaceId: string,
  onCorrupt: 'skip' | 'throw'
): Promise<DownloadRequest[]> {
  const key = getLegacyDownloadsKey(sessionId, workspaceId);
  const object = await env.WORKSPACE_FILES.get(key);
  // No object at the legacy key is the one case that truly means "no legacy
  // downloads". Anything past this point is an existing object that must
  // parse; failures are reported, never silently read as empty.
  if (!object) return [];
  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch (error) {
    reportCorruptDownloadObject(env, key, error, onCorrupt);
    return [];
  }
  if (!Array.isArray(parsed)) {
    reportCorruptDownloadObject(env, key, new Error('expected a JSON array'), onCorrupt);
    return [];
  }
  return parsed as DownloadRequest[];
}

export async function getWorkspaceDownloads(
  env: Env,
  sessionId: string,
  workspaceId: string,
  options: ReadDownloadsOptions = {}
): Promise<DownloadRequest[]> {
  const onCorrupt = options.onCorrupt ?? 'skip';
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
          reportCorruptDownloadObject(env, object.key, error, onCorrupt);
          return null;
        }
        if (!(parsed && typeof parsed === 'object' && parsed.download)) {
          reportCorruptDownloadObject(
            env,
            object.key,
            new Error('missing download payload'),
            onCorrupt
          );
          return null;
        }
        return { key: object.key, value: parsed };
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
  const legacy = legacyAccountCompatibilityAllowed(env, options.now)
    ? await readLegacyDownloads(env, sessionId, workspaceId, onCorrupt)
    : [];
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
