import { z } from 'zod/mini';

export const CLOUDFLARE_ACCOUNT_ID = '452c33847cf5cb1e46f391fca32fd1b5';
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const FAILURE_MESSAGE = 'Agent Studio route gate failed';

const responseInfoSchema = z.record(z.string(), z.any());
const responseInfoListSchema = z.nullable(z.array(responseInfoSchema));
const scriptSchema = z.object({
  id: z.optional(z.string().check(z.minLength(1), z.maxLength(32))),
  routes: z.optional(z.nullable(z.array(z.any()))),
});
const scriptsResponseSchema = z.strictObject({
  errors: responseInfoListSchema,
  messages: responseInfoListSchema,
  result: z.array(scriptSchema),
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

function routeGateError() {
  return new Error(FAILURE_MESSAGE);
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

async function readJson(url, token, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw routeGateError();
    }
    return await response.json();
  } catch {
    throw routeGateError();
  }
}

function parseScripts(payload) {
  const parsed = z.safeParse(scriptsResponseSchema, payload);
  if (!parsed.success) {
    throw routeGateError();
  }
  return parsed.data;
}

function parseDomains(payload) {
  const parsed = z.safeParse(domainsResponseSchema, payload);
  if (!parsed.success) {
    throw routeGateError();
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
    throw routeGateError();
  }

  const scripts = parseScripts(await readJson(scriptsUrl(apiBase, accountId), token, fetchImpl));
  const agentStudioScripts = scripts.result.filter((script) => script.id === 'agent-studio');
  if (
    agentStudioScripts.length !== 1
    || (agentStudioScripts[0].routes ?? []).length !== 0
  ) {
    throw routeGateError();
  }

  const domains = parseDomains(await readJson(domainsUrl(apiBase, accountId), token, fetchImpl));
  if (domains.result.length !== 0) {
    throw routeGateError();
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
  } catch {
    console.error(FAILURE_MESSAGE);
    process.exitCode = 1;
  }
}
