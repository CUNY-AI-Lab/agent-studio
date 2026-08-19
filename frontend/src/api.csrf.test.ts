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
  const documentStub = {
    get cookie() {
      return jar;
    },
    set cookie(value: string) {
      jar = value;
    },
  } satisfies Pick<Document, 'cookie'>;
  vi.stubGlobal('document', documentStub);
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

function authRequiredPayload(loginUrl = '/agent-studio') {
  return {
    error: {
      message: 'Sign in to continue.',
      type: 'authentication_error',
      param: null,
      code: 'authentication_required',
      cail: { login_url: loginUrl, retryable: false },
    },
  };
}

function authRequiredResponse(loginUrl = '/agent-studio') {
  return new Response(JSON.stringify(authRequiredPayload(loginUrl)), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CSRF fetch helper (cookie delivery)', () => {
  it('uses an app-owned header that Doorway can forward', async () => {
    const { CSRF_HEADER } = await loadApi();
    expect(CSRF_HEADER).toBe('X-CSRF-Token');
  });

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

  it('redirects once on a canonical bootstrap auth challenge and retries after failure', async () => {
    const { ensureCsrfToken } = await loadApi();
    const cookie = stubCookie();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://studio.test',
        pathname: '/agent-studio/',
        search: '?gallery=abc',
        assign,
      },
    });
    let attempts = 0;
    const firstResponse = authRequiredResponse();
    const jsonSpy = vi.spyOn(firstResponse, 'json');
    const spy = mockFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        return firstResponse;
      }
      cookie.set(`${CSRF_COOKIE}=${'recovered'.padEnd(64, '0')}`);
      return sessionResponse();
    });

    await expect(ensureCsrfToken()).rejects.toThrow('Sign in to continue.');
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio/?gallery=abc');
    expect(jsonSpy).toHaveBeenCalledOnce();

    const token = await ensureCsrfToken();
    expect(token).toBe('recovered'.padEnd(64, '0'));
    expect(attempts).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['malformed 401', new Response('secret malformed body', { status: 401 })],
    ['non-auth 401', new Response(JSON.stringify({ error: { code: 'invalid_token', message: 'secret details' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })],
    ['server failure', new Response(JSON.stringify({ error: { code: 'internal_error', message: 'secret details' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })],
  ])('does not redirect or leak the body for %s bootstrap failures', async (_label, response) => {
    const { ensureCsrfToken } = await loadApi();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://studio.test',
        pathname: '/agent-studio/',
        search: '?gallery=abc',
        assign,
      },
    });
    mockFetch(() => response);

    const error = await ensureCsrfToken().catch((nextError) => nextError);
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("Agent Studio couldn't start. Reload the page and try again.");
      expect(error.message).not.toContain('secret');
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it('always sends an auth challenge to the standalone Doorway', async () => {
    const { handleAuthRequired } = await loadApi();
    const assign = vi.fn();
    const location = {
      origin: 'https://studio.test',
      pathname: '/agent-studio/',
      search: '?gallery=abc',
      assign,
    };
    vi.stubGlobal('window', { location });

    expect(handleAuthRequired(401, authRequiredPayload('//evil.test/login'))).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio/?gallery=abc');

    assign.mockClear();
    location.pathname = '/agent-studio';
    expect(handleAuthRequired(401, {
      error: { code: 'authentication_required', cail: { login_url: '/agent-studio' } },
    })).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio?gallery=abc');
  });

  it('ignores flat and top-level legacy authentication fields', async () => {
    const { handleAuthRequired } = await loadApi();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://studio.test',
        pathname: '/agent-studio/',
        search: '?gallery=abc',
        assign,
      },
    });

    expect(handleAuthRequired(401, { error: 'authentication_required' })).toBe(false);
    expect(handleAuthRequired(401, {
      error: { code: 'authentication_required' },
      login_url: '/legacy-login',
    })).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio/?gallery=abc');
  });

  it('mutatingFetch attaches the X-CSRF-Token header with the cookie token', async () => {
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

  it('refreshModelCredential posts through the CSRF fetch path and accepts an empty 204', async () => {
    const { refreshModelCredential, CSRF_HEADER } = await loadApi();
    const token = 'r'.repeat(64);
    stubCookie(`${CSRF_COOKIE}=${token}`);
    const spy = mockFetch(() => new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    }));

    await expect(refreshModelCredential('workspace-1')).resolves.toBeUndefined();
    const [input, init] = spy.mock.calls[0];
    expect(String(input)).toContain('/api/workspaces/workspace-1/model-credential');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get(CSRF_HEADER)).toBe(token);
    expect(init?.credentials).toBe('include');
  });

  it('serializes concurrent workspace and gallery reads behind one session bootstrap', async () => {
    const { fetchGalleryItems, fetchWorkspaces } = await loadApi();
    const token = 'a'.repeat(64);
    const cookie = stubCookie();
    let releaseBootstrap!: () => void;
    const bootstrapBlocked = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    // Model the browser cookie jar separately from document.cookie: the
    // session cookie is HttpOnly, while the CSRF cookie is page-readable.
    let sessionCookie: string | null = null;
    const observed: Array<{ path: string; sessionCookie: string | null }> = [];
    const spy = mockFetch(async (input) => {
      const url = new URL(String(input), 'https://studio.test');
      observed.push({ path: `${url.pathname}${url.search}`, sessionCookie });
      if (url.pathname.endsWith('/api/session')) {
        await bootstrapBlocked;
        sessionCookie = 'agent-studio-session=session-a';
        cookie.set(`${CSRF_COOKIE}=${token}`);
        return sessionResponse();
      }
      if (url.pathname.endsWith('/api/workspaces')) {
        return Response.json({ workspaces: [] });
      }
      if (url.pathname.endsWith('/api/gallery')) {
        return Response.json({ items: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const workspaces = fetchWorkspaces();
    const gallery = fetchGalleryItems();
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([{ path: '/api/session', sessionCookie: null }]);

    releaseBootstrap();
    await expect(Promise.all([workspaces, gallery])).resolves.toEqual([[], []]);

    expect(observed.filter(({ path }) => path === '/api/session')).toHaveLength(1);
    const reads = observed.filter(({ path }) => path.startsWith('/api/workspaces') || path.startsWith('/api/gallery'));
    expect(reads).toHaveLength(2);
    expect(reads.every(({ sessionCookie: value }) => value === 'agent-studio-session=session-a')).toBe(true);
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

  it('readingFetch attaches the X-CSRF-Token header with the cookie token', async () => {
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
        ? new Response(JSON.stringify({ error: { code: 'csrf_token_invalid', message: 'CSRF token is invalid.' } }), {
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

  it('no file or preview URL exposes the CSRF capability', async () => {
    const token = 'query token/value';
    stubCookie(`${CSRF_COOKIE}=${encodeURIComponent(token)}`);
    const {
      getGalleryFileUrl,
      getGalleryPanelPreviewUrl,
      getWorkspaceFileUrl,
    } = await loadApi();

    expect(getWorkspaceFileUrl('ws', 'notes/read me.md')).toBe(
      '/api/workspaces/ws/files/notes/read%20me.md',
    );
    expect(getWorkspaceFileUrl('ws', 'notes/read me.md')).not.toContain('csrfToken=');
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
