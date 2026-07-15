/** Normalize the one URL prefix used by assets, HTTP APIs, and Agent sockets. */
export function normalizeBasePath(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw || raw === '/') return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, '') || '/';
}

/** True when a base path is safe to use as a URL and cookie path prefix. */
export function isValidBasePath(value: string | undefined): boolean {
  const normalized = normalizeBasePath(value);
  if (normalized === '/') return true;
  if (normalized.includes('//') || normalized.includes('%')) return false;
  return normalized
    .slice(1)
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'
      && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment));
}

/** Prefix an application-relative absolute path with the configured mount. */
export function withBasePath(pathname: string, value: string | undefined): string {
  if (!pathname.startsWith('/')) throw new Error('Application path must start with /');
  const basePath = normalizeBasePath(value);
  if (basePath === '/') return pathname;
  return pathname === '/' ? `${basePath}/` : `${basePath}${pathname}`;
}

/**
 * Rewrite an externally mounted request to the root-relative path expected by
 * Hono, the Agents SDK, and the static asset binding. Requests outside the
 * configured mount return null and must not reach any application surface.
 */
export function stripBasePath(request: Request, value: string | undefined): Request | null {
  const basePath = normalizeBasePath(value);
  if (basePath === '/') return request;

  const url = new URL(request.url);
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  url.pathname = url.pathname === basePath ? '/' : url.pathname.slice(basePath.length);
  return new Request(url, request);
}
