#!/usr/bin/env node
/**
 * Inventory the structural boundary of the green-checkpoint gate.
 *
 * This is deliberately a report/inventory tool, not another release leg.  It answers
 * the question the gate cannot answer for itself: which declared workspaces and git
 * submodules are visible to changed-file matching, and which are reached by one of
 * the checkpoint's typecheck invocations?  Keeping the set difference in a checked-in
 * JSON file makes a new blind spot reviewable when topology or gate wiring changes.
 *
 *   node scripts/gate-coverage-audit.mjs              # refresh scripts/gate-coverage-map.json
 *   node scripts/gate-coverage-audit.mjs --check     # fail when the checked-in map is stale
 *   node scripts/gate-coverage-audit.mjs --json      # print the report instead of writing it
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_GATE_SOURCE = 'apps/operator/lib/release/green-checkpoint.ts';
export const DEFAULT_MAP_PATH = 'scripts/gate-coverage-map.json';

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

/** Convert an npm workspace-style glob to a path matcher. */
export function globToRegExp(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

export function workspacePatternsFromManifest(manifest) {
  if (Array.isArray(manifest?.workspaces)) return manifest.workspaces;
  if (Array.isArray(manifest?.workspaces?.packages)) return manifest.workspaces.packages;
  return [];
}

/** Read the root manifest's workspace patterns without relying on npm internals. */
export function readWorkspacePatterns(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return workspacePatternsFromManifest(manifest);
}

/** Parse declared submodule paths from the canonical gitmodules file. */
export function parseGitmodules(text) {
  return [...new Set(
    [...text.matchAll(/^\s*path\s*=\s*(\S+)\s*$/gm)].map((match) => match[1]),
  )].sort();
}

function walkPackageJson(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walkPackageJson(root, join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Discover package manifests selected by the root npm workspace patterns.
 *
 * The walk is intentionally filesystem-based: a workspace pattern that points at a
 * new package is visible immediately, while generated/node_modules trees are excluded
 * so a stale install cannot inflate the inventory.
 */
export function discoverWorkspaces(root, patterns = readWorkspacePatterns(root)) {
  const matches = [];
  for (const manifestPath of walkPackageJson(root)) {
    const rel = relative(root, dirname(manifestPath)).replaceAll('\\', '/');
    if (!rel || rel === '.') continue;
    if (!patterns.some((pattern) => globToRegExp(pattern.replace(/\/$/, '')).test(rel))) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
    matches.push({
      path: rel,
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      manifestReadable: manifest !== null,
      hasTypecheckScript: typeof manifest?.scripts?.typecheck === 'string',
      hasTsconfig: existsSync(join(dirname(manifestPath), 'tsconfig.json')),
    });
  }
  return matches.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Extract the executable typecheck script names from green-checkpoint.ts.
 * Comments are not used as evidence: only checkNpmScript(...) and npm run ... calls
 * are invocation sites, so a prose mention cannot make a gate look reachable.
 */
export function parseTypecheckInvocations(source) {
  const found = new Set();
  const checkScript = /\bcheckNpmScript\s*\([\s\S]*?["'](lint:tsc(?:[:a-z0-9-]+)?)["']/g;
  const npmRun = /\bexec\s*\(\s*["']npm["']\s*,\s*\[[\s\S]*?["']run["']\s*,\s*["'](lint:tsc(?:[:a-z0-9-]+)?)["']/g;
  for (const match of source.matchAll(checkScript)) found.add(match[1]);
  for (const match of source.matchAll(npmRun)) found.add(match[1]);
  return [...found].sort();
}

/**
 * The gate's executable legs have stable, documented scopes.  The script names are
 * discovered from the source above; these scope rules only translate an invoked leg
 * into the paths its own typecheck project can reach.
 */
export const TYPECHECK_SCOPE_RULES = Object.freeze({
  'lint:tsc': ['packages/operator-core/**'],
  'lint:tsc:operator': ['apps/operator/**'],
  'lint:tsc:orchestrator': ['libs/papercusp/packages/orchestrator/**'],
  'lint:tsc:papercusp-libs': ['libs/papercusp/**'],
  'lint:tsc:scripts': ['scripts/**'],
  // The current fan-out walks the whole `libs` root, then excludes the papercusp
  // submodule by prefix.  Keeping the broad root here lets the inventory notice a
  // newly added libs/<name> package without silently reverting to libs/generic only.
  'lint:tsc:workspaces': ['apps/**', 'packages/**', 'libs/**'],
});

/**
 * Parse changed-file scope patterns that are named in executable gate diagnostics.
 * The gate's workspace leg emits these roots in its failure banner; the explicit
 * operator-core preflight is also a real matcher.  We keep only repo-root patterns,
 * not incidental paths such as logs or fixture filenames.
 */
export function parseDiffScopePatterns(source) {
  const patterns = new Set();
  if (source.includes('startsWith("packages/operator-core/"')) {
    patterns.add('packages/operator-core/**');
  }
  if (/apps\/\*/.test(source)) patterns.add('apps/**');
  if (/packages\/\*/.test(source)) patterns.add('packages/**');
  if (/libs\/generic\/\*/.test(source)) patterns.add('libs/generic/**');
  if (/scripts\/\*\./.test(source)) patterns.add('scripts/**');
  return [...patterns].sort();
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path) || globToRegExp(pattern).test(`${path}/index`));
}

function typecheckPatterns(invocations) {
  return [...new Set(invocations.flatMap((script) => TYPECHECK_SCOPE_RULES[script] ?? []))].sort();
}

/**
 * `lint:tsc:workspaces` is a fan-out, not a promise that every directory beneath its
 * roots is compiled.  Apps/packages opt in with a `typecheck` script; the promoted
 * libs roots opt in with a tsconfig.  The per-project legs are explicit and therefore
 * reachable whenever their path is in scope, while a bare submodule root is not itself
 * a typecheck project.  Applying this distinction prevents the inventory from turning
 * a broad glob into the same vacuous green it is meant to expose.
 */
function workspaceTypecheckReachable(entry, invocations) {
  const path = entry.path;
  if (path === 'packages/operator-core') return invocations.includes('lint:tsc');
  if (path === 'apps/operator') return invocations.includes('lint:tsc:operator');
  if (path === 'libs/papercusp/packages/orchestrator') return invocations.includes('lint:tsc:orchestrator');
  if (path === 'libs/papercusp') return false;
  if (path.startsWith('libs/papercusp/')) {
    return invocations.includes('lint:tsc:papercusp-libs') && entry.hasTypecheckScript;
  }
  if (path.startsWith('apps/') || path.startsWith('packages/')) {
    return invocations.includes('lint:tsc:workspaces') && entry.hasTypecheckScript;
  }
  if (path.startsWith('libs/') && !path.startsWith('libs/papercusp/')) {
    return invocations.includes('lint:tsc:workspaces') && (entry.hasTypecheckScript || entry.hasTsconfig);
  }
  return false;
}

function sourceSha(source) {
  return createHash('sha256').update(source).digest('hex');
}

/** Build the deterministic inventory report. */
export function buildCoverageReport({
  root = ROOT,
  gateSourcePath = DEFAULT_GATE_SOURCE,
  workspacePatterns,
  gitmodulesText,
} = {}) {
  const source = readFileSync(join(root, gateSourcePath), 'utf8');
  const invocations = parseTypecheckInvocations(source);
  const diffPatterns = parseDiffScopePatterns(source);
  const checkedPatterns = typecheckPatterns(invocations);
  const workspaces = discoverWorkspaces(root, workspacePatterns ?? readWorkspacePatterns(root));
  const submodules = parseGitmodules(
    gitmodulesText ?? (existsSync(join(root, '.gitmodules')) ? readFileSync(join(root, '.gitmodules'), 'utf8') : ''),
  );
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, {
    path: workspace.path,
    name: workspace.name,
    manifestReadable: workspace.manifestReadable,
    hasTypecheckScript: workspace.hasTypecheckScript,
    hasTsconfig: workspace.hasTsconfig,
    is_submodule: false,
  }]));
  for (const path of submodules) {
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      name: existing?.name ?? null,
      manifestReadable: existing?.manifestReadable ?? existsSync(join(root, path, 'package.json')),
      hasTypecheckScript: existing?.hasTypecheckScript ?? false,
      hasTsconfig: existing?.hasTsconfig ?? existsSync(join(root, path, 'tsconfig.json')),
      is_submodule: true,
    });
  }
  const entries = [...byPath.values()]
    .map((entry) => ({
      ...entry,
      typechecked: workspaceTypecheckReachable(entry, invocations) && matchesAny(entry.path, checkedPatterns),
      diff_visible: matchesAny(entry.path, diffPatterns),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const uncovered = entries.filter((entry) => !entry.typechecked || !entry.diff_visible).map((entry) => ({
    path: entry.path,
    missing: [
      ...(entry.typechecked ? [] : ['typecheck']),
      ...(entry.diff_visible ? [] : ['diff']),
    ],
  }));
  const zeroCoverage = entries.filter((entry) => !entry.typechecked && !entry.diff_visible).length;
  const coverageMap = Object.fromEntries(entries.map((entry) => [entry.path, {
    typechecked: entry.typechecked,
    diff_visible: entry.diff_visible,
    is_submodule: entry.is_submodule,
  }]));
  return {
    schemaVersion: 1,
    source: gateSourcePath,
    sourceSha256: sourceSha(source),
    typecheckInvocations: invocations,
    typecheckScopePatterns: checkedPatterns,
    diffScopePatterns: diffPatterns,
    // The compact workspace → booleans map is the review-facing artifact. `entries`
    // below retains manifest evidence used to explain each row and to test discovery.
    coverageMap,
    entries,
    summary: {
      workspaces: workspaces.length,
      submodules: submodules.length,
      entries: entries.length,
      typechecked: entries.filter((entry) => entry.typechecked).length,
      diffVisible: entries.filter((entry) => entry.diff_visible).length,
      uncovered: uncovered.length,
      zeroCoverage,
    },
    uncovered,
  };
}

function mapPath(root = ROOT) {
  return join(root, DEFAULT_MAP_PATH);
}

function main() {
  const report = buildCoverageReport();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const check = process.argv.includes('--check');
  const print = process.argv.includes('--json');
  const target = mapPath();
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== serialized) {
      console.error(`✖ gate-coverage-audit: ${DEFAULT_MAP_PATH} is stale; run node scripts/gate-coverage-audit.mjs`);
      process.exitCode = 1;
    }
  } else if (!print) {
    writeFileSync(target, serialized);
  }
  if (print) {
    // `--json` is machine-facing: keep stdout valid JSON so callers can pipe it to
    // jq or archive it.  Human summary lines remain available in the normal mode.
    process.stdout.write(serialized);
    return;
  }
  const { entries, summary, uncovered } = report;
  console.log(
    `gate-coverage-audit: ${summary.zeroCoverage}/${entries.length} workspaces have zero gate coverage; ` +
      `${summary.typechecked}/${entries.length} entries typechecked, ` +
      `${summary.diffVisible}/${entries.length} diff-visible, ${uncovered.length} uncovered ` +
      `(inventory only; use --check to detect map drift)`,
  );
  for (const item of uncovered.slice(0, 10)) console.log(`  · ${item.path}: missing ${item.missing.join(' + ')}`);
  if (uncovered.length > 10) console.log(`  · … ${uncovered.length - 10} more`);
}

if (isCliEntry(import.meta.url)) main();
