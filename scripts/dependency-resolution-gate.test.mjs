import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseBunLock, verifyDependencyResolution } from './dependency-resolution-gate.mjs';

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeInstalledPackage(rootDir, relativeDirectory, name, version) {
  const packageDirectory = path.join(rootDir, relativeDirectory);
  await writeJson(path.join(packageDirectory, 'package.json'), { name, version, main: 'index.js' });
  await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {};\n');
}

async function makeFixture({ conflictingDirectVersions = false } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-dependency-gate-'));
  const manifests = {
    root: {
      name: 'dependency-gate-fixture',
      private: true,
      workspaces: ['cloudflare', 'frontend'],
      devDependencies: { 'root-tool': '1.0.0' },
    },
    cloudflare: {
      name: '@fixture/cloudflare',
      private: true,
      dependencies: { 'shared-tool': '1.0.0' },
    },
    frontend: {
      name: '@fixture/frontend',
      private: true,
      dependencies: { 'shared-tool': conflictingDirectVersions ? '2.0.0' : '1.0.0' },
    },
  };
  await writeJson(path.join(rootDir, 'package.json'), manifests.root);
  await writeJson(path.join(rootDir, 'cloudflare/package.json'), manifests.cloudflare);
  await writeJson(path.join(rootDir, 'frontend/package.json'), manifests.frontend);
  await fs.writeFile(
    path.join(rootDir, 'bunfig.toml'),
    '[install]\nlinker = "hoisted"\n',
  );

  const importer = (name, deps) => ({ name, dependencies: deps });
  await fs.writeFile(
    path.join(rootDir, 'bun.lock'),
    `${JSON.stringify(
      {
        lockfileVersion: 1,
        workspaces: {
          '': importer('dependency-gate-fixture', { 'root-tool': '1.0.0' }),
          cloudflare: importer('@fixture/cloudflare', { 'shared-tool': '1.0.0' }),
          frontend: importer('@fixture/frontend', {
            'shared-tool': conflictingDirectVersions ? '2.0.0' : '1.0.0',
          }),
        },
        packages: {
          'root-tool': ['root-tool@1.0.0', '', {}, 'sha512-fixture'],
          'shared-tool': ['shared-tool@1.0.0', '', {}, 'sha512-fixture'],
          ...(conflictingDirectVersions
            ? { 'frontend/shared-tool': ['shared-tool@2.0.0', '', {}, 'sha512-fixture'] }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeInstalledPackage(rootDir, 'node_modules/root-tool', 'root-tool', '1.0.0');
  await writeInstalledPackage(rootDir, 'node_modules/shared-tool', 'shared-tool', '1.0.0');
  if (conflictingDirectVersions) {
    await writeInstalledPackage(rootDir, 'frontend/node_modules/shared-tool', 'shared-tool', '2.0.0');
  }
  return rootDir;
}

test('parses Bun lock comments and trailing commas without evaluating package data', () => {
  const parsed = parseBunLock('{\n  // importer comment\n  "workspaces": {},\n  /* package comment */\n}\n');
  assert.deepEqual(parsed, { workspaces: {} });
});

test('passes when every workspace resolves the lock-selected root package', async () => {
  const rootDir = await makeFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
    assert.equal(result.workspaces, 3);
    assert.equal(result.checked, 3);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('fails on a stale workspace-local package shadowing the root install', async () => {
  const rootDir = await makeFixture();
  try {
    await writeInstalledPackage(rootDir, 'frontend/node_modules/shared-tool', 'shared-tool', '0.9.0');
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /frontend\/node_modules\/shared-tool/);
    assert.match(result.issues.join('\n'), /shared-tool@0\.9\.0/);
    assert.match(result.issues.join('\n'), /shared-tool@1\.0\.0/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('does not reject a legitimate nested package outside direct workspace dependencies', async () => {
  const rootDir = await makeFixture();
  try {
    await writeInstalledPackage(rootDir, 'frontend/node_modules/transitive-tool', 'transitive-tool', '9.9.9');
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('allows conflicting direct versions when the lock has a nested workspace selection', async () => {
  const rootDir = await makeFixture({ conflictingDirectVersions: true });
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
