import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAILURE_MESSAGE,
  formatRouteGateError,
  verifyAgentStudioRoutes,
} from './agent-studio-route-gate.mjs';

const API_BASE = 'https://api.example.test/client/v4';
const ACCOUNT_ID = 'account-id';
const TOKEN = 'token';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scriptsResponse(result, resultInfo) {
  const response = {
    errors: [],
    messages: [],
    result,
    success: true,
  };
  if (resultInfo !== undefined) response.result_info = resultInfo;
  return response;
}

function agentStudioScript(routes) {
  const script = {
    id: 'agent-studio',
  };
  if (routes !== undefined) script.routes = routes;
  return script;
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

test('route gate reads the account-level script and filtered custom-domain inventories', async () => {
  const { calls, fetchImpl } = fetchFor((url) => {
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`) {
      return jsonResponse(scriptsResponse([
        {
          id: 'other-worker',
          routes: [{ arbitrary: 'fleet route metadata' }],
        },
        agentStudioScript(),
      ]));
    }
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/workers/domains`) {
      assert.equal(url.search, '?service=agent-studio');
      return jsonResponse(emptyDomains());
    }
    throw new Error('unexpected test URL');
  });

  await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
  assert.deepEqual(
    calls.map((url) => `${url.pathname}${url.search}`),
    [
      '/client/v4/accounts/account-id/workers/scripts',
      '/client/v4/accounts/account-id/workers/domains?service=agent-studio',
    ],
  );
});

test('route gate accepts the current paginated script envelope and long unrelated names', async () => {
  const { fetchImpl } = fetchFor((url) => {
    if (url.pathname.endsWith('/workers/scripts')) {
      return jsonResponse(scriptsResponse([
        {
          id: 'an-unrelated-worker-name-longer-than-thirty-two-characters',
          routes: [{ arbitrary: 'unrelated route metadata' }],
        },
        agentStudioScript(),
      ], {
        count: 2,
        page: 1,
        per_page: 20,
        total_count: 2,
        total_pages: 1,
      }));
    }
    return jsonResponse(emptyDomains());
  });

  await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
});

test('route gate requires exactly one Agent Studio script with no associated routes', async () => {
  const cases = [
    ['no scripts', []],
    ['multiple Agent Studio scripts', [
      agentStudioScript(),
      agentStudioScript([]),
    ]],
    ['an associated route', [agentStudioScript([
      { id: 'route-id', pattern: 'example.test/*', script: 'agent-studio' },
    ])]],
  ];

  for (const [name, result] of cases) {
    const { calls, fetchImpl } = fetchFor((url) => {
      if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`) {
        return jsonResponse(scriptsResponse(result));
      }
      throw new Error(`the custom-domain inventory must not be read for ${name}`);
    });

    await assert.rejects(
      verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
      (error) => error instanceof Error && error.message === FAILURE_MESSAGE,
    );
    assert.equal(calls.length, 1);
  }
});

test('route gate ignores unrelated Workers and accepts omitted or null route metadata', async () => {
  const inventories = [
    [
      { id: 'other-worker', routes: [{ arbitrary: 'fleet route metadata' }] },
      agentStudioScript(),
    ],
    [
      { id: 'another-worker' },
      { id: 'yet-another-worker', routes: null },
      { id: 'agent-studio', routes: null },
    ],
  ];

  for (const result of inventories) {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname.endsWith('/workers/scripts')) {
        return jsonResponse(scriptsResponse(result));
      }
      return jsonResponse(emptyDomains());
    });
    await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
  }
});

test('route gate stops on a permissions 403 before custom-domain reads', async () => {
  const { calls, fetchImpl } = fetchFor(() => new Response(null, { status: 403 }));

  await assert.rejects(
    verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
    (error) => error instanceof Error
      && error.message === FAILURE_MESSAGE
      && error.stage === 'scripts'
      && error.reason === 'http-403',
  );
  assert.equal(calls.length, 1);
});

test('route gate rejects malformed script-list responses', async () => {
  const cases = [
    ['missing result', {
      errors: [],
      messages: [],
      success: true,
    }],
    ['malformed result', {
      errors: null,
      messages: null,
      result: {},
      success: true,
    }],
    ['malformed routes field', scriptsResponse([{ id: 'agent-studio', routes: {} }])],
  ];

  for (const [name, payload] of cases) {
    const { calls, fetchImpl } = fetchFor(() => jsonResponse(payload));
    await assert.rejects(
      verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
      (error) => error instanceof Error && error.message === FAILURE_MESSAGE,
    );
    assert.equal(calls.length, 1, `${name} should stop after the script list`);
  }
});

test('route gate fails closed on malformed or non-empty custom-domain results', async () => {
  {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname.endsWith('/workers/scripts')) {
        return jsonResponse(scriptsResponse([agentStudioScript()]));
      }
      return jsonResponse(emptyDomainsWithoutPagination());
    });
    await verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl);
  }

  {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname.endsWith('/workers/scripts')) {
        return jsonResponse(scriptsResponse([agentStudioScript()]));
      }
      return jsonResponse({ errors: null, messages: null, result: {}, success: true });
    });
    await assert.rejects(verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl));
  }

  {
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname.endsWith('/workers/scripts')) {
        return jsonResponse(scriptsResponse([agentStudioScript()]));
      }
      return new Response(null, { status: 403 });
    });
    await assert.rejects(verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl));
  }

  {
    const sensitive = {
      cert_id: 'secret-cert',
      hostname: 'secret.example.test',
      id: 'secret-domain',
      service: 'different-service',
    };
    const { fetchImpl } = fetchFor((url) => {
      if (url.pathname.endsWith('/workers/scripts')) {
        return jsonResponse(scriptsResponse([agentStudioScript()]));
      }
      return jsonResponse({ errors: null, messages: null, result: [sensitive], success: true });
    });
    await assert.rejects(
      verifyAgentStudioRoutes(API_BASE, ACCOUNT_ID, TOKEN, fetchImpl),
      (error) => error instanceof Error
        && error.message === FAILURE_MESSAGE
        && !error.message.includes('secret'),
    );
  }
});

test('route gate formats failures with only the bounded stage and reason', async () => {
  await assert.rejects(
    verifyAgentStudioRoutes(API_BASE, '', TOKEN),
    (error) => {
      assert.equal(
        formatRouteGateError(error),
        `${FAILURE_MESSAGE} [configuration: missing-input]`,
      );
      return true;
    },
  );
});
