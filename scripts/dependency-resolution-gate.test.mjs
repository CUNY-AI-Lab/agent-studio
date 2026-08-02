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

async function makeFixture({ conflictingDirectVersions = false, swappedConflict = false } = {}) {
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
  await writeInstalledPackage(rootDir, 'node_modules/shared-tool', 'shared-tool', swappedConflict ? '2.0.0' : '1.0.0');
  if (conflictingDirectVersions) {
    await writeInstalledPackage(rootDir, 'frontend/node_modules/shared-tool', 'shared-tool', swappedConflict ? '1.0.0' : '2.0.0');
  }
  return rootDir;
}

async function writeSymlink(linkPath, targetPath) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(targetPath, linkPath, 'dir');
}

async function makeWorkspaceProtocolFixture({ descriptorName = '@fixture/provider', workspacePath = 'packages/provider', lockedProviderVersion = '1.2.3' } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-workspace-protocol-'));
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'workspace-protocol-fixture',
    private: true,
    workspaces: ['packages/*'],
  });
  await writeJson(path.join(rootDir, 'packages/provider/package.json'), {
    name: '@fixture/provider',
    version: '1.2.3',
    main: 'index.js',
  });
  await fs.writeFile(path.join(rootDir, 'packages/provider/index.js'), 'module.exports = {};\n');
  await writeJson(path.join(rootDir, 'packages/consumer/package.json'), {
    name: '@fixture/consumer',
    private: true,
    dependencies: { '@fixture/provider': 'workspace:*' },
  });
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'workspace-protocol-fixture' },
      'packages/provider': { name: '@fixture/provider', version: lockedProviderVersion },
      'packages/consumer': { name: '@fixture/consumer', dependencies: { '@fixture/provider': 'workspace:*' } },
    },
    packages: {
      '@fixture/provider': [`${descriptorName}@workspace:${workspacePath}`],
    },
  });
  await writeSymlink(path.join(rootDir, 'node_modules/@fixture/provider'), path.join(rootDir, 'packages/provider'));
  return rootDir;
}

async function makeNegativeGlobFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-negative-glob-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-outside-'));
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'negative-glob-fixture',
    private: true,
    workspaces: ['packages/**', '!packages/**/test/**'],
  });
  await writeJson(path.join(rootDir, 'packages/app/package.json'), { name: '@fixture/app', version: '1.0.0' });
  await writeJson(path.join(rootDir, 'packages/test/ignored/package.json'), {
    name: '@fixture/ignored',
    version: '1.0.0',
    dependencies: { missing: '1.0.0' },
  });
  await writeJson(path.join(outsideDir, 'package.json'), { name: '@fixture/outside', version: '1.0.0' });
  await writeSymlink(path.join(rootDir, 'packages/outside'), outsideDir);
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'negative-glob-fixture' },
      'packages/app': { name: '@fixture/app' },
    },
    packages: {},
  });
  return { rootDir, outsideDir };
}

async function makeAliasFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-alias-'));
  const gitSpec = 'git+ssh://git@example.invalid/org/git-tool.git#v2.0.0';
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'alias-fixture',
    private: true,
    workspaces: ['app'],
  });
  await writeJson(path.join(rootDir, 'app/package.json'), {
    name: '@fixture/app',
    dependencies: { 'alias-tool': 'npm:real-tool@1.2.3', 'git-alias': gitSpec },
  });
  await writeInstalledPackage(rootDir, 'node_modules/alias-tool', 'real-tool', '1.2.3');
  await writeInstalledPackage(rootDir, 'node_modules/git-alias', 'git-tool', '2.0.0');
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'alias-fixture' },
      app: { name: '@fixture/app', dependencies: { 'alias-tool': 'npm:real-tool@1.2.3', 'git-alias': gitSpec } },
    },
    packages: {
      'alias-tool': ['real-tool@1.2.3', '', {}, 'sha512-fixture'],
      'git-tool-record': [`git-tool@${gitSpec}`, gitSpec, {}, 'sha512-fixture'],
    },
  });
  return rootDir;
}

async function makeAliasVersionMismatchFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-alias-version-mismatch-'));
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'alias-version-mismatch-fixture',
    private: true,
    workspaces: ['app'],
  });
  await writeJson(path.join(rootDir, 'app/package.json'), {
    name: '@fixture/app',
    dependencies: { 'alias-tool': 'npm:real-tool@1.2.3' },
  });
  await writeInstalledPackage(rootDir, 'node_modules/alias-tool', 'real-tool', '2.0.0');
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'alias-version-mismatch-fixture' },
      app: { name: '@fixture/app', dependencies: { 'alias-tool': 'npm:real-tool@1.2.3' } },
    },
    packages: { 'alias-tool': ['real-tool@2.0.0', '', {}, 'sha512-fixture'] },
  });
  return rootDir;
}

async function makePrivateUrlFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-private-url-'));
  const url = 'https://private.example.invalid/npm/private-tool/-/private-tool-3.4.5.tgz?token=do-not-print';
  await writeJson(path.join(rootDir, 'package.json'), { name: 'private-url-fixture', private: true, workspaces: ['app'] });
  await writeJson(path.join(rootDir, 'app/package.json'), {
    name: '@fixture/app',
    dependencies: { 'private-tool': url },
  });
  await writeInstalledPackage(rootDir, 'node_modules/private-tool', 'private-tool', '3.4.5');
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'private-url-fixture' },
      app: { name: '@fixture/app', dependencies: { 'private-tool': url } },
    },
    packages: { 'private-tool': [`private-tool@${url}`, url, {}, 'sha512-fixture'] },
  });
  return { rootDir, url };
}

async function makeOutsideSymlinkFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-outside-install-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-outside-package-'));
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'outside-install-fixture',
    private: true,
    dependencies: { evil: '1.0.0' },
  });
  await writeInstalledPackage(outsideDir, '.', 'evil', '1.0.0');
  await writeSymlink(path.join(rootDir, 'node_modules/evil'), outsideDir);
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: { '': { name: 'outside-install-fixture', dependencies: { evil: '1.0.0' } } },
    packages: { evil: ['evil@1.0.0', '', {}, 'sha512-fixture'] },
  });
  return { rootDir, outsideDir };
}

async function makeInvalidDependencyNameFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-invalid-dependency-name-'));
  const dependencies = {
    '../../evil': '1.0.0',
    '@scope/../../evil': '1.0.0',
    'foo/bar': '1.0.0',
    'foo\\bar': '1.0.0',
    'foo%2fbar': '1.0.0',
    'foo\u0000bar': '1.0.0',
  };
  await writeJson(path.join(rootDir, 'package.json'), {
    name: 'invalid-dependency-name-fixture',
    private: true,
    dependencies,
  });
  await writeJson(path.join(rootDir, 'bun.lock'), {
    lockfileVersion: 1,
    workspaces: { '': { name: 'invalid-dependency-name-fixture', dependencies } },
    packages: {},
  });
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

test('rejects swapped workspace-specific versions even when both versions are locked', async () => {
  const rootDir = await makeFixture({ conflictingDirectVersions: true, swappedConflict: true });
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /cloudflare|frontend/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('binds workspace protocol resolution to the discovered workspace identity and path', async () => {
  const rootDir = await makeWorkspaceProtocolFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a workspace lock descriptor with a different target path', async () => {
  const rootDir = await makeWorkspaceProtocolFixture({ workspacePath: 'packages/other' });
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /workspace protocol lock identity/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a workspace lock descriptor with a different target name', async () => {
  const rootDir = await makeWorkspaceProtocolFixture({ descriptorName: '@other/provider' });
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /workspace protocol lock identity/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a workspace importer with a different target version', async () => {
  const rootDir = await makeWorkspaceProtocolFixture({ lockedProviderVersion: '9.9.9' });
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /workspace package version/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('applies ordered negative workspace globs and ignores out-of-root symlinks', async () => {
  const { rootDir, outsideDir } = await makeNegativeGlobFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
    assert.equal(result.workspaces, 2);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('binds npm aliases and Git aliases to importer-keyed lock records', async () => {
  const rootDir = await makeAliasFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects an npm alias when its lock target version differs from the requested target', async () => {
  const rootDir = await makeAliasVersionMismatchFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /npm alias target version/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('derives a private tarball version from its URL path without printing the URL', async () => {
  const { rootDir, url } = await makePrivateUrlFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, true, result.issues.join('\n'));
    await writeInstalledPackage(rootDir, 'node_modules/private-tool', 'private-tool', '3.4.4');
    const mismatch = verifyDependencyResolution({ rootDir });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.issues.join('\n'), /3\.4\.4|3\.4\.5/);
    assert.doesNotMatch(mismatch.issues.join('\n'), /private\.example|do-not-print|https?:/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('redacts credential-bearing source forms from manifest-lock diagnostics', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-redaction-'));
  const manifestSource = '//user:secret@private.example.invalid/pkg.tgz';
  const lockSource = 'ssh://user:secret@private.example.invalid/pkg.git';
  try {
    await writeJson(path.join(rootDir, 'package.json'), { name: 'redaction-fixture', private: true, workspaces: ['app'] });
    await writeJson(path.join(rootDir, 'app/package.json'), {
      name: '@fixture/app',
      dependencies: { 'credential-tool': manifestSource },
    });
    await writeInstalledPackage(rootDir, 'node_modules/credential-tool', 'credential-tool', '1.0.0');
    await writeJson(path.join(rootDir, 'bun.lock'), {
      lockfileVersion: 1,
      workspaces: {
        '': { name: 'redaction-fixture' },
        app: { name: '@fixture/app', dependencies: { 'credential-tool': lockSource } },
      },
      packages: { 'credential-tool': ['credential-tool@1.0.0', lockSource, {}, 'sha512-fixture'] },
    });
    const result = verifyDependencyResolution({ rootDir });
    const diagnostics = result.issues.join('\n');
    assert.equal(result.ok, false);
    assert.match(diagnostics, /<dependency source>/);
    assert.doesNotMatch(diagnostics, /user:secret|private\.example|ssh:|https?:|\/\//);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a dependency installed through an outside symlink', async () => {
  const { rootDir, outsideDir } = await makeOutsideSymlinkFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /outside the accepted repository install root/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('rejects traversal and extra-segment dependency names before resolution', async () => {
  const rootDir = await makeInvalidDependencyNameFixture();
  try {
    const result = verifyDependencyResolution({ rootDir });
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.equal(result.issues.filter((issue) => issue.includes('invalid dependency name')).length, 12);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
