#!/usr/bin/env node
/**
 * EI-18666853411437489 — "npm said `up to date`, but the package is not on disk."
 *
 * Under concurrent `npm install` runs on this shared tree, npm's reify bookkeeping
 * can end up believing a declared dependency is resolved (it is in
 * `package-lock.json`, and `node_modules/.package-lock.json` is NEWER than it) while
 * the tarball was never actually extracted to `node_modules`. npm then prints
 * "up to date" and exits 0. Nothing catches it until a build/gate fails downstream
 * — often 10+ minutes later, with a confusing unrelated error (a Rolldown
 * "failed to resolve", or a wrongly-suspected code bug in a gate test).
 *
 * `scripts/npm-install-safe.mjs` (+ `scripts/lib/fs-mutex.mjs`) closes the OTHER half
 * of this class: it serializes concurrent installs so new corruption is not created.
 * It cannot detect corruption that ALREADY exists (or that a bare `npm install` run
 * outside the mutex creates), which is what this module is for.
 *
 * The detector itself is the one already proven inside
 * `papercusp-desktop/bin/build-desktop-sidecar.sh` (WI-5769), lifted out of that
 * bash heredoc so the LOCAL shared tree can run the same check:
 *
 *   - SURGICAL, not `npm ls --all`: check that every package a workspace
 *     DIRECTLY declares in "dependencies" resolves on disk, then import a small
 *     lockfile-selected set of critical runtime entrypoints. The second leg catches
 *     an existing package directory whose `dist/` or native payload is incomplete,
 *     plus missing TRANSITIVE files reached by the import (EI-21252116452570853).
 *     A third leg scans package-LOCAL `node_modules` directories for package
 *     directories whose `package.json` is missing or unreadable. That is the exact
 *     partial-reify signature that left libs/generic/sse's local Vitest/TypeScript
 *     copies present-but-unusable (EI-20863794002653922), and it applies equally to
 *     dev tools that are intentionally outside the direct-runtime-dependency leg.
 *     A fourth leg checks readable workspace-local packages against the workspace's
 *     direct dependency/devDependency/optionalDependency range. npm can retain a
 *     valid old package and lock entry after the declaration changes, while install,
 *     dedupe, update, and prune all exit 0; that stale-but-readable node must not be
 *     reported healthy (EI-20863794002653922). `npm ls` additionally
 *     reports every UNMET (non-optional) PEER dependency under --legacy-peer-deps,
 *     including transitive peers of test-only packages nothing imports — a real
 *     false-positive that once blocked a build for a dependency it never needed.
 *   - RESOLVE THE WAY NODE DOES: the workspace's own node_modules first, then each
 *     ancestor node_modules up to the repo root (npm hoists nearly everything to
 *     the root in this workspaces monorepo).
 *   - RETRY WITH DELAY: a miss observed immediately after an install can be a
 *     filesystem-sync race rather than a real un-extracted dep. A miss that clears
 *     on retry is the race (non-fatal); one that persists across every attempt is
 *     the real bug.
 *
 * Usage:
 *   node scripts/check-declared-deps-extracted.mjs                    # every workspace
 *   node scripts/check-declared-deps-extracted.mjs --workspace=apps/operator
 *   node scripts/check-declared-deps-extracted.mjs --attempts=3 --delay-ms=2000
 *   npm run doctor:deps
 *
 * Exit 0 = every directly-declared dependency resolves on disk. Exit 1 = at least one
 * does not, after every retry — run `npm run install:safe -- install --legacy-peer-deps`.
 */
import { spawnSync } from "node:child_process";
import { existsSync as fsExistsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies, UnsupportedRange } from './check-peer-dep-conflicts.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runtime entrypoints whose real import graph is load-bearing for ptool and the
 * staging API. A probe is enabled only when its package appears in the target
 * repo's package-lock, so managed hives that do not declare this stack are not
 * coupled to Papercusp-specific packages.
 *
 * Prefer the public @lydell/node-pty entrypoint over a platform package name: it
 * selects and loads the correct native payload for the current platform while
 * still catching the observed missing @lydell/node-pty-linux-x64 package.
 */
export const RUNTIME_CONTENT_PROBES = Object.freeze([
  '@modelcontextprotocol/sdk/client/index.js',
  'zod-to-json-schema',
  'hono',
  '@lydell/node-pty',
  'rocksdb-native',
]);

export function packageNameFromSpecifier(specifier) {
  const parts = String(specifier).split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Select only probes whose package is part of the target repo's locked graph. */
export function resolveRuntimeContentProbes(repoRoot = REPO_ROOT, probes = RUNTIME_CONTENT_PROBES, deps = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  let lock;
  try {
    lock = readJson(join(repoRoot, 'package-lock.json'));
  } catch {
    return [];
  }
  const packagePaths = Object.keys(lock.packages ?? {});
  return probes.filter((specifier) => {
    const packageName = packageNameFromSpecifier(specifier);
    const suffix = `/node_modules/${packageName}`;
    return packagePaths.some((packagePath) => packagePath === `node_modules/${packageName}` || packagePath.endsWith(suffix));
  });
}

/** Expand the root package.json "workspaces" globs into repo-relative dirs. */
export function resolveWorkspaceDirs(repoRoot = REPO_ROOT, deps = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const readDir = deps.readDir ?? ((p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })));
  const exists = deps.existsSync ?? fsExistsSync;

  let globs;
  try {
    globs = readJson(join(repoRoot, 'package.json')).workspaces ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(globs)) globs = globs.packages ?? [];

  const out = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (exists(join(repoRoot, glob, 'package.json'))) out.push(glob);
      continue;
    }
    // Only the trailing-`*` shape is used in this repo ("apps/*", "packages/*").
    const parent = glob.slice(0, glob.lastIndexOf('/'));
    if (!glob.endsWith('/*') || !exists(join(repoRoot, parent))) continue;
    for (const entry of readDir(join(repoRoot, parent))) {
      if (!entry.isDir || entry.name.startsWith('.')) continue;
      const rel = `${parent}/${entry.name}`;
      if (exists(join(repoRoot, rel, 'package.json'))) out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

function packageDirEntries(nodeModulesDir, deps = {}) {
  const readDir =
    deps.readDir ??
    ((p) =>
      readdirSync(p, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      })));
  let entries;
  try {
    entries = readDir(nodeModulesDir);
  } catch {
    return [];
  }
  return entries.filter(
    (entry) =>
      !entry.name.startsWith('.') &&
      (entry.isDir === true || entry.isSymlink === true),
  );
}

/**
 * Find package-LOCAL installs whose directory exists but whose manifest is missing,
 * unreadable, or malformed. Direct-runtime resolution cannot catch this class for
 * devDependencies, and a package's own Vitest suite cannot run when its local Vitest
 * installation is the package that is partial.
 *
 * Root `node_modules` is deliberately not enumerated here. The runtime-import probes
 * cover the root's load-bearing packages, while this general scan targets npm's
 * workspace-local duplicate installs — the corruption shape that motivated the guard.
 */
export function findIncompleteWorkspacePackages({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  deps = {},
} = {}) {
  const readJson =
    deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const dirs = workspaceDirs ?? resolveWorkspaceDirs(repoRoot, deps);
  const incomplete = [];

  const inspectPackage = (workspace, packageName, packageDir) => {
    try {
      const manifest = readJson(join(packageDir, 'package.json'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('package manifest is not an object');
      }
    } catch {
      incomplete.push({ package: packageName, workspace });
    }
  };

  for (const workspace of dirs) {
    const nodeModulesDir = join(repoRoot, workspace, 'node_modules');
    for (const entry of packageDirEntries(nodeModulesDir, deps)) {
      if (!entry.name.startsWith('@')) {
        inspectPackage(
          workspace,
          entry.name,
          join(nodeModulesDir, entry.name),
        );
        continue;
      }
      const scopeDir = join(nodeModulesDir, entry.name);
      for (const scopedEntry of packageDirEntries(scopeDir, deps)) {
        inspectPackage(
          workspace,
          `${entry.name}/${scopedEntry.name}`,
          join(scopeDir, scopedEntry.name),
        );
      }
    }
  }

  return incomplete.sort(
    (a, b) =>
      a.workspace.localeCompare(b.workspace) ||
      a.package.localeCompare(b.package),
  );
}

const LOCAL_VERSION_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

/** Extract the semver portion from a direct npm declaration, including npm aliases. */
export function declaredVersionRange(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null;
  const raw = spec.trim();
  if (!raw.startsWith('npm:')) return raw;
  const separator = raw.lastIndexOf('@');
  return separator > 'npm:'.length ? raw.slice(separator + 1) : null;
}

/**
 * Find readable workspace-local installs whose version violates the workspace's
 * direct declaration. Transitive local packages and peers are deliberately ignored:
 * they are npm's graph to resolve, while direct declarations are stable intent we can
 * check without reintroducing `npm ls --all` peer noise.
 */
export function findInvalidWorkspacePackageVersions({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  deps = {},
} = {}) {
  const readJson =
    deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const dirs = workspaceDirs ?? resolveWorkspaceDirs(repoRoot, deps);
  const invalid = [];

  for (const workspace of dirs) {
    let workspaceManifest;
    try {
      workspaceManifest = readJson(join(repoRoot, workspace, 'package.json'));
    } catch {
      continue;
    }
    const declaredSpec = (packageName) => {
      for (const field of LOCAL_VERSION_FIELDS) {
        const spec = workspaceManifest?.[field]?.[packageName];
        if (typeof spec === 'string') return spec;
      }
      return null;
    };
    const inspectPackage = (packageName, packageDir) => {
      const declared = declaredSpec(packageName);
      if (declared === null) return;
      let installedManifest;
      try {
        installedManifest = readJson(join(packageDir, 'package.json'));
      } catch {
        return; // the incomplete-manifest leg owns this diagnosis
      }
      const installed = installedManifest?.version;
      const range = declaredVersionRange(declared);
      if (typeof installed !== 'string' || installed.trim() === '') {
        invalid.push({ package: packageName, workspace, declared, installed: null });
        return;
      }
      if (range === null) return;
      try {
        if (!satisfies(installed, range)) {
          invalid.push({ package: packageName, workspace, declared, installed });
        }
      } catch (error) {
        if (!(error instanceof UnsupportedRange)) throw error;
        // File/git/workspace/tag/prerelease declarations are outside the shared
        // matcher's intentionally bounded grammar. Skipping is safer than a false red.
      }
    };

    const nodeModulesDir = join(repoRoot, workspace, 'node_modules');
    for (const entry of packageDirEntries(nodeModulesDir, deps)) {
      if (!entry.name.startsWith('@')) {
        inspectPackage(entry.name, join(nodeModulesDir, entry.name));
        continue;
      }
      const scopeDir = join(nodeModulesDir, entry.name);
      for (const scopedEntry of packageDirEntries(scopeDir, deps)) {
        inspectPackage(
          `${entry.name}/${scopedEntry.name}`,
          join(scopeDir, scopedEntry.name),
        );
      }
    }
  }

  return invalid.sort(
    (a, b) =>
      a.workspace.localeCompare(b.workspace) ||
      a.package.localeCompare(b.package),
  );
}

/**
 * Resolve `dep` the way Node/Rolldown would from `fromDir`: that dir's own
 * node_modules, then every ancestor's, up to and including `repoRoot`. Returns
 * the resolved package directory, or null if it does not resolve anywhere on
 * that path.
 */
export function resolvedDepDir(repoRoot, fromDir, dep, exists = fsExistsSync) {
  let dir = resolve(fromDir);
  const root = resolve(repoRoot);
  for (;;) {
    const candidate = join(dir, 'node_modules', dep);
    if (exists(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir || !`${dir}${sep}`.startsWith(`${root}${sep}`)) return null;
    dir = parent;
  }
}

/**
 * Resolve `dep` the way Node/Rolldown would from `fromDir`: that dir's own
 * node_modules, then every ancestor's, up to and including `repoRoot`.
 */
export function resolvesOnDisk(repoRoot, fromDir, dep, exists = fsExistsSync) {
  return resolvedDepDir(repoRoot, fromDir, dep, exists) !== null;
}

/**
 * The edge-SATISFACTION leg (EI-21927402678532138): every directly-declared
 * runtime dependency that DOES resolve on disk (the "unextracted" leg above
 * already flags one that doesn't) but whose resolved version does not satisfy
 * the declaring workspace's range. `findInvalidWorkspacePackageVersions`
 * checks only workspace-LOCAL node_modules; a dependency HOISTED to a shared
 * ancestor (the common case in this npm-workspaces monorepo) never appears
 * there, so a hoisted placement that fell behind a workspace's declared range
 * — while package-lock.json's per-workspace manifest mirror still agrees with
 * that range, and a directory-presence check still says "resolves fine" —
 * passed every existing leg while `npm ls` was already calling it
 * ELSPROBLEMS/invalid. This is a read of an answer `npm ls --all --json`
 * already computes for the direct declarations we track, not a new resolver.
 */
export function findUnsatisfiedDeclaredDepRanges({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  deps = {},
} = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const exists = deps.existsSync ?? fsExistsSync;
  const dirs = workspaceDirs ?? resolveWorkspaceDirs(repoRoot, deps);

  const invalid = [];
  for (const rel of dirs) {
    let pkg;
    try {
      pkg = readJson(join(repoRoot, rel, 'package.json'));
    } catch {
      continue;
    }
    for (const [dep, declared] of Object.entries(pkg.dependencies ?? {})) {
      const range = declaredVersionRange(declared);
      if (range === null) continue;
      const dir = resolvedDepDir(repoRoot, join(repoRoot, rel), dep, exists);
      if (dir === null) continue; // the "unextracted" leg owns "missing entirely"
      let installedManifest;
      try {
        installedManifest = readJson(join(dir, 'package.json'));
      } catch {
        continue; // an unreadable manifest is the incomplete-package leg's business
      }
      const installed = installedManifest?.version;
      if (typeof installed !== 'string' || installed.trim() === '') continue;
      try {
        if (!satisfies(installed, range)) {
          invalid.push({ dep, workspace: rel, declared, installed });
        }
      } catch (error) {
        if (!(error instanceof UnsupportedRange)) throw error;
        // File/git/workspace/tag/prerelease declarations are outside the shared
        // matcher's intentionally bounded grammar. Skipping is safer than a false red.
      }
    }
  }

  return invalid.sort(
    (a, b) => a.workspace.localeCompare(b.workspace) || a.dep.localeCompare(b.dep),
  );
}

/**
 * The detector: every DIRECTLY-declared runtime dependency of each workspace that
 * does not resolve on disk. Returns `[{ dep, workspace }]` (empty = healthy).
 */
export function findUnextractedDeps({ repoRoot = REPO_ROOT, workspaceDirs, deps = {} } = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const exists = deps.existsSync ?? fsExistsSync;
  const dirs = workspaceDirs ?? resolveWorkspaceDirs(repoRoot, deps);

  const missing = [];
  for (const rel of dirs) {
    let pkg;
    try {
      pkg = readJson(join(repoRoot, rel, 'package.json'));
    } catch {
      continue; // a workspace without a readable package.json is not this check's business
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!resolvesOnDisk(repoRoot, join(repoRoot, rel), dep, exists)) {
        missing.push({ dep, workspace: rel });
      }
    }
  }
  return missing;
}

const RUNTIME_IMPORT_CHILD = `
try {
  await import(process.argv[1]);
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IMPORT_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  console.error(code + ': ' + message);
  process.exitCode = 1;
}
`;

function defaultRuntimeImportProbe({ repoRoot, specifier }) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", RUNTIME_IMPORT_CHILD, specifier],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  if (result.status === 0) return { ok: true };
  const detail =
    result.error?.message ??
    String(result.stderr ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ??
    `child exited ${result.status ?? result.signal ?? "without status"}`;
  return { ok: false, detail };
}

/**
 * Import critical runtime entrypoints in isolated child processes. Directory
 * existence alone cannot detect a package whose manifest survived but dist/native
 * contents were only partly extracted; a real import also walks transitive imports.
 */
export function findUnusableRuntimeDeps({
  repoRoot = REPO_ROOT,
  probeSpecifiers,
  deps = {},
} = {}) {
  const specifiers =
    probeSpecifiers ??
    resolveRuntimeContentProbes(repoRoot, RUNTIME_CONTENT_PROBES, deps);
  const probe = deps.probeRuntimeImport ?? defaultRuntimeImportProbe;
  const failures = [];
  for (const specifier of specifiers) {
    const result = probe({ repoRoot, specifier });
    if (result === true || result?.ok === true) continue;
    failures.push({
      specifier,
      detail:
        typeof result === "string"
          ? result
          : (result?.detail ?? "runtime import failed"),
    });
  }
  return failures;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `findUnextractedDeps` up to `attempts` times, `delayMs` apart, returning the
 * FINAL attempt's misses. A miss that clears on a later attempt was a
 * filesystem-sync race, not a real un-extracted dependency (WI-5769 retry8).
 */
export async function findUnextractedDepsWithRetry({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let missing = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    missing = findUnextractedDeps({ repoRoot, workspaceDirs, deps });
    if (missing.length === 0) return { missing: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, missing });
      await wait(delayMs);
    }
  }
  return { missing, attempts };
}

/** Retry the package-local manifest leg for the same filesystem-settle window. */
export async function findIncompleteWorkspacePackagesWithRetry({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let incomplete = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    incomplete = findIncompleteWorkspacePackages({
      repoRoot,
      workspaceDirs,
      deps,
    });
    if (incomplete.length === 0) return { incomplete: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, incomplete });
      await wait(delayMs);
    }
  }
  return { incomplete, attempts };
}

/** Retry the local-version leg for the same filesystem-settle window. */
export async function findInvalidWorkspacePackageVersionsWithRetry({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let invalid = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    invalid = findInvalidWorkspacePackageVersions({
      repoRoot,
      workspaceDirs,
      deps,
    });
    if (invalid.length === 0) return { invalid: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, invalid });
      await wait(delayMs);
    }
  }
  return { invalid, attempts };
}

/** Retry the edge-satisfaction leg for the same filesystem-settle window. */
export async function findUnsatisfiedDeclaredDepRangesWithRetry({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let invalid = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    invalid = findUnsatisfiedDeclaredDepRanges({ repoRoot, workspaceDirs, deps });
    if (invalid.length === 0) return { invalid: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, invalid });
      await wait(delayMs);
    }
  }
  return { invalid, attempts };
}

/** Retry the real-import leg for the same filesystem-settle window as the directory leg. */
export async function findUnusableRuntimeDepsWithRetry({
  repoRoot = REPO_ROOT,
  probeSpecifiers,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    failures = findUnusableRuntimeDeps({ repoRoot, probeSpecifiers, deps });
    if (failures.length === 0) return { failures: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, failures });
      await wait(delayMs);
    }
  }
  return { failures, attempts };
}

export function formatMissing(missing) {
  const lines = [
    `DECLARED_DEPS_UNEXTRACTED: ${missing.length} directly-declared dependency/ies are in package.json (and package-lock.json) but NOT on disk.`,
    'This is npm reify bookkeeping believing they are resolved — the classic symptom of concurrent',
    '`npm install` runs on this shared tree (EI-18666853411437489). It is NOT a code bug: an import of',
    'any of these fails with a confusing "cannot find module" / Rolldown "failed to resolve".',
    '',
  ];
  for (const m of missing) lines.push(`  - ${m.dep} (declared in ${m.workspace}/package.json)`);
  lines.push('', 'FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)');
  return lines.join('\n');
}

export function formatRuntimeFailures(failures) {
  const lines = [
    `RUNTIME_DEPS_UNUSABLE: ${failures.length} critical runtime entrypoint(s) failed a real import.`,
    "A package directory exists, but its entrypoint, native payload, or transitive import is incomplete.",
    "This is a partial npm extraction, not proof of an application-code regression.",
    "",
  ];
  for (const failure of failures)
    lines.push(`  - ${failure.specifier}: ${failure.detail}`);
  lines.push(
    "",
    "FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)",
  );
  return lines.join("\n");
}

export function formatIncompleteWorkspacePackages(incomplete) {
  const lines = [
    `WORKSPACE_PACKAGES_INCOMPLETE: ${incomplete.length} package-local node_modules director${incomplete.length === 1 ? 'y exists' : 'ies exist'} without a readable package.json.`,
    'The package directory is present but npm only partially extracted it. A package-local',
    'test runner can therefore fail before collecting a single test; this is dependency',
    'integrity damage, not evidence of an application-code regression.',
    '',
  ];
  for (const item of incomplete) {
    lines.push(
      `  - ${item.package} (${item.workspace}/node_modules/${item.package})`,
    );
  }
  lines.push(
    '',
    'FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)',
  );
  return lines.join('\n');
}

export function formatInvalidWorkspacePackageVersions(invalid) {
  const lines = [
    `WORKSPACE_PACKAGE_VERSION_INVALID: ${invalid.length} package-local install${invalid.length === 1 ? ' violates' : 's violate'} direct workspace declarations.`,
    'npm retained a readable but stale package-local node. Successful install/dedupe',
    'exit codes are not repair evidence while this mismatch remains.',
    '',
  ];
  for (const item of invalid) {
    lines.push(
      `  - ${item.package} (${item.workspace}/node_modules/${item.package}): installed ${item.installed ?? '<missing version>'}, declared ${item.declared}`,
    );
  }
  lines.push(
    '',
    'FIX: remove the stale package-local node/lock entry, then run the serialized install and re-check this guard.',
  );
  return lines.join('\n');
}

export function formatUnsatisfiedDeclaredDepRanges(invalid) {
  const lines = [
    `DECLARED_DEPS_UNSATISFIED: ${invalid.length} directly-declared dependency/ies resolve on disk to a version that does NOT satisfy the declaring workspace's range.`,
    "npm's own reify bookkeeping (package-lock.json's per-workspace manifest mirror) can agree the",
    'tree is up to date while the shared/hoisted placement never re-resolved to match — `npm ls`',
    'calls this ELSPROBLEMS/invalid; a directory-presence check alone cannot see it (EI-21927402678532138).',
    '',
  ];
  for (const item of invalid) {
    lines.push(
      `  - ${item.dep} (declared in ${item.workspace}/package.json): installed ${item.installed}, declared ${item.declared}`,
    );
  }
  lines.push(
    '',
    'FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)',
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const workspaces = [];
  let attempts = 3;
  let delayMs = 2000;
  for (const arg of argv) {
    if (arg.startsWith('--workspace=')) workspaces.push(arg.slice('--workspace='.length));
    else if (arg.startsWith('--attempts=')) attempts = Number(arg.slice('--attempts='.length)) || attempts;
    else if (arg.startsWith('--delay-ms=')) delayMs = Number(arg.slice('--delay-ms='.length)) || delayMs;
  }
  return { workspaces, attempts, delayMs };
}

export async function main(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  const { workspaces, attempts, delayMs } = parseArgs(argv);
  const workspaceDirs = workspaces.length > 0 ? workspaces.map((w) => relative(repoRoot, resolve(repoRoot, w)) || w) : undefined;

  const { missing } = await findUnextractedDepsWithRetry({
    repoRoot,
    workspaceDirs,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, missing: seen }) =>
      console.error(
        `dep-check attempt ${attempt}/${total}: ${seen.length} missing — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });

  if (missing.length > 0) {
    console.error(formatMissing(missing));
    return 1;
  }

  const { incomplete } = await findIncompleteWorkspacePackagesWithRetry({
    repoRoot,
    workspaceDirs,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, incomplete: seen }) =>
      console.error(
        `workspace-package-check attempt ${attempt}/${total}: ${seen.length} incomplete package-local install(s) — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });
  if (incomplete.length > 0) {
    console.error(formatIncompleteWorkspacePackages(incomplete));
    return 1;
  }

  const { invalid } = await findInvalidWorkspacePackageVersionsWithRetry({
    repoRoot,
    workspaceDirs,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, invalid: seen }) =>
      console.error(
        `workspace-package-version-check attempt ${attempt}/${total}: ${seen.length} invalid package-local version(s) — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });
  if (invalid.length > 0) {
    console.error(formatInvalidWorkspacePackageVersions(invalid));
    return 1;
  }

  const { invalid: unsatisfiedRanges } = await findUnsatisfiedDeclaredDepRangesWithRetry({
    repoRoot,
    workspaceDirs,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, invalid: seen }) =>
      console.error(
        `dep-range-check attempt ${attempt}/${total}: ${seen.length} unsatisfied declared range(s) — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });
  if (unsatisfiedRanges.length > 0) {
    console.error(formatUnsatisfiedDeclaredDepRanges(unsatisfiedRanges));
    return 1;
  }

  const probeSpecifiers = resolveRuntimeContentProbes(repoRoot);
  const { failures } = await findUnusableRuntimeDepsWithRetry({
    repoRoot,
    probeSpecifiers,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, failures: seen }) =>
      console.error(
        `runtime-dep-check attempt ${attempt}/${total}: ${seen.length} failed import(s) — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });
  if (failures.length > 0) {
    console.error(formatRuntimeFailures(failures));
    return 1;
  }

  console.log(
    `DECLARED_DEPS_OK: every directly-declared dependency resolves on disk (${(workspaceDirs ?? resolveWorkspaceDirs(repoRoot)).length} workspace(s)); package-local manifests and direct versions are valid; ${probeSpecifiers.length} critical runtime import(s) load`,
  );
  return 0;
}

/**
 * Only run as the named CLI entry. Esbuild assigns bundled modules the host
 * bundle's `import.meta.url`, so URL equality would mistake an imported copy for
 * the entry module and run this dependency scan during Hono host startup.
 */
export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  typeof entryPath === 'string' &&
  /(?:^|[\\/])check-declared-deps-extracted\.mjs$/.test(entryPath);

if (isDirectCliInvocation()) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`DECLARED_DEPS_CHECK_ERROR ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
