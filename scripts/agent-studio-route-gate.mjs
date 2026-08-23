import { z } from 'zod/mini';

export const CLOUDFLARE_ACCOUNT_ID = '452c33847cf5cb1e46f391fca32fd1b5';
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const ZONE_PAGE_SIZE = 50;
export const FAILURE_MESSAGE = 'Agent Studio route gate failed';

const responseInfoSchema = z.record(z.string(), z.any());
const responseInfoListSchema = z.nullable(z.array(responseInfoSchema));
const paginationSchema = z.strictObject({
  count: z.number().check(z.int(), z.minimum(0)),
  page: z.number().check(z.int(), z.minimum(1)),
  per_page: z.number().check(z.int(), z.minimum(5), z.maximum(ZONE_PAGE_SIZE)),
  total_count: z.number().check(z.int(), z.minimum(0)),
  total_pages: z.number().check(z.int(), z.minimum(1)),
});
const zoneSchema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(32)),
  name: z.string().check(z.minLength(1), z.maxLength(253)),
});
const zonesResponseSchema = z.strictObject({
  errors: responseInfoListSchema,
  messages: responseInfoListSchema,
  result: z.array(zoneSchema),
  result_info: paginationSchema,
  success: z.literal(true),
});
const routeSchema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(32)),
  pattern: z.string().check(z.minLength(1)),
  script: z.optional(z.nullable(z.string().check(z.minLength(1)))),
});
const routesResponseSchema = z.strictObject({
  errors: responseInfoListSchema,
  result: z.array(routeSchema),
  messages: responseInfoListSchema,
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

function zonesUrl(apiBase, accountId, page) {
  const url = apiUrl(apiBase, 'zones');
  url.searchParams.set('account.id', accountId);
  url.searchParams.set('type', 'full,partial,secondary,internal');
  url.searchParams.set('per_page', String(ZONE_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

function routesUrl(apiBase, zoneId) {
  return apiUrl(apiBase, `zones/${encodeURIComponent(zoneId)}/workers/routes`);
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

function parseZones(payload) {
  const parsed = z.safeParse(zonesResponseSchema, payload);
  if (!parsed.success) {
    throw routeGateError();
  }
  return parsed.data;
}

function parseRoutes(payload) {
  const parsed = z.safeParse(routesResponseSchema, payload);
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

function assertPageContract(page, zones) {
  const { result_info: info } = zones;
  const expectedPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
  if (
    info.page !== page
    || info.per_page !== ZONE_PAGE_SIZE
    || info.count !== zones.result.length
    || info.total_pages !== expectedPages
    || page > info.total_pages
  ) {
    throw routeGateError();
  }
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

  const seenZoneIds = new Set();
  let page = 1;
  let totalPages = null;
  let totalCount = null;

  while (true) {
    const zones = parseZones(await readJson(zonesUrl(apiBase, accountId, page), token, fetchImpl));
    assertPageContract(page, zones);
    if (totalPages === null) {
      totalPages = zones.result_info.total_pages;
      totalCount = zones.result_info.total_count;
    } else if (
      totalPages !== zones.result_info.total_pages
      || totalCount !== zones.result_info.total_count
    ) {
      throw routeGateError();
    }

    for (const zone of zones.result) {
      if (seenZoneIds.has(zone.id)) {
        throw routeGateError();
      }
      seenZoneIds.add(zone.id);
      const routes = parseRoutes(await readJson(routesUrl(apiBase, zone.id), token, fetchImpl));
      if (routes.result.some((route) => route.script === 'agent-studio')) {
        throw routeGateError();
      }
    }

    if (page === totalPages) {
      break;
    }
    page += 1;
  }

  if (seenZoneIds.size !== totalCount) {
    throw routeGateError();
  }

  const domains = parseDomains(await readJson(domainsUrl(apiBase, accountId), token, fetchImpl));
  if (domains.result.some((domain) => domain.service === 'agent-studio')) {
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
