/**
 * Detect a git submodule that installs its OWN dependency tree but has not been installed.
 *
 * WHY THIS EXISTS (WI-39358)
 * `papercusp-desktop` is a git submodule with its own `package-lock.json`, and it is NOT
 * one of the monorepo root's npm `workspaces`. That combination is easy to miss and has a
 * silent failure mode: a root `npm install` looks like it installed everything, because for
 * every OTHER package in the tree it did. The submodule stays empty.
 *
 * Measured 2026-08-15: after the `rm -rf /home` incident (WI-39347) the tree was re-cloned
 * and the root install re-run, but nothing installed the desktop submodule. The owner's
 * `npm run dev` then failed with bash's generic
 *
 *     bin/tauri-guarded: line 100: exec: tauri: not found
 *
 * which names neither the cause nor the one-command fix, and reads like a broken toolchain
 * rather than a missing install. The real fix was a single command.
 *
 * WHAT THIS ASSERTS. Only submodules that carry BOTH a package.json and a package-lock.json
 * are in scope — the lockfile is what declares "this tree resolves its own dependencies
 * independently of the root". A submodule without one is either dependency-free or
 * genuinely covered by the root install, and is skipped.
 *
 * The check is deliberately generic over submodules rather than special-cased to
 * papercusp-desktop: the point is that the next submodule to acquire its own lockfile is
 * covered by construction, not by someone remembering to extend a hardcoded list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Parse JSON without letting a malformed file take down the whole doctor run. */
function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The shim names npm would link into node_modules/.bin for a package.
 * npm accepts `bin` as a string (shim named after the unscoped package name) or an
 * object (its keys are the shim names).
 */
export function binShimNames(pkgName, binField) {
  if (!binField) return [];
  if (typeof binField === 'string') {
    const unscoped = pkgName.startsWith('@') ? pkgName.split('/')[1] : pkgName;
    return unscoped ? [unscoped] : [];
  }
  if (typeof binField === 'object') return Object.keys(binField);
  return [];
}

/**
 * The command that repairs a given submodule. `install:safe` (not a bare `npm install`)
 * because this is a shared multi-agent tree, and it takes an explicit --repo-root whose
 * realpath keys its lock — so a submodule install does not contend with a root install.
 */
export function repairCommand(submodulePath) {
  return `npm run install:safe -- --repo-root ${submodulePath}`;
}

/**
 * Root `workspaces` patterns, as declared in the monorepo root package.json.
 * A submodule that is ALSO a root workspace is installed BY the root install, and npm
 * hoists its dependencies to the root node_modules — so requiring them inside the
 * submodule's own node_modules would be wrong. See isRootWorkspace.
 */
export function rootWorkspacePatterns(repoRoot) {
  const manifest = readJsonOrNull(join(repoRoot, 'package.json'));
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (Array.isArray(workspaces?.packages)) return workspaces.packages;
  return [];
}

/**
 * Does `submodulePath` fall under a root workspace pattern?
 *
 * FALSE POSITIVE THIS PREVENTS (found by running the widened check against the live tree,
 * 2026-08-15): libs/generic/resumable-download is BOTH a git submodule with its own
 * package-lock.json AND a root workspace. npm hoisted its `typescript` devDependency to the
 * root node_modules, leaving only the non-hoistable subset in its own — which a naive
 * "declared dep must sit in MY node_modules" test reports as a broken install. It is not
 * broken; that is ordinary npm hoisting.
 */
export function isRootWorkspace(submodulePath, patterns) {
  const normalized = submodulePath.replace(/\/+$/, '');
  return patterns.some((pattern) => {
    const p = pattern.replace(/\/+$/, '');
    if (p === normalized) return true;
    if (p.endsWith('/*')) return dirname(normalized) === p.slice(0, -2);
    return false;
  });
}

/**
 * Walk node's real resolution order: node_modules directories from `startDir` up to
 * `repoRoot` inclusive. A dependency satisfied by a hoisted copy higher in the tree is
 * genuinely resolvable, and reporting it as missing would be a lie about the failure mode.
 */
function resolutionDirs(repoRoot, startDir) {
  const dirs = [];
  let current = startDir;
  for (;;) {
    dirs.push(join(current, 'node_modules'));
    if (current === repoRoot || dirname(current) === current) break;
    current = dirname(current);
  }
  return dirs;
}

const resolvesInChain = (chain, relative) => chain.some((nm) => existsSync(join(nm, relative)));

/**
 * @returns {Array<{ path: string, reason: string, fix: string }>} one entry per
 *   submodule whose own dependency tree is missing or incomplete. Empty === healthy.
 */
export function findIncompleteSubmoduleInstalls({ repoRoot, submodulePaths, rootWorkspaces }) {
  const problems = [];
  const patterns = rootWorkspaces ?? rootWorkspacePatterns(repoRoot);

  for (const submodulePath of submodulePaths) {
    const absolute = join(repoRoot, submodulePath);
    // An uninitialized / absent submodule is a different fault, already covered by the
    // worktree-sanity check. Saying it twice would just make that message harder to find.
    if (!existsSync(absolute)) continue;

    // THE DISCRIMINATOR. A submodule that is also a root workspace is installed by the
    // root install, with its dependencies hoisted to the root node_modules. Only a
    // submodule OUTSIDE the workspace set has to be installed on its own — which is
    // exactly papercusp-desktop's situation, and exactly why the root install missed it.
    if (isRootWorkspace(submodulePath, patterns)) continue;

    const manifestPath = join(absolute, 'package.json');
    const lockPath = join(absolute, 'package-lock.json');
    if (!existsSync(manifestPath) || !existsSync(lockPath)) continue;

    const manifest = readJsonOrNull(manifestPath);
    if (!manifest) continue;

    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    const declaredNames = Object.keys(declared);
    if (declaredNames.length === 0) continue;

    // Resolve the way node does — up the directory chain — so a legitimately hoisted copy
    // is not reported as missing.
    const chain = resolutionDirs(repoRoot, absolute);
    const missingPackages = declaredNames.filter((name) => !resolvesInChain(chain, name));

    if (missingPackages.length > 0) {
      const nothingInstalled = !existsSync(join(absolute, 'node_modules'));
      problems.push({
        path: submodulePath,
        reason: nothingInstalled
          ? `node_modules is absent and ${missingPackages.length} declared ` +
            `dependenc${missingPackages.length === 1 ? 'y is' : 'ies are'} unresolvable ` +
            `(${missingPackages.slice(0, 4).join(', ')}). This submodule is NOT an npm ` +
            'workspace of the root, so a root install does not cover it.'
          : `declared package(s) unresolvable from this submodule: ${missingPackages.join(', ')}`,
        fix: repairCommand(submodulePath),
      });
      continue;
    }

    // The symptom that actually reaches a human is a missing BINARY, not a missing
    // directory — `exec: tauri: not found` came from an absent .bin shim. npm puts every
    // node_modules/.bin in the same chain on PATH, so check the chain, not just the leaf.
    const missingShims = [];
    for (const name of declaredNames) {
      const home = chain.find((nm) => existsSync(join(nm, name)));
      if (!home) continue;
      const depManifest = readJsonOrNull(join(home, name, 'package.json'));
      if (!depManifest) continue;
      for (const shim of binShimNames(name, depManifest.bin)) {
        if (!resolvesInChain(chain, join('.bin', shim))) missingShims.push(`${shim} (from ${name})`);
      }
    }
    if (missingShims.length > 0) {
      problems.push({
        path: submodulePath,
        reason: `no executable shim on PATH for: ${missingShims.join(', ')}`,
        fix: repairCommand(submodulePath),
      });
    }
  }

  return problems;
}

/** Formats problems for a human staring at a failing check. Exported for the test. */
export function formatProblems(problems) {
  return problems
    .map((p) => `${p.path}: ${p.reason}\n      fix: ${p.fix}`)
    .join('\n    ');
}
