import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('CI protects action and package credentials in one validation job', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n/m,
    'CI should validate pull requests and main pushes without duplicating PR branch push runs',
  );
  assert.match(workflow, /^permissions:\n  contents: read\n  packages: read$/m);
  assert.doesNotMatch(workflow, /^\s{4}env:/m, 'jobs must not have shared environments');
  assert.doesNotMatch(workflow, /uses:\s+\S+@v\d+/);
  assert.match(workflow, /^  validate:\n/m);
  const jobs = workflow.split(/^jobs:\n/m)[1] ?? '';
  assert.deepEqual(
    jobs.match(/^  [a-z][a-z-]*:\n/gm),
    ['  validate:\n', '  deploy:\n'],
    'CI should keep one validation job and one serialized production deploy job',
  );
  const validationJob = workflow.split(/^  deploy:\n/m)[0] ?? '';
  const repositoryCheckBlocks = validationJob.match(
    /      - name: Repository check\n        run: bun run check/g,
  ) ?? [];
  assert.equal(
    repositoryCheckBlocks.length,
    1,
    'CI must run the authoritative repository check, including its strict Worker dry bundle',
  );

  for (const action of [
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
  ]) {
    assert.equal(validationJob.split(action).length - 1, 1, `${action} must appear once in the validation job`);
  }

  assert.equal(
    validationJob.split('persist-credentials: false').length - 1,
    1,
    'checkout must disable credential persistence',
  );

  const installBlocks = workflow.match(
    /      - name: Install dependencies\n        env:\n          NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}\n        run: bun install --frozen-lockfile/g,
  ) ?? [];
  assert.equal(installBlocks.length, 2, 'validation and deploy jobs must scope the token to frozen installs');
  assert.equal(
    workflow.split('NODE_AUTH_TOKEN:').length - 1,
    installBlocks.length,
    'the package token must not appear outside install steps',
  );

  const deployJob = workflow.split(/^  deploy:\n/m)[1] ?? '';
  assert.match(deployJob, /^    needs: validate$/m);
  assert.match(deployJob, /^    permissions:\n      contents: read\n      packages: read$/m);
  assert.match(deployJob, /^      group: agent-studio-production$/m);
  assert.match(deployJob, /versions list --name agent-studio --json/);
  assert.match(deployJob, /deployments list --name agent-studio --json/);
  assert.ok(deployJob.includes('workers/message'));
  assert.match(deployJob, /versions view "\$version_id" --name agent-studio --json/);
  assert.match(deployJob, /\.versions\[0\]\.version_id == \$id and \.versions\[0\]\.percentage == 100/);
  assert.match(deployJob, /select\(\.annotations\["workers\/message"\] == \$message\)/);
  assert.match(deployJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.equal(validationJob.split('CLOUDFLARE_API_TOKEN:').length - 1, 0);
  assert.equal(deployJob.split('CLOUDFLARE_API_TOKEN:').length - 1, 2);
});
