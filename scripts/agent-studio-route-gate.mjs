import { z } from 'zod/mini';

export const CLOUDFLARE_ACCOUNT_ID = '452c33847cf5cb1e46f391fca32fd1b5';
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const FAILURE_MESSAGE = 'Agent Studio route gate failed';

const responseInfoSchema = z.record(z.string(), z.any());
const responseInfoListSchema = z.nullable(z.array(responseInfoSchema));
const scriptSchema = z.object({
  // The API documents this as an optional string. The account-level list can
  // contain unrelated Workers whose names are longer than the account-id
  // limit; validate the one field we use without imposing that unrelated
  // resource's path-parameter limit here.
  id: z.optional(z.string().check(z.minLength(1))),
  routes: z.optional(z.nullable(z.array(z.any()))),
});
const scriptsResponseSchema = z.strictObject({
  errors: responseInfoListSchema,
  messages: responseInfoListSchema,
  result: z.array(scriptSchema),
  // This is a standard Cloudflare paginated envelope field. It is omitted by
  // some responses, so it is intentionally not inspected by this gate.
  result_info: z.optional(z.nullable(responseInfoSchema)),
  success: z.literal(true),
});
const domainResultInfoSchema = z.record(z.string(), z.any());
const domainSchema = z.object({
  service: z.string().check(z.minLength(1)),
});
const domainsResponseSchema = z.strictObject({
  errors: responseInfoListSchema,
  messages: responseInfoListSchema,
  result: z.array(domainSchema),
  result_info: z.optional(z.nullable(domainResultInfoSchema)),
  success: z.literal(true),
});

class RouteGateError extends Error {
  constructor(stage, reason) {
    super(FAILURE_MESSAGE);
    this.name = 'RouteGateError';
    this.stage = stage;
    this.reason = reason;
  }
}

function routeGateError(stage, reason) {
  return new RouteGateError(stage, reason);
}

export function formatRouteGateError(error) {
  if (!(error instanceof RouteGateError)) {
    return FAILURE_MESSAGE;
  }
  return `${FAILURE_MESSAGE} [${error.stage}: ${error.reason}]`;
}

function apiUrl(apiBase, path) {
  const normalizedBase = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  return new URL(path.replace(/^\//u, ''), normalizedBase);
}

function scriptsUrl(apiBase, accountId) {
  return apiUrl(
    apiBase,
    `accounts/${encodeURIComponent(accountId)}/workers/scripts`,
  );
}

function domainsUrl(apiBase, accountId) {
  const url = apiUrl(
    apiBase,
    `accounts/${encodeURIComponent(accountId)}/workers/domains`,
  );
  url.searchParams.set('service', 'agent-studio');
  return url;
}

async function readJson(url, token, stage, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw routeGateError(stage, 'network');
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 'unknown-status';
    throw routeGateError(stage, `http-${status}`);
  }
  try {
    return await response.json();
  } catch {
    throw routeGateError(stage, 'invalid-json');
  }
}

function parseScripts(payload) {
  const parsed = z.safeParse(scriptsResponseSchema, payload);
  if (!parsed.success) {
    throw routeGateError('scripts', 'invalid-response');
  }
  return parsed.data;
}

function parseDomains(payload) {
  const parsed = z.safeParse(domainsResponseSchema, payload);
  if (!parsed.success) {
    throw routeGateError('domains', 'invalid-response');
  }
  return parsed.data;
}

export async function verifyAgentStudioRoutes(
  apiBase,
  accountId,
  token,
  fetchImpl = fetch,
) {
  if (!apiBase || !accountId || !token) {
    throw routeGateError('configuration', 'missing-input');
  }

  const scripts = parseScripts(await readJson(
    scriptsUrl(apiBase, accountId),
    token,
    'scripts',
    fetchImpl,
  ));
  const agentStudioScripts = scripts.result.filter((script) => script.id === 'agent-studio');
  if (
    agentStudioScripts.length !== 1
    || (agentStudioScripts[0].routes ?? []).length !== 0
  ) {
    throw routeGateError('scripts', 'unexpected-routing');
  }

  const domains = parseDomains(await readJson(
    domainsUrl(apiBase, accountId),
    token,
    'domains',
    fetchImpl,
  ));
  if (domains.result.length !== 0) {
    throw routeGateError('domains', 'unexpected-routing');
  }
}

export async function runFromEnvironment(env = process.env) {
  await verifyAgentStudioRoutes(
    env.CLOUDFLARE_API_BASE || CLOUDFLARE_API_BASE,
    env.CLOUDFLARE_ACCOUNT_ID || CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
  );
}

if (import.meta.main) {
  try {
    await runFromEnvironment();
  } catch (error) {
    console.error(formatRouteGateError(error));
    process.exitCode = 1;
  }
}
