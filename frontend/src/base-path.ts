const normalizedBase = (() => {
  const raw = import.meta.env.BASE_URL || '/';
  if (raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
})();

/** Prefix a root-relative application path with Vite's deployed base path. */
export function appPath(pathname: string): string {
  if (!pathname.startsWith('/')) throw new Error('Application path must start with /');
  return `${normalizedBase}${pathname}`;
}

/** Full Agents SDK route prefix, bypassing its root-absolute URL builder. */
export function agentBasePath(agentClass: string, agentName: string): string {
  const agent = agentClass
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return appPath(`/agents/${agent}/${encodeURIComponent(agentName)}`);
}
