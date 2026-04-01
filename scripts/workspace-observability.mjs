import {
  SessionClient,
  fetchObservability,
  parseArgs,
  printObservabilitySummary,
  saveObservability,
} from './_debug-common.mjs';

function printUsage() {
  console.log(`Usage:
  node scripts/workspace-observability.mjs --workspace <id>

Options:
  --base-url http://127.0.0.1:8787
  --workspace <id>
  --cookie "agent-studio-session=..."
  --json true
  --save true
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true' || !args.workspace) {
  printUsage();
  process.exit(args.help === 'true' ? 0 : 1);
}

const baseUrl = args['base-url'] || 'http://127.0.0.1:8787';
const session = new SessionClient(baseUrl, args.cookie || process.env.AGENT_STUDIO_COOKIE || '');
await session.ensureSession();

const observability = await fetchObservability(session, args.workspace);

if (args.json === 'true') {
  console.log(JSON.stringify(observability, null, 2));
} else {
  printObservabilitySummary(observability);
}

if (args.save === 'true') {
  const path = await saveObservability(observability, 'observability');
  console.log(`saved trace: ${path}`);
}
