import {
  SessionClient,
  connectAgent,
  createWorkspace,
  fetchObservability,
  fetchWorkspace,
  parseArgs,
  printObservabilitySummary,
  saveObservability,
  sendChatTurn,
} from './_debug-common.mjs';

function printUsage() {
  console.log(`Usage:
  node scripts/workspace-chat-debug.mjs --prompt "Create an HTML tile ..."

Options:
  --base-url http://127.0.0.1:8787
  --workspace <id>
  --create "CLI Debug Workspace"
  --prompt "<message>"
  --scope panel1,panel2
  --idle-timeout-ms 60000
  --total-timeout-ms 180000
  --cookie "agent-studio-session=..."
  --save true
  --quiet true
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true' || !args.prompt) {
  printUsage();
  process.exit(args.help === 'true' ? 0 : 1);
}

const baseUrl = args['base-url'] || 'http://127.0.0.1:8787';
const session = new SessionClient(baseUrl, args.cookie || process.env.AGENT_STUDIO_COOKIE || '');
await session.ensureSession();

let workspaceId = args.workspace;
if (!workspaceId) {
  const workspace = await createWorkspace(session, args.create || 'CLI Debug Workspace');
  workspaceId = workspace.id;
  console.log(`created workspace: ${workspaceId}`);
}

const workspacePayload = await fetchWorkspace(session, workspaceId);
const client = await connectAgent(session, workspacePayload);

console.log(`workspace: ${workspaceId}`);
console.log(`agent: ${workspacePayload.agent.className}/${workspacePayload.agent.name}`);
console.log('--- stream ---');

const result = await sendChatTurn({
  client,
  messages: workspacePayload.messages,
  prompt: args.prompt,
  scopePanelIds: args.scope ? args.scope.split(',').map((value) => value.trim()).filter(Boolean) : [],
  idleTimeoutMs: Number(args['idle-timeout-ms'] || 60000),
  totalTimeoutMs: Number(args['total-timeout-ms'] || 180000),
  verbose: args.quiet !== 'true',
});

console.log('--- result ---');
if (result.ok) {
  console.log(`completed request ${result.requestId}`);
} else {
  console.log(`incomplete request ${result.requestId}: ${result.reason}`);
}

const observability = await fetchObservability(session, workspaceId);
console.log('--- observability ---');
printObservabilitySummary(observability);

if (args.save === 'true') {
  const path = await saveObservability(observability, 'chat-trace');
  console.log(`saved trace: ${path}`);
}

client.close();
