const CLAUDE_CODE_PROCESS_ENV_EXACT_ALLOWLIST = new Set([
  'HOME',
  'LOGNAME',
  'USER',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'PYTHON_VENV_PATH',
]);

const CLAUDE_CODE_PROCESS_ENV_PREFIX_ALLOWLIST = [
  'ANTHROPIC_',
  'CLAUDE_CODE_',
  'CLAUDE_AGENT_SDK_',
] as const;

export const EXPOSED_AGENT_ENV_ALLOWLIST = [
  'PRIMO_API_KEY',
  'PRIMO_VID',
  'PRIMO_SCOPE',
  'PRIMO_BASE_URL',
  'PRIMO_DISCOVERY_URL',
  'OPENALEX_EMAIL',
  'OCLC_CLIENT_ID',
  'OCLC_CLIENT_SECRET',
  'OCLC_INSTITUTION_ID',
  'LIBGUIDES_SITE_ID',
  'LIBGUIDES_CLIENT_ID',
  'LIBGUIDES_CLIENT_SECRET',
  'LIBGUIDES_BASE_URL',
] as const;

function isAllowedClaudeCodeProcessEnvKey(key: string): boolean {
  return CLAUDE_CODE_PROCESS_ENV_EXACT_ALLOWLIST.has(key)
    || CLAUDE_CODE_PROCESS_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}

export function buildClaudeCodeProcessEnv(
  overrides: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key]) => isAllowedClaudeCodeProcessEnvKey(key))
  );

  return {
    ...env,
    ...overrides,
  };
}

export function getExposedAgentEnvValue(
  key: string,
  source: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!EXPOSED_AGENT_ENV_ALLOWLIST.includes(key as (typeof EXPOSED_AGENT_ENV_ALLOWLIST)[number])) {
    throw new Error(`Access to environment variable '${key}' is not allowed`);
  }

  return source[key];
}
