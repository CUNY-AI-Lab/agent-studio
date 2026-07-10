import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wave item 5: fetchWorkspaceExport's error branch was a hand-rolled copy of
// parseJson's error extraction that only read `payload.error` and skipped the
// `payload.message` fallback. Both now share readResponseError(). These tests
// characterize the aligned error extraction (the export error path was
// previously untested) so it can't silently drift from parseJson again.

async function loadApi() {
  vi.resetModules();
  return import('./api');
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchWorkspaceExport error extraction (aligned with parseJson)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('document', {
      cookie: `cail_csrf_agentstudio=${'a'.repeat(64)}`,
    } as Document);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces the worker `{ error }` envelope message', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return jsonResponse({ error: 'Workspace not found' }, 404);
      }
      return jsonResponse({}, 200);
    });
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow('Workspace not found');
  });

  it('surfaces a `{ message }` envelope too (the branch the old inline copy missed)', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return jsonResponse({ message: 'Export failed upstream' }, 500);
      }
      return jsonResponse({}, 200);
    });
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow('Export failed upstream');
  });

  it('falls back to a status string when the error body is not JSON', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return new Response('<html>gateway error</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return jsonResponse({}, 200);
    });
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow('Request failed with 502');
  });

  it('returns the blob + parsed filename on success', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return new Response('{"version":1}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="my-space.agent-studio.json"',
          },
        });
      }
      return jsonResponse({}, 200);
    });
    const { blob, filename } = await fetchWorkspaceExport('ws-1');
    // Response.blob() comes from undici's realm under Vitest, so instanceof the
    // jsdom Blob constructor is false even though the returned object is valid.
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{"version":1}');
    expect(filename).toBe('my-space.agent-studio.json');
  });
});
