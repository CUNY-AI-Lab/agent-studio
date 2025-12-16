// Client-side API utilities with CSRF protection

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Get CSRF token from cookie
function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(value);
    }
  }
  return null;
}

// Wrapper for fetch that adds CSRF token to mutating requests
export async function apiFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const method = options.method?.toUpperCase() || 'GET';
  const headers = new Headers(options.headers);

  // Add CSRF token for mutating requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  // Prepend basePath for relative URLs
  const fullUrl = url.startsWith('/') ? `${basePath}${url}` : url;

  return fetch(fullUrl, {
    ...options,
    headers,
  });
}

// Convenience methods
export const api = {
  get: (url: string, options?: RequestInit) =>
    apiFetch(url, { ...options, method: 'GET' }),

  post: (url: string, body?: unknown, options?: RequestInit) =>
    apiFetch(url, {
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),

  patch: (url: string, body?: unknown, options?: RequestInit) =>
    apiFetch(url, {
      ...options,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: (url: string, options?: RequestInit) =>
    apiFetch(url, { ...options, method: 'DELETE' }),
};

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, basePath };
