import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FAILURE_MESSAGE,
  verifyAgentStudioRoutes,
} from './agent-studio-route-gate.mjs';

const API_BASE = 'https://api.example.test/client/v4';
const ACCOUNT_ID = 'account-id';
const TOKEN = 'token';
const GATE_SCRIPT = fileURLToPath(new URL('./agent-studio-route-gate.mjs', import.meta.url));

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function zonesPage(page, totalPages, totalCount, result) {
  return {
    errors: [],
    messages: [],
    result,
    result_info: {
      count: result.length,
      page,
      per_page: 50,
      total_count: totalCount,
      total_pages: totalPages,
    },
    success: true,
  };
}

function emptyRoutes() {
  return { errors: [], messages: [], result: [], success: true };
}

function bypassRoutes() {
  return {
    errors: [],
    messages: [],
    result: [
      { id: 'bypass', pattern: 'example.test/*', script: null },
      { id: 'unbound', pattern: 'unbound.example.test/*' },
    ],
    success: true,
  };
}

function emptyDomains() {
  return {
    errors: null,
    messages: null,
    result: [],
    result_info: { count: 0, page: 1, per_page: 0, total_count: 0 },
    success: true,
  };
}

function emptyDomainsWithoutPagination() {
  return {
    errors: null,
    messages: null,
    result: [],
    success: true,
  };
}

function fetchFor(handler) {
  const calls = [];
  const fetchImpl = async (requestUrl) => {
    const url = new URL(requestUrl);
    calls.push(url);
    return handler(url);
  };
  return { calls, fetchImpl };
}

test('route gate fails closed when zone pagination metadata is absent', async () => {
  const { calls, fetchImpl } = fetchFor(() => jsonResponse({
    errors: [],
    messages: [],
    result: [],
    success: true,
  }));

  await assert.rejects(
    verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
    (error) => error instanceof Error && error.message === FAILURE_MESSAGE,
  );
  assert.equal(calls.length, 1);
});

test('route gate visits every declared zone page before checking domains', async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => index === 0
    ? {
      id: `zone-${index}`,
      name: `zone-${index}.example`,
      account: { id: ACCOUNT_ID },
      status: 'active',
    }
    : {
      id: `zone-${index}`,
      name: `zone-${index}.example`,
    });
  const { calls, fetchImpl } = fetchFor((url) => {
    if (url.pathname === '/client/v4/zones') {
      const page = Number(url.searchParams.get('page'));
      return jsonResponse(page === 1
        ? zonesPage(1, 2, 51, firstPage)
        : zonesPage(2, 2, 51, [{ id: 'zone-50', name: 'zone-50.example' }]));
    }
    if (/^\/client\/v4\/zones\/zone-[0-9]+\/workers\/routes$/u.test(url.pathname)) {
      return jsonResponse(url.pathname.endsWith('/zone-0/workers/routes')
        ? bypassRoutes()
        : emptyRoutes());
    }
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/workers/domains`) {
      return jsonResponse(emptyDomains());
    }
    throw new Error('unexpected test URL');
  });

  await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
  const paths = calls.map((url) => `${url.pathname}${url.search}`);
  assert.equal(paths[0], '/client/v4/zones?account.id=account-id&type=full%2Cpartial%2Csecondary%2Cinternal&per_page=50&page=1');
  assert.equal(paths[51], '/client/v4/zones?account.id=account-id&type=full%2Cpartial%2Csecondary%2Cinternal&per_page=50&page=2');
  assert.equal(paths.at(-1), '/client/v4/accounts/account-id/workers/domains?service=agent-studio');
  assert.equal(paths.filter((path) => path.endsWith('/workers/routes')).length, 51);
});

test('route gate stops on a permissions 403 before route or domain reads', async () => {
  const { calls, fetchImpl } = fetchFor(() => new Response(null, { status: 403 }));

  await assert.rejects(
    verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
    (error) => error instanceof Error && error.message === FAILURE_MESSAGE,
  );
  assert.equal(calls.length, 1);
});

test('route gate rejects an exact Agent Studio route with only the generic failure', async () => {
  const sensitive = {
    id: 'secret-route-id',
    pattern: 'secret.example.test/*',
    script: 'agent-studio',
  };
  const { fetchImpl } = fetchFor((url) => {
    if (url.pathname === '/client/v4/zones') {
      return jsonResponse(zonesPage(1, 1, 1, [{ id: 'zone-1', name: 'zone.example.test' }]));
    }
    if (url.pathname === '/client/v4/zones/zone-1/workers/routes') {
      return jsonResponse({ errors: null, messages: null, result: [sensitive], success: true });
    }
    throw new Error('unexpected test URL');
  });

  await assert.rejects(
    verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
    (error) => error instanceof Error
      && error.message === FAILURE_MESSAGE
      && !error.message.includes('secret'),
  );
});

test('route gate rejects malformed zone identifiers while accepting extra zone fields', async (t) => {
  for (const field of ['id', 'name']) {
    await t.test(`empty ${field}`, async () => {
      const malformed = field === 'id'
        ? { id: '', name: 'zone.example.test' }
        : { id: 'zone-1', name: '' };
      const { calls, fetchImpl } = fetchFor((url) => {
        if (url.pathname === '/client/v4/zones') {
          return jsonResponse(zonesPage(1, 1, 1, [malformed]));
        }
        throw new Error('unexpected test URL');
      });

      await assert.rejects(
        verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
        (error) => error instanceof Error && error.message === FAILURE_MESSAGE,
      );
      assert.equal(calls.length, 1);
    });
  }
});

test('route gate fails closed on malformed or forbidden custom-domain results', async (t) => {
  await t.test('single-page result_info may be omitted', async () => {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname === '/client/v4/zones') return jsonResponse(zonesPage(1, 1, 0, []));
      return jsonResponse(emptyDomainsWithoutPagination());
    });
    await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
  });

  await t.test('malformed result', async () => {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname === '/client/v4/zones') return jsonResponse(zonesPage(1, 1, 0, []));
      return jsonResponse({ errors: null, messages: null, result: {}, success: true });
    });
    await assert.rejects(verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl));
  });

  await t.test('permissions 403', async () => {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname === '/client/v4/zones') return jsonResponse(zonesPage(1, 1, 0, []));
      return new Response(null, { status: 403 });
    });
    await assert.rejects(verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl));
  });

  await t.test('forbidden result has no sensitive error detail', async () => {
    const sensitive = {
      cert_id: 'secret-cert',
      hostname: 'secret.example.test',
      id: 'secret-domain',
      service: 'agent-studio',
      zone_id: 'secret-zone-id',
      zone_name: 'secret-zone.example.test',
    };
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname === '/client/v4/zones') return jsonResponse(zonesPage(1, 1, 0, []));
      return jsonResponse({ errors: null, messages: null, result: [sensitive], success: true });
    });
    await assert.rejects(
      verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
      (error) => error instanceof Error
        && error.message === FAILURE_MESSAGE
        && !error.message.includes('secret'),
    );
  });
});

test('CLI emits only the fixed route-gate failure for a forbidden custom domain', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/client/v4/zones?')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(zonesPage(1, 1, 0, [])));
      return;
    }
    if (request.url === `/client/v4/accounts/${ACCOUNT_ID}/workers/domains?service=agent-studio`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        errors: null,
        messages: null,
        result: [{
          cert_id: 'secret-cert',
          hostname: 'secret.example.test',
          id: 'secret-domain',
          service: 'agent-studio',
          zone_id: 'secret-zone-id',
          zone_name: 'secret-zone.example.test',
        }],
        success: true,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && address !== undefined);
  assert.ok(Number.isInteger(address.port));
  const child = spawn(process.execPath, [GATE_SCRIPT], {
    env: {
      ...process.env,
      CLOUDFLARE_API_BASE: `http://127.0.0.1:${address.port}/client/v4`,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [status] = await once(child, 'close');
  await new Promise((resolve) => server.close(resolve));

  assert.equal(status, 1);
  assert.equal(Buffer.concat(stdout).toString(), '');
  assert.equal(Buffer.concat(stderr).toString(), `${FAILURE_MESSAGE}\n`);
  assert.doesNotMatch(Buffer.concat(stderr).toString(), /secret|hostname|zone/i);
});

test('CLI emits only the fixed route-gate failure for a forbidden route', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/client/v4/zones?')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(zonesPage(1, 1, 1, [{ id: 'zone-1', name: 'zone.example.test' }])));
      return;
    }
    if (request.url === '/client/v4/zones/zone-1/workers/routes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        errors: null,
        messages: null,
        result: [{
          id: 'secret-route-id',
          pattern: 'secret.example.test/*',
          script: 'agent-studio',
        }],
        success: true,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && address !== undefined);
  assert.ok(Number.isInteger(address.port));
  const child = spawn(process.execPath, [GATE_SCRIPT], {
    env: {
      ...process.env,
      CLOUDFLARE_API_BASE: `http://127.0.0.1:${address.port}/client/v4`,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [status] = await once(child, 'close');
  await new Promise((resolve) => server.close(resolve));

  assert.equal(status, 1);
  assert.equal(Buffer.concat(stdout).toString(), '');
  assert.equal(Buffer.concat(stderr).toString(), `${FAILURE_MESSAGE}\n`);
  assert.doesNotMatch(Buffer.concat(stderr).toString(), /secret|hostname|zone/i);
});
