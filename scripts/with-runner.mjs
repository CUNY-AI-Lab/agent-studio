import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('Usage: node scripts/with-runner.mjs <dev|start>');
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const runnerPort = process.env.WORKSPACE_RUNNER_PORT || '3200';
const runnerHost = process.env.WORKSPACE_RUNNER_HOST || '127.0.0.1';
const runnerBaseUrl = process.env.WORKSPACE_RUNNER_BASE_URL || `http://${runnerHost}:${runnerPort}`;

const children = [];
let shuttingDown = false;

function spawnChild(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  });
  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  }, 2000).unref();
  process.exit(exitCode);
}

async function waitForRunner(url) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { cache: 'no-store' });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Runner did not become healthy at ${url}/health`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

const runner = spawnChild('node', ['.runner-dist/src/runner/server.js'], {
  ...process.env,
  WORKSPACE_RUNNER_PORT: runnerPort,
  WORKSPACE_RUNNER_HOST: runnerHost,
});

runner.on('exit', (code, signal) => {
  if (!shuttingDown) {
    console.error(`runner exited unexpectedly (${signal || code || 0})`);
    shutdown(code ?? 1);
  }
});

await waitForRunner(runnerBaseUrl);

const appCommand = mode === 'dev' ? 'dev:app' : 'start:app';
const app = spawnChild(npmCommand, ['run', appCommand], {
  ...process.env,
  WORKSPACE_RUNNER_BASE_URL: runnerBaseUrl,
});

app.on('exit', (code, signal) => {
  if (!shuttingDown) {
    shutdown(code ?? (signal ? 1 : 0));
  }
});
