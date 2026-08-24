import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const workerReadmeUrl = new URL('../cloudflare/README.md', import.meta.url);
const routeGateUrl = new URL('./agent-studio-route-gate.mjs', import.meta.url);

test('CI protects action and package credentials in one validation job', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const workerReadme = await readFile(workerReadmeUrl, 'utf8');
  const routeGate = await readFile(routeGateUrl, 'utf8');

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
  assert.match(validationJob, /- name: Install Chromium for browser integration\n\s+run: bunx playwright install --with-deps chromium/);
  assert.match(validationJob, /- name: Local Worker browser acceptance \(integration, not E2E\)\n\s+run: bun run test:browser -- --no-build/);
  assert.match(
    validationJob,
    /CAIL_IDENTITY_ISSUER=\n\s+CAIL_CANONICAL_ORIGIN=\n/,
    'local Worker acceptance must use the request origin instead of the production WebSocket origin',
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
  const preflightPosition = deployJob.indexOf('- name: Verify production Worker and custom-domain read access');
  const deployPosition = deployJob.indexOf('- name: Deploy the exact main commit');
  assert.ok(preflightPosition >= 0 && preflightPosition < deployPosition);
  assert.match(deployJob, /working-directory: cloudflare\n        run: \|[\s\S]*bunx wrangler deploy \\\n            --config wrangler\.jsonc \\\n            --strict/);
  assert.doesNotMatch(deployJob, /bunx wrangler deploy[\s\S]*--env staging/);
  assert.equal(deployJob.split('bun ../scripts/agent-studio-route-gate.mjs').length - 1, 1);
  assert.doesNotMatch(deployJob, /route_inventory|route inventory found|cat .*zone/i);
  assert.match(deployJob, /versions list --name agent-studio --json/);
  assert.match(deployJob, /deployments list --name agent-studio --json/);
  assert.ok(deployJob.includes('workers/message'));
  assert.match(deployJob, /versions view "\$version_id" --name agent-studio --json/);
  assert.match(deployJob, /\.versions\[0\]\.version_id == \$id and \.versions\[0\]\.percentage == 100/);
  const deployCommandPosition = deployJob.indexOf('bunx wrangler deploy');
  const subdomainReadbackPosition = deployJob.indexOf('/workers/scripts/agent-studio/subdomain');
  assert.ok(deployCommandPosition >= 0 && deployCommandPosition < subdomainReadbackPosition);
  assert.match(deployJob, /subdomain="\$\(curl --fail --silent --show-error \\\n\s+"\$\{api\}\/accounts\/\$\{account_id\}\/workers\/scripts\/agent-studio\/subdomain/);
  assert.match(deployJob, /\.success == true/);
  assert.match(deployJob, /\.result\.enabled == false/);
  assert.match(deployJob, /\.result\.previews_enabled == false/);
  assert.match(routeGate, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/workers\/scripts/);
  assert.match(routeGate, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/workers\/domains/);
  assert.match(routeGate, /const agentStudioScripts = scripts\.result\.filter/);
  assert.match(routeGate, /agentStudioScripts\.length !== 1/);
  assert.match(routeGate, /agentStudioScripts\[0\]\.routes \?\? \[\]/);
  assert.match(routeGate, /\.length !== 0/);
  assert.match(routeGate, /domains\.result\.length !== 0/);
  assert.match(routeGate, /Agent Studio route gate failed/);
  assert.match(deployJob, /select\(\.annotations\["workers\/message"\] == \$message\)/);
  assert.match(deployJob, /AgentStudioReadiness/);
  assert.match(deployJob, /release-readiness-wrangler\.jsonc/);
  for (const scope of ['Workers Scripts Read', 'Workers Scripts Write']) {
    assert.match(workerReadme, new RegExp(scope.replaceAll(' ', '\\s+')));
  }
  assert.match(workerReadme, /account-wide resource scope/);
  assert.doesNotMatch(workerReadme, /Zone Read|Workers Routes Read|every zone|single-zone/i);
  assert.match(deployJob, /remote mode/);
  assert.match(deployJob, /origin='https:\/\/tools\.ailab\.gc\.cuny\.edu'/);
  assert.match(deployJob, /probe_sso_redirect "\$origin\/agent-studio\/"/);
  assert.match(deployJob, /probe_unauthenticated_api "\$origin\/agent-studio\/api\/session"/);
  assert.match(deployJob, /ssologin\\\.cuny\\\.edu\/oauth2\/rest\/authorize/);
  assert.match(deployJob, /\.error\.code == "authentication_required"/);
  assert.match(deployJob, /\.error\.launch == "\/launch\/agent-studio"/);
  assert.match(deployJob, /\.error\.message == "Please sign in to continue\."/);
  assert.doesNotMatch(deployJob, /workers\.dev/);
  assert.doesNotMatch(deployJob, /--remote/);
  assert.doesNotMatch(deployJob, /HEALTH_URL|ROOT_URL|API_URL/);
  assert.match(deployJob, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.equal(validationJob.split('CLOUDFLARE_API_TOKEN:').length - 1, 0);
  assert.equal(deployJob.split('CLOUDFLARE_API_TOKEN:').length - 1, 4);
});
