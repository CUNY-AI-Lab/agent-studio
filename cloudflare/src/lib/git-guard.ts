import { z } from 'zod';

const GIT_AUTH_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push']);
const callableSchema = z.function();

export function parseGitAllowedHosts(env: { GIT_AUTH_ALLOWED_HOSTS?: string }): string[] {
  return (env.GIT_AUTH_ALLOWED_HOSTS ?? '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

/** True only for an HTTPS URL whose host is on the allowlist. */
export function gitHostAllowed(url: string | null | undefined, allowedHosts: string[]): boolean {
  const candidate = z.string().safeParse(url).data;
  if (!candidate || allowedHosts.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  // Never attach a bearer-equivalent token to cleartext transport, even for an
  // allowlisted host: DNS/host policy does not provide transport integrity.
  if (
    parsed.protocol !== 'https:'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
  ) return false;
  return allowedHosts.includes(parsed.hostname.toLowerCase());
}

type GitTool = {
  execute?: (...args: any[]) => any;
};

type GitToolProvider = { tools: object };

/**
 * Wrap a git ToolProvider so the default token is injected into an AUTH command's opts
 * only when opts.url's host is allowlisted. The provider passed in MUST have been built
 * WITHOUT a default token (so nothing auto-injects). No token / empty allowlist → the
 * provider is returned unchanged.
 */
export function guardGitToken<T extends GitToolProvider>(
  provider: T,
  opts: { token?: string; allowedHosts: string[] },
): T {
  if (!opts.token || opts.allowedHosts.length === 0) return provider;
  const tools: Record<string, GitTool> = {};
  // SAFETY: the provider is constructed by the AI SDK with a tools object;
  // only named tool entries and their optional execute functions are wrapped.
  for (const [name, tool] of Object.entries(provider.tools as Record<string, GitTool>)) {
    const execute = tool.execute;
    const parsedExecute = callableSchema.safeParse(execute);
    if (!GIT_AUTH_COMMANDS.has(name) || !parsedExecute.success) {
      tools[name] = tool;
      continue;
    }
    // SAFETY: callableSchema.success proves the tool entry is executable; this
    // cast restores the variadic signature owned by the provider contract.
    const executeFn = parsedExecute.data as NonNullable<GitTool['execute']>;
    tools[name] = {
      ...tool,
      execute: (...args: any[]) => {
        let commandOpts = args[0] ?? {};
        if (
          !commandOpts.token &&
          !commandOpts.username &&
          gitHostAllowed(commandOpts.url, opts.allowedHosts)
        ) {
          commandOpts = { ...commandOpts, token: opts.token };
        }
        return executeFn(commandOpts, ...args.slice(1));
      },
    };
  }
  // SAFETY: preserve the provider's original shape while replacing only the
  // owned tool map entries above.
  return { ...provider, tools } as T;
}
