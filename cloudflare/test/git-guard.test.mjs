import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gitHostAllowed,
  guardGitToken,
  parseGitAllowedHosts,
} from '../src/lib/git-guard.ts';

test('parseGitAllowedHosts normalizes a comma-separated allowlist', () => {
  assert.deepEqual(
    parseGitAllowedHosts({ GIT_AUTH_ALLOWED_HOSTS: ' GitHub.com, gitlab.example ,, ' }),
    ['github.com', 'gitlab.example'],
  );
  assert.deepEqual(parseGitAllowedHosts({}), []);
});

test('gitHostAllowed requires an allowlisted http(s) hostname', () => {
  assert.equal(gitHostAllowed('https://github.com/x/y.git', ['github.com']), true);
  assert.equal(gitHostAllowed('https://attacker.example/r.git', ['github.com']), false);
  assert.equal(gitHostAllowed('https://github.com/x/y.git', []), false);
  assert.equal(gitHostAllowed('ftp://github.com/x/y.git', ['github.com']), false);
  assert.equal(gitHostAllowed({ url: 'https://github.com/x/y.git' }, ['github.com']), false);
});

function fakeProvider(received) {
  return {
    label: 'git',
    tools: {
      clone: {
        execute: (opts) => {
          received.clone.push(opts);
          return opts;
        },
      },
      fetch: {
        execute: (opts) => {
          received.fetch.push(opts);
          return opts;
        },
      },
      status: {
        execute: (opts) => {
          received.status.push(opts);
          return opts;
        },
      },
    },
  };
}

test('guardGitToken injects only for auth commands targeting allowlisted hosts', () => {
  const received = { clone: [], fetch: [], status: [] };
  const provider = guardGitToken(fakeProvider(received), {
    token: 'secret-token',
    allowedHosts: ['github.com'],
  });

  provider.tools.clone.execute({ url: 'https://github.com/x/y.git' });
  provider.tools.clone.execute({ url: 'https://attacker.example/r.git' });
  provider.tools.status.execute({ url: 'https://github.com/x/y.git' });

  assert.equal(received.clone[0].token, 'secret-token');
  assert.equal('token' in received.clone[1], false);
  assert.equal('token' in received.status[0], false);
});

test('guardGitToken leaves an unconfigured provider unchanged', () => {
  const provider = fakeProvider({ clone: [], fetch: [], status: [] });
  assert.equal(
    guardGitToken(provider, { token: undefined, allowedHosts: ['github.com'] }),
    provider,
  );
});
