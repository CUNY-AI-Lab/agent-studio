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

function sessionResponse(token = 'a'.repeat(64)) {
  return new Response(JSON.stringify({ sessionId: 'deadbeef'.repeat(4), csrfToken: token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CSRF fetch helper', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensureCsrfToken fetches /api/session once and caches the token', async () => {
    const { ensureCsrfToken } = await loadApi();
    const spy = mockFetch(() => sessionResponse('t0ken'.padEnd(64, '0')));

    const first = await ensureCsrfToken();
    const second = await ensureCsrfToken();

    expect(first).toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('/api/session');
  });

  it('mutatingFetch attaches the X-CAIL-CSRF header with the fetched token', async () => {
    const { mutatingFetch, CSRF_HEADER } = await loadApi();
    const token = 'b'.repeat(64);
    const spy = mockFetch((input) => {
      if (String(input).includes('/api/session')) return sessionResponse(token);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await mutatingFetch('/api/workspaces', { method: 'POST', body: '{}' });

    // Two calls: the bootstrap GET, then the mutation carrying the header.
    const mutationCall = spy.mock.calls.find((call) => String(call[0]).includes('/api/workspaces'));
    expect(mutationCall).toBeTruthy();
    const headers = new Headers(mutationCall![1]?.headers);
    expect(headers.get(CSRF_HEADER)).toBe(token);
    // credentials:'include' is forced so the session cookie always rides along.
    expect(mutationCall![1]?.credentials).toBe('include');
  });

  it('mutatingFetch preserves caller-supplied headers alongside the token', async () => {
    const { mutatingFetch, CSRF_HEADER } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/api/session')) return sessionResponse();
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

  it('a failed bootstrap is not cached and is retried on the next call', async () => {
    const { ensureCsrfToken } = await loadApi();
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      if (attempt === 1) return new Response('nope', { status: 500 });
      return sessionResponse('recovered'.padEnd(64, '0'));
    });

    await expect(ensureCsrfToken()).rejects.toThrow();
    const token = await ensureCsrfToken();
    expect(token).toBe('recovered'.padEnd(64, '0'));
    expect(attempt).toBe(2);
  });
});
