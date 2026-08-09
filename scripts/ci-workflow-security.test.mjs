import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('CI protects action and package credentials in one validation job', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^\s{4}env:/m, 'jobs must not have shared environments');
  assert.doesNotMatch(workflow, /uses:\s+\S+@v\d+/);
  assert.match(workflow, /^  validate:\n/m);
  const jobs = workflow.split(/^jobs:\n/m)[1] ?? '';
  assert.deepEqual(jobs.match(/^  [a-z][a-z-]*:\n/gm), ['  validate:\n'], 'CI should keep one validation job');

  for (const action of [
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
  ]) {
    assert.equal(workflow.split(action).length - 1, 1, `${action} must appear once in the validation job`);
  }

  assert.equal(
    workflow.split('persist-credentials: false').length - 1,
    1,
    'checkout must disable credential persistence',
  );

  const installBlocks = workflow.match(
    /      - name: Install dependencies\n        env:\n          NODE_AUTH_TOKEN: \$\{\{ secrets\.CAIL_PACKAGES_TOKEN \}\}\n        run: bun install --frozen-lockfile/g,
  ) ?? [];
  assert.equal(installBlocks.length, 1, 'the validation job must scope the token to its frozen install');
  assert.equal(
    workflow.split('NODE_AUTH_TOKEN:').length - 1,
    installBlocks.length,
    'the package token must not appear outside install steps',
  );
});
