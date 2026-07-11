import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CSRF token cache is module-level, so each test imports a fresh module
// instance (vi.resetModules) to start from an unfetched state.
async function loadApi() {
  vi.resetModules();
  return import('./api');
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * Stub document.cookie (delivery amendment 2026-07-05: the token arrives via a
 * path-scoped Set-Cookie and the page reads it from document.cookie — the JSON
 * body no longer carries it). `set(value)` simulates the worker's Set-Cookie.
 */
function stubCookie(initial = '') {
  let jar = initial;
  vi.stubGlobal('document', {
    get cookie() {
      return jar;
    },
    set cookie(value: string) {
      jar = value;
    },
  } as unknown as Document);
  return {
    set: (value: string) => {
      jar = value;
    },
  };
}

const CSRF_COOKIE = 'cail_csrf_agentstudio';

/** A body with only sessionId — the token is delivered out-of-band via cookie. */
function sessionResponse() {
  return new Response(JSON.stringify({ sessionId: 'deadbeef'.repeat(4) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CSRF fetch helper (cookie delivery)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensureCsrfToken reads the token from document.cookie set by the bootstrap GET', async () => {
    const { ensureCsrfToken } = await loadApi();
    const token = 't0ken'.padEnd(64, '0');
    const cookie = stubCookie();
    const spy = mockFetch(() => {
      // The worker's Set-Cookie is observed by the browser as document.cookie.
      cookie.set(`${CSRF_COOKIE}=${token}`);
      return sessionResponse();
    });

    const first = await ensureCsrfToken();
    expect(first).toBe(token);
    expect(String(spy.mock.calls[0][0])).toContain('/api/session');
  });

  it('ensureCsrfToken uses an already-present cookie without a network round-trip', async () => {
    const { ensureCsrfToken } = await loadApi();
    const token = 'c'.repeat(64);
    stubCookie(`${CSRF_COOKIE}=${token}`);
    const spy = mockFetch(() => sessionResponse());

    const value = await ensureCsrfToken();
    expect(value).toBe(token);
    // Cookie was already there, so no /api/session fetch was needed.
    expect(spy).not.toHaveBeenCalled();
  });

  it('mutatingFetch attaches the X-CAIL-CSRF header with the cookie token', async () => {
    const { mutatingFetch, CSRF_HEADER } = await loadApi();
    const token = 'b'.repeat(64);
    const cookie = stubCookie();
    const spy = mockFetch((input) => {
      if (String(input).includes('/api/session')) {
        cookie.set(`${CSRF_COOKIE}=${token}`);
        return sessionResponse();
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await mutatingFetch('/api/workspaces', { method: 'POST', body: '{}' });

    const mutationCall = spy.mock.calls.find((call) => String(call[0]).includes('/api/workspaces'));
    expect(mutationCall).toBeTruthy();
    const headers = new Headers(mutationCall![1]?.headers);
    expect(headers.get(CSRF_HEADER)).toBe(token);
    // credentials:'include' is forced so the session cookie always rides along.
    expect(mutationCall![1]?.credentials).toBe('include');
  });

  it('mutatingFetch preserves caller-supplied headers alongside the token', async () => {
    const { mutatingFetch, CSRF_HEADER } = await loadApi();
    const cookie = stubCookie();
    mockFetch((input) => {
      if (String(input).includes('/api/session')) {
        cookie.set(`${CSRF_COOKIE}=${'d'.repeat(64)}`);
        return sessionResponse();
      }
      return new Response('{}', { status: 200 });
    });

    const spy = vi.mocked(fetch);
    await mutatingFetch('/api/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    });

    const call = spy.mock.calls.find((c) => String(c[0]).includes('/api/x'));
    const headers = new Headers(call![1]?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get(CSRF_HEADER)).toBeTruthy();
  });

  it('readingFetch attaches the X-CAIL-CSRF header with the cookie token', async () => {
    const { readingFetch, CSRF_HEADER } = await loadApi();
    const token = 'e'.repeat(64);
    stubCookie(`${CSRF_COOKIE}=${token}`);
    const spy = mockFetch(() => new Response('{}', { status: 200 }));

    await readingFetch('/api/workspaces');

    const call = spy.mock.calls[0];
    const headers = new Headers(call[1]?.headers);
    expect(headers.get(CSRF_HEADER)).toBe(token);
    expect(call[1]?.credentials).toBe('include');
  });

  it('refreshes a stale token once when the worker rotates the session', async () => {
    const { readingFetch, CSRF_HEADER } = await loadApi();
    const oldToken = 'e'.repeat(64);
    const newToken = 'f'.repeat(64);
    const cookie = stubCookie(`${CSRF_COOKIE}=${oldToken}`);
    const spy = mockFetch((input) => {
      if (String(input).includes('/api/session')) {
        cookie.set(`${CSRF_COOKIE}=${newToken}`);
        return sessionResponse();
      }
      const workspaceCalls = spy.mock.calls.filter((call) => String(call[0]).includes('/api/workspaces'));
      return workspaceCalls.length === 1
        ? new Response(JSON.stringify({ error: 'csrf_token_invalid' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('{}', { status: 200 });
    });

    const response = await readingFetch('/api/workspaces');

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    const workspaceCalls = spy.mock.calls.filter((call) => String(call[0]).includes('/api/workspaces'));
    expect(new Headers(workspaceCalls[0][1]?.headers).get(CSRF_HEADER)).toBe(oldToken);
    expect(new Headers(workspaceCalls[1][1]?.headers).get(CSRF_HEADER)).toBe(newToken);
  });

  it('workspace element URLs include the cookie token while gallery URLs stay public', async () => {
    const token = 'query token/value';
    stubCookie(`${CSRF_COOKIE}=${encodeURIComponent(token)}`);
    const {
      getGalleryFileUrl,
      getGalleryPanelPreviewUrl,
      getWorkspaceFileUrl,
      getWorkspacePanelPreviewUrl,
    } = await loadApi();

    expect(getWorkspaceFileUrl('ws', 'notes/read me.md')).toBe(
      `/api/workspaces/ws/files/notes/read%20me.md?csrfToken=${encodeURIComponent(token)}`,
    );
    expect(getWorkspacePanelPreviewUrl('ws', 'panel one')).toBe(
      `/api/workspaces/ws/panels/panel%20one/preview?csrfToken=${encodeURIComponent(token)}`,
    );
    expect(getGalleryFileUrl('gallery', 'notes/read me.md')).not.toContain('csrfToken=');
    expect(getGalleryPanelPreviewUrl('gallery', 'panel one')).not.toContain('csrfToken=');
  });

  it('a bootstrap that sets no cookie rejects and is not cached (retried next call)', async () => {
    const { ensureCsrfToken } = await loadApi();
    const cookie = stubCookie();
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        // First bootstrap fails to set the cookie -> ensure must throw.
        return sessionResponse();
      }
      cookie.set(`${CSRF_COOKIE}=${'recovered'.padEnd(64, '0')}`);
      return sessionResponse();
    });

    await expect(ensureCsrfToken()).rejects.toThrow();
    const token = await ensureCsrfToken();
    expect(token).toBe('recovered'.padEnd(64, '0'));
    expect(attempt).toBe(2);
  });
});
