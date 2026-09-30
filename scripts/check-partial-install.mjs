#!/usr/bin/env node
/**
 * check-partial-install.mjs — detect a node_modules entry that EXISTS but is HOLLOW:
 * a package directory with no readable package.json. That is the exact on-disk
 * signature of a partial install / partial deletion, and NOTHING in this repo
 * asserted it before (EI-20863794002653922, the deferred detector half of WI-39899).
 *
 * WHY THIS EXISTS — the incident it is the recurrence guard for:
 * the 03:35Z git-sync node_modules untracking deleted 135 files out of
 * libs/generic/sse/node_modules — the ENTIRE `typescript` package (132 files) and 3 of
 * vitest's (dist/cli.js, dist/node.js, package.json). `@papercusp/sse :: test` then died
 * with ERR_MODULE_NOT_FOUND on vitest's own CLI before a single test ran, red-lining the
 * green-checkpoint gate. The directories were still THERE; they were just empty shells.
 *
 * The cost of having no detector was not the breakage, it was the DIAGNOSIS. The gate
 * reds with a MODULE_NOT_FOUND that names a path, not a cause, so an agent triaging it
 * starts by looking for a broken test — and there is no broken test. This guard turns
 * that into a named, actionable verdict: which workspace, which package, and the fix.
 *
 *   node scripts/check-partial-install.mjs          # check (npm run lint:partial-install)
 *   node scripts/check-partial-install.mjs --list   # print the measured population
 *   node scripts/check-partial-install.mjs --root <dir>
 *
 * Exit 0 = every present package directory has a readable package.json. Exit 1 = at
 * least one hollow entry, each named with its workspace and the repair command.
 *
 * ZERO-TOLERANCE, NO BASELINE — deliberately unlike the shrink-only guards in this
 * directory. Those grandfather pre-existing SOURCE debt that is expensive to fix all at
 * once. A hollow package is not debt: it is live environment corruption, it is never
 * intentional, and it is repaired by one `npm install`. The measured population at
 * authoring time was 0 across 2,650 package directories in 86 workspaces (144ms), so
 * there was nothing to grandfather and there should never be.
 *
 * WHY NOT EXTEND scripts/assert-workspace-links.mjs — asked and answered, because it is
 * the closest existing guard and looks like the natural host. It cannot cover this:
 *   1. Its population is ROOT WORKSPACE LINKS in the root node_modules. This damage was
 *      to THIRD-PARTY packages inside a PACKAGE-LOCAL node_modules — a different walk
 *      over a different set.
 *   2. More decisively, its presence test is `lstatSync(linkPath)`, and its own comment
 *      says "symlink (workspace) OR real dir both count as linked". A hollow directory
 *      IS a real dir, so it satisfies that check. Pointed at the sse damage, that guard
 *      reports ✓. The two guards ask different questions: it asks "is the entry there?",
 *      this asks "is the entry USABLE?".
 * Tightening assert-workspace-links to also demand a readable manifest is a defensible
 * separate change, but it gates the mac release build (papercusp-desktop/bin/mac-vm-build.sh),
 * so widening what it fails on does not belong in this one.
 *
 * The detector (`findHollowPackages`) is exported and unit-tested against synthetic
 * fixtures in packages/operator-core/lib/__tests__/partial-install-guard.test.ts —
 * synthetic because a test that mutated a real node_modules to prove the guard works
 * would be the very corruption this guard exists to detect.
 */
import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Expand the root package.json `workspaces` globs to concrete workspace directories.
 * Only the `dir/*` shape occurs in this repo; anything else is treated as a literal
 * path. A pattern entry that resolves to no package.json is skipped rather than
 * guessed at — this guard reports corruption, so it must not invent members.
 */
export function expandWorkspaceDirs(patterns, root) {
  const dirs = [];
  for (const pattern of patterns ?? []) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      if (!existsSync(join(root, base))) continue;
      let entries;
      try {
        entries = readdirSync(join(root, base));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const dir = join(base, entry);
        if (existsSync(join(root, dir, 'package.json'))) dirs.push(dir);
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      dirs.push(pattern);
    }
  }
  return dirs.sort();
}

/**
 * True when `dir` holds a package.json we can read AND parse.
 *
 * Parse, not just existence: the sse damage left vitest's package.json deleted outright,
 * but a truncated or half-written manifest is the same failure to the module resolver
 * and must not read as healthy here.
 */
function hasReadableManifest(dir) {
  try {
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify one candidate entry inside a node_modules directory.
 * Returns null when the entry is healthy or is not a package directory at all.
 */
function classifyEntry(absPath) {
  // lstat first: a DANGLING symlink is present-but-unusable, the same class as a hollow
  // dir, and stat() alone cannot tell it apart from a genuinely absent entry.
  let link;
  try {
    link = lstatSync(absPath);
  } catch {
    return null; // vanished between readdir and here — a race, not a finding
  }

  if (link.isSymbolicLink()) {
    let target;
    try {
      target = statSync(absPath); // follows the link
    } catch {
      return 'dangling-symlink';
    }
    if (!target.isDirectory()) return null;
    return hasReadableManifest(absPath) ? null : 'hollow';
  }

  // A plain FILE in node_modules (.package-lock.json and friends) is not a package.
  if (!link.isDirectory()) return null;

  return hasReadableManifest(absPath) ? null : 'hollow';
}

/**
 * Walk one node_modules directory, descending exactly one extra level into `@scope/`
 * directories. A scope directory legitimately has no package.json of its own, so
 * treating it as a package would produce a false positive on every scoped dependency.
 */
function scanNodeModules(nodeModulesDir, workspace, findings) {
  let entries;
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return 0;
  }

  let scanned = 0;
  for (const entry of entries) {
    // .bin, .package-lock.json, .cache, .vite — tooling state, never packages.
    if (entry.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry);

    if (entry.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const name of scoped) {
        if (name.startsWith('.')) continue;
        scanned++;
        const kind = classifyEntry(join(entryPath, name));
        if (kind) findings.push({ workspace, pkg: `${entry}/${name}`, kind });
      }
      continue;
    }

    scanned++;
    const kind = classifyEntry(entryPath);
    if (kind) findings.push({ workspace, pkg: entry, kind });
  }
  return scanned;
}

/**
 * THE DETECTOR. Walks the root node_modules and every workspace's package-local
 * node_modules, and returns each present-but-unusable package entry.
 *
 * @returns {{ findings: Array<{workspace: string, pkg: string, kind: 'hollow'|'dangling-symlink'}>,
 *             workspacesScanned: number, nodeModulesScanned: number, packagesScanned: number }}
 */
export function findHollowPackages(root) {
  let rootPkg;
  try {
    rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // No readable root manifest means we cannot enumerate workspaces. Report nothing
    // rather than guessing — a guard that invents a population is worse than absent.
    return {
      findings: [],
      workspacesScanned: 0,
      nodeModulesScanned: 0,
      packagesScanned: 0,
    };
  }

  const workspaceDirs = ['', ...expandWorkspaceDirs(rootPkg.workspaces, root)];
  const findings = [];
  let nodeModulesScanned = 0;
  let packagesScanned = 0;

  for (const dir of workspaceDirs) {
    const nodeModulesDir = join(root, dir, 'node_modules');
    if (!existsSync(nodeModulesDir)) continue;
    nodeModulesScanned++;
    packagesScanned += scanNodeModules(nodeModulesDir, dir || '<root>', findings);
  }

  findings.sort(
    (a, b) => a.workspace.localeCompare(b.workspace) || a.pkg.localeCompare(b.pkg),
  );
  return {
    findings,
    workspacesScanned: workspaceDirs.length,
    nodeModulesScanned,
    packagesScanned,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const rootFlag = argv.indexOf('--root');
  if (rootFlag !== -1 && argv[rootFlag + 1]) root = resolve(argv[rootFlag + 1]);

  const { findings, workspacesScanned, nodeModulesScanned, packagesScanned } =
    findHollowPackages(root);

  if (argv.includes('--list')) {
    console.log(
      `partial-install census: workspaces=${workspacesScanned} withNodeModules=${nodeModulesScanned} packagesScanned=${packagesScanned} findings=${findings.length}`,
    );
    for (const f of findings) console.log(`  ${f.kind}\t${f.workspace}\t${f.pkg}`);
    process.exit(0);
  }

  if (findings.length === 0) {
    console.log(
      `✓ partial-install: every installed package has a readable manifest (${packagesScanned} package dir(s) across ${nodeModulesScanned} node_modules).`,
    );
    process.exit(0);
  }

  console.error('');
  console.error(
    '✗ partial-install guard FAILED — node_modules contains present-but-UNUSABLE entries.',
  );
  console.error(
    '  This is environment corruption, NOT a test or source failure. A run against this',
  );
  console.error(
    '  checkout will die with ERR_MODULE_NOT_FOUND naming a path, not a cause.',
  );
  console.error('');
  for (const f of findings) {
    const why =
      f.kind === 'hollow'
        ? 'directory exists but its package.json is missing or unparseable'
        : 'symlink present but its target does not exist';
    console.error(`    ${f.workspace}  ->  ${f.pkg}`);
    console.error(`        ${f.kind}: ${why}`);
  }
  console.error('');
  console.error('  FIX: reinstall so the manifest is restored, from the repo root:');
  console.error('      npm run install:safe');
  console.error(
    '  (install:safe serializes concurrent agents; a bare `npm install` rewrites',
  );
  console.error("   node_modules/.bin under other agents' in-flight test runs.)");
  console.error('');
  console.error(
    `  Scanned ${packagesScanned} package dir(s) across ${nodeModulesScanned} node_modules; ${findings.length} unusable.`,
  );
  process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
