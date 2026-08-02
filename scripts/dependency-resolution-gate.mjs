import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const IGNORED_LOCAL_ENTRIES = new Set(['.bin', '.bun', '.cache', '.vite', '.vite-temp']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Bun's text lockfile is JSON with trailing commas. Keep this parser deliberately
// small and string-aware so this gate never needs a package install or network call.
export function parseBunLock(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === ',') {
      let next = index + 1;
      while (next < text.length) {
        while (/\s/.test(text[next] ?? '')) next += 1;
        if (text.startsWith('//', next)) {
          const newline = text.indexOf('\n', next + 2);
          next = newline === -1 ? text.length : newline + 1;
          continue;
        }
        if (text.startsWith('/*', next)) {
          const endComment = text.indexOf('*/', next + 2);
          next = endComment === -1 ? text.length : endComment + 2;
          continue;
        }
        break;
      }
      if (text[next] === '}' || text[next] === ']') continue;
    }
    output += character;
  }

  return JSON.parse(output);
}

function readBunLock(rootDir) {
  const lockPath = path.join(rootDir, 'bun.lock');
  if (!fs.existsSync(lockPath)) throw new Error('bun.lock is missing');
  return parseBunLock(fs.readFileSync(lockPath, 'utf8'));
}

function readBunLinker(rootDir) {
  const bunfigPath = path.join(rootDir, 'bunfig.toml');
  if (!fs.existsSync(bunfigPath)) return 'hoisted';
  const bunfig = fs.readFileSync(bunfigPath, 'utf8');
  return /^\s*linker\s*=\s*"([^"]+)"\s*$/m.exec(bunfig)?.[1] ?? 'hoisted';
}

function dependencyMap(manifest) {
  const result = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      result.set(name, spec);
    }
  }
  return result;
}

function hasGlob(segment) {
  return segment.includes('*') || segment.includes('?') || segment.includes('[');
}

function matchSegment(segment, value) {
  if (!hasGlob(segment)) return segment === value;
  const escaped = segment
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function childDirectories(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => path.join(directory, entry.name));
}

function expandWorkspacePattern(rootDir, pattern) {
  const segments = pattern.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean);
  const matches = [];

  function walk(directory, segmentIndex) {
    if (segmentIndex === segments.length) {
      if (fs.existsSync(path.join(directory, 'package.json'))) matches.push(directory);
      return;
    }

    const segment = segments[segmentIndex];
    if (segment === '**') {
      walk(directory, segmentIndex + 1);
      for (const child of childDirectories(directory)) walk(child, segmentIndex);
      return;
    }

    for (const child of childDirectories(directory)) {
      if (matchSegment(segment, path.basename(child))) walk(child, segmentIndex + 1);
    }
  }

  walk(rootDir, 0);
  return matches;
}

function workspacePatterns(rootManifest) {
  if (Array.isArray(rootManifest.workspaces)) return rootManifest.workspaces;
  if (rootManifest.workspaces && Array.isArray(rootManifest.workspaces.packages)) {
    return rootManifest.workspaces.packages;
  }
  return [];
}

function discoverWorkspaces(rootDir, rootManifest, issues) {
  const workspaces = [{ key: '', directory: rootDir, manifest: rootManifest }];
  const seen = new Set([path.resolve(rootDir)]);

  for (const pattern of workspacePatterns(rootManifest)) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
    for (const directory of expandWorkspacePattern(rootDir, pattern)) {
      const resolvedDirectory = path.resolve(directory);
      if (seen.has(resolvedDirectory)) continue;
      const manifestPath = path.join(resolvedDirectory, 'package.json');
      try {
        workspaces.push({
          key: path.relative(rootDir, resolvedDirectory).replaceAll(path.sep, '/'),
          directory: resolvedDirectory,
          manifest: readJson(manifestPath),
        });
        seen.add(resolvedDirectory);
      } catch {
        issues.push(`workspace ${path.relative(rootDir, resolvedDirectory)} has an unreadable package.json`);
      }
    }
  }
  return workspaces;
}

function lockWorkspace(lock, key) {
  const workspaces = lock.workspaces ?? {};
  return workspaces[key] ?? workspaces[key ? `./${key}` : '.'] ?? undefined;
}

function descriptorNameVersion(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const at = descriptor.startsWith('@') ? descriptor.indexOf('@', 1) : descriptor.indexOf('@');
  if (at <= 0 || at === descriptor.length - 1) return null;
  return { name: descriptor.slice(0, at), version: descriptor.slice(at + 1) };
}

function normalizeLockedVersion(name, version) {
  if (typeof version !== 'string' || version.length === 0) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(version)) return version;
  const packageBase = name.split('/').at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${packageBase}[-@]([0-9][^/]+?)(?:\\.tgz)?(?:$|[/?#])`).exec(version)?.[1];
}

function lockPackageVersions(lock, name) {
  const versions = new Set();
  for (const record of Object.values(lock.packages ?? {})) {
    const descriptor = descriptorNameVersion(Array.isArray(record) ? record[0] : undefined);
    if (descriptor?.name === name) {
      const normalized = normalizeLockedVersion(name, descriptor.version);
      if (normalized) versions.add(normalized);
    }
  }
  return versions;
}

function lockRootVersion(lock, name) {
  const descriptor = descriptorNameVersion(lock.packages?.[name]?.[0]);
  return descriptor?.name === name ? normalizeLockedVersion(name, descriptor.version) : undefined;
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, '/') || '.';
}

function formatSpec(spec) {
  if (typeof spec !== 'string') return '<missing>';
  // Keep registry URLs, aliases, and other non-version specs out of diagnostics.
  return /^(?:workspace:|https?:|git\+|npm:)/.test(spec) ? '<non-version spec>' : spec;
}

function packageDirectoryFromResolved(rootDir, name, resolvedPath) {
  let directory = path.dirname(resolvedPath);
  const stop = path.dirname(rootDir);
  while (directory !== stop) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = readJson(packagePath);
        if (manifest.name === name) return { directory, manifest };
      } catch {
        return null;
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function canonicalRootPackage(rootDir, name) {
  const packageDirectory = path.join(rootDir, 'node_modules', ...name.split('/'));
  const packagePath = path.join(packageDirectory, 'package.json');
  if (!fs.existsSync(packagePath)) return null;
  try {
    return { directory: packageDirectory, manifest: readJson(packagePath) };
  } catch {
    return null;
  }
}

function packageDirectoryFromWorkspaceNodeModules(rootDir, workspaceDirectory, name) {
  let directory = path.resolve(workspaceDirectory);
  const stop = path.dirname(rootDir);
  while (directory !== stop) {
    const packageDirectory = path.join(directory, 'node_modules', ...name.split('/'));
    const packagePath = path.join(packageDirectory, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = readJson(packagePath);
        if (manifest.name === name) return { directory: packageDirectory, manifest };
      } catch {
        return null;
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function localPackageEntries(nodeModulesDirectory) {
  if (!fs.existsSync(nodeModulesDirectory)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_LOCAL_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDirectory = path.join(nodeModulesDirectory, entry.name);
      for (const scopedEntry of fs.readdirSync(scopeDirectory, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() && !scopedEntry.name.startsWith('.')) {
          entries.push({ name: `${entry.name}/${scopedEntry.name}`, directory: path.join(scopeDirectory, scopedEntry.name) });
        }
      }
    } else {
      entries.push({ name: entry.name, directory: path.join(nodeModulesDirectory, entry.name) });
    }
  }
  return entries;
}

function checkWorkspaceLocalShadows(rootDir, workspace, directDependencies, lock, rootSelectedNames, issues) {
  const nodeModulesDirectory = path.join(workspace.directory, 'node_modules');
  for (const entry of localPackageEntries(nodeModulesDirectory)) {
    if (!directDependencies.has(entry.name)) continue;
    const expectedVersion = rootSelectedNames.has(entry.name) ? lockRootVersion(lock, entry.name) : undefined;
    if (!expectedVersion) continue;
    const packagePath = path.join(entry.directory, 'package.json');
    if (!fs.existsSync(packagePath)) {
      issues.push(`${relativePath(rootDir, entry.directory)} shadows the root install for ${entry.name} (package.json is missing)`);
      continue;
    }
    let manifest;
    try {
      manifest = readJson(packagePath);
    } catch {
      issues.push(`${relativePath(rootDir, entry.directory)} shadows the root install for ${entry.name} (package.json is unreadable)`);
      continue;
    }
    if (manifest.version !== expectedVersion) {
      issues.push(
        `${relativePath(rootDir, entry.directory)} resolves ${entry.name}@${manifest.version ?? 'unknown'}; ` +
          `bun.lock selects ${entry.name}@${expectedVersion}`,
      );
    }
  }
}

function checkResolvedDependency(rootDir, workspace, name, spec, lock, rootSelectedNames, issues) {
  const expectedRootVersion = rootSelectedNames.has(name) ? lockRootVersion(lock, name) : undefined;
  const expectedVersions = lockPackageVersions(lock, name);
  if (expectedVersions.size === 0 && !String(spec).startsWith('workspace:')) {
    issues.push(`${workspace.key || '.'} declares ${name}, but bun.lock has no resolved package entry`);
  }

  const requireFromWorkspace = createRequire(path.join(workspace.directory, 'package.json'));
  let resolvedPath;
  try {
    resolvedPath = requireFromWorkspace.resolve(name);
  } catch {
    try {
      // Type-only and bin-only packages often export no runtime entry point;
      // package.json is still a deterministic, local resolution target.
      resolvedPath = requireFromWorkspace.resolve(`${name}/package.json`);
    } catch {
      resolvedPath = null;
    }
  }

  const resolvedPackage =
    (resolvedPath ? packageDirectoryFromResolved(rootDir, name, resolvedPath) : null) ??
    packageDirectoryFromWorkspaceNodeModules(rootDir, workspace.directory, name);
  if (!resolvedPackage) {
    issues.push(`${workspace.key || '.'} cannot resolve ${name} from its workspace cwd`);
    return;
  }

  const actualVersion = resolvedPackage.manifest.version;
  if (expectedRootVersion && actualVersion !== expectedRootVersion) {
    issues.push(
      `${workspace.key || '.'} resolves ${name}@${actualVersion ?? 'unknown'} from ` +
        `${relativePath(rootDir, resolvedPackage.directory)}; bun.lock selects ${name}@${expectedRootVersion}`,
    );
  } else if (!expectedRootVersion && expectedVersions.size > 0 && !expectedVersions.has(actualVersion)) {
    issues.push(
      `${workspace.key || '.'} resolves ${name}@${actualVersion ?? 'unknown'}; ` +
        `bun.lock contains no matching locked version for this workspace`,
    );
  }

  if (expectedRootVersion) {
    const rootPackage = canonicalRootPackage(rootDir, name);
    if (!rootPackage) {
      issues.push(`root node_modules is missing the locked package ${name}@${expectedRootVersion}`);
    } else if (rootPackage.manifest.version !== expectedRootVersion) {
      issues.push(
        `root node_modules contains ${name}@${rootPackage.manifest.version ?? 'unknown'}; ` +
          `bun.lock selects ${name}@${expectedRootVersion}`,
      );
    }
  }
}

function compareManifestToLock(workspace, lock, issues) {
  const manifestDependencies = dependencyMap(workspace.manifest);
  const importer = lockWorkspace(lock, workspace.key);
  if (!importer) {
    issues.push(`${workspace.key || '.'} has no matching bun.lock workspace importer`);
    return manifestDependencies;
  }

  const lockedDependencies = dependencyMap(importer);
  for (const [name, spec] of manifestDependencies) {
    if (!lockedDependencies.has(name)) {
      issues.push(`${workspace.key || '.'} declares ${name}, but its bun.lock importer does not`);
    } else if (lockedDependencies.get(name) !== spec) {
      issues.push(
        `${workspace.key || '.'} declares ${name}@${formatSpec(spec)}, but bun.lock records ${name}@${formatSpec(lockedDependencies.get(name))}`,
      );
    }
  }
  for (const name of lockedDependencies.keys()) {
    if (!manifestDependencies.has(name)) issues.push(`${workspace.key || '.'} bun.lock importer has stale dependency ${name}`);
  }
  return manifestDependencies;
}

export function verifyDependencyResolution({ rootDir = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const issues = [];
  let rootManifest;
  let lock;
  try {
    rootManifest = readJson(path.join(resolvedRoot, 'package.json'));
    lock = readBunLock(resolvedRoot);
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)], checked: 0, workspaces: 0 };
  }

  const workspaces = discoverWorkspaces(resolvedRoot, rootManifest, issues);
  const linker = readBunLinker(resolvedRoot);
  const workspaceDependencyChecks = [];
  const requirementsByName = new Map();
  for (const workspace of workspaces) {
    const directDependencies = compareManifestToLock(workspace, lock, issues);
    workspaceDependencyChecks.push({ workspace, directDependencies });
    for (const [name, spec] of directDependencies) {
      if (!requirementsByName.has(name)) requirementsByName.set(name, new Set());
      requirementsByName.get(name).add(spec);
    }
  }

  // Only assert one root resolution when the lock importers establish one
  // shared exact selection. Conflicting direct requirements may correctly live
  // in nested node_modules, even with a hoisted workspace install.
  const rootSelectedNames = new Set();
  for (const [name, specs] of requirementsByName) {
    if (specs.size !== 1) continue;
    const [spec] = specs;
    if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(spec) || /^https?:\/\//.test(spec)) {
      if (lockRootVersion(lock, name)) rootSelectedNames.add(name);
    }
  }

  const checks = [];
  for (const { workspace, directDependencies } of workspaceDependencyChecks) {
    for (const [name, spec] of directDependencies) {
      checks.push({ workspace: workspace.key, name });
      checkResolvedDependency(resolvedRoot, workspace, name, spec, lock, rootSelectedNames, issues);
    }
    // A hoisted install has one root package location for direct workspace
    // dependencies. Isolated installs may legitimately use nested versions;
    // those are validated by the lock-selected version check above instead.
    if (workspace.key && linker === 'hoisted') {
      checkWorkspaceLocalShadows(resolvedRoot, workspace, directDependencies, lock, rootSelectedNames, issues);
    }
  }

  return { ok: issues.length === 0, issues, checked: checks.length, workspaces: workspaces.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const result = verifyDependencyResolution();
  if (!result.ok) {
    console.error('Dependency resolution gate failed:');
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Dependency resolution gate passed (${result.checked} direct dependencies across ${result.workspaces} workspaces).`);
  }
}
