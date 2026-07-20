function normalizeBase(raw: string): string {
  if (raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

/** Prefix a root-relative application path with Vite's deployed base path. */
export function appPath(
  pathname: string,
  baseUrl = import.meta.env.BASE_URL || '/',
): string {
  if (!pathname.startsWith('/')) throw new Error('Application path must start with /');
  return `${normalizeBase(baseUrl)}${pathname}`;
}

/**
 * Full Agents SDK route prefix, bypassing its root-absolute URL builder.
 *
 * PartySocket always inserts the slash between host and basePath, so this
 * value must not start with one. HTTP application paths still remain
 * root-relative through appPath().
 */
export function agentBasePath(
  agentClass: string,
  agentName: string,
  baseUrl = import.meta.env.BASE_URL || '/',
): string {
  const agent = agentClass
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return appPath(
    `/agents/${agent}/${encodeURIComponent(agentName)}`,
    baseUrl,
  ).replace(/^\/+/, '');
}
