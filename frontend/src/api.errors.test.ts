import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fetchWorkspaceExport and parseJson share the canonical CAIL error extraction
// so their user-facing failures cannot silently drift apart.

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

  it('surfaces the canonical nested error envelope message', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return jsonResponse({
          error: {
            code: 'not_found',
            message: 'Workspace not found',
            type: 'invalid_request_error',
            retryable: false,
          },
        }, 404);
      }
      return jsonResponse({}, 200);
    });
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow('Workspace not found');
  });

  it('redirects to sign-in when an export hits an expired session', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://studio.test',
        pathname: '/agent-studio/',
        search: '?workspace=ws-1',
        assign,
      },
    });
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return jsonResponse({
          error: {
            code: 'authentication_required',
            message: 'Sign in to continue.',
            type: 'authentication_error',
            cail: { login_url: '/agent-studio' },
          },
        }, 401);
      }
      return jsonResponse({}, 200);
    });

    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow('Sign in to continue.');
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio/?workspace=ws-1');
  });

  it('uses a status fallback for a noncanonical JSON error body', async () => {
    const { fetchWorkspaceExport } = await loadApi();
    mockFetch((input) => {
      if (String(input).includes('/export')) {
        return jsonResponse({ message: 'Export failed upstream' }, 500);
      }
      return jsonResponse({}, 200);
    });
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow("That didn't work. Try again.");
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
    await expect(fetchWorkspaceExport('ws-1')).rejects.toThrow("That didn't work. Try again.");
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

describe('fetchModels quota errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws ModelsQuotaError with the worker quota message for a 429', async () => {
    const { fetchModels, ModelsQuotaError } = await loadApi();
    mockFetch(() => jsonResponse({
      error: {
        code: 'quota_exceeded',
        message: 'You have used your $10 monthly AI budget.',
        type: 'rate_limit_error',
        retryable: false,
      },
    }, 429));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(ModelsQuotaError);
    expect(error).toHaveProperty('message', 'You have used your $10 monthly AI budget.');
  });

  it('redirects expired model authentication to the standalone Doorway', async () => {
    const { fetchModels, ModelsAuthError } = await loadApi();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://agent-studio.workers.dev',
        pathname: '/agent-studio/',
        search: '?workspace=ws-1',
        assign,
      },
    });
    mockFetch(() => jsonResponse({
      error: {
        code: 'authentication_required',
        message: 'Sign in to continue.',
        type: 'authentication_error',
        cail: { login_url: '/agent-studio' },
      },
    }, 401));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(ModelsAuthError);
    expect(error).toHaveProperty('message', 'Your sign-in expired. Sign in again to load models.');
    expect(assign).toHaveBeenCalledWith('https://cail-doorway.ailab-452.workers.dev/agent-studio/?workspace=ws-1');
  });

  it('keeps non-authentication 401s as plain model errors', async () => {
    const { fetchModels, ModelsAuthError } = await loadApi();
    mockFetch(() => jsonResponse({
      error: {
        code: 'invalid_token',
        message: 'Model credential rejected.',
      },
    }, 401));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelsAuthError);
    expect(error).toHaveProperty('message', 'Model credential rejected.');
  });

  it('throws typed ModelsUnavailableError for 5xx so a broken deployment surfaces', async () => {
    const { fetchModels, ModelsQuotaError, ModelsUnavailableError } = await loadApi();
    mockFetch(() => jsonResponse({
      error: {
        code: 'internal_error',
        message: 'Catalog failed upstream',
        type: 'api_error',
        retryable: true,
      },
    }, 500));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(ModelsUnavailableError);
    expect(error).not.toBeInstanceOf(ModelsQuotaError);
    expect(error).toHaveProperty('message', 'Catalog failed upstream');
  });

  it('throws ModelsUnavailableError for the deliberate 502 config-drift response', async () => {
    const { fetchModels, ModelsUnavailableError } = await loadApi();
    mockFetch(() => jsonResponse({
      error: {
        code: 'upstream_error',
        message: "Couldn't load the model list.",
        type: 'api_error',
        retryable: false,
      },
    }, 502));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(ModelsUnavailableError);
  });

  it('keeps non-429, non-5xx failures as plain errors', async () => {
    const { fetchModels, ModelsQuotaError, ModelsUnavailableError } = await loadApi();
    mockFetch(() => jsonResponse({ message: 'Not found' }, 404));

    const error = await fetchModels().catch((nextError: unknown) => nextError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelsQuotaError);
    expect(error).not.toBeInstanceOf(ModelsUnavailableError);
  });
});
