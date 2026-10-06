#!/usr/bin/env node
/**
 * Run exact Vitest or Node:test files from the runner that owns each file.
 *
 * A root-level `vitest --config path/to/config path/to/test` is subtly wrong for
 * package configs whose include globs are relative to their workspace. This router
 * discovers the owning cwd/config, asks `vitest list` what would actually execute,
 * fails before the run when any requested file matched zero tests, and then runs the
 * exact matched files. Non-test source inputs are reported as unsupported and skipped;
 * they are never misreported as collection failures. One command therefore works from
 * any directory in the repo.
 *
 * Usage: npm run test:file -- path/to/a.test.ts [path/to/b.test.ts] [<vitest args>]
 * Vitest args may follow the file list directly or after an explicit `--` separator.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg, availableParallelism, tmpdir } from 'node:os';
import { applyWorkerCapEnv } from './lib/worker-cap.mjs';
import {
  parseSummaryFailedCounts,
  parseTransformFailure,
  stripVitestAnsi,
  testsExecutedFrom,
  testsSkippedFrom,
} from './lib/vitest-summary.mjs';
import {
  createProgressAwareWatchdog,
  killSpawnedProcessTree,
  parseBatchProgress,
} from './lib/batch-watchdog.mjs';
import { formatTaskOutcomeFields } from './lib/task-progress-line.mjs';
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  governedProcessIdempotencyKey,
  isRetryableAdmissionFailure,
  runGovernedTestProcess,
} from './lib/governed-test-process.mjs';
import {
  createPreemptMarkerExclusive,
  reapPreemptMarkerDebris,
} from './lib/preempt-markers.mjs';

// Re-exported so existing importers (packages/operator-core/lib/__tests__/
// preempt-marker-stale-takeover.test.ts) keep reaching it here unchanged. The
// IMPLEMENTATION moved to lib/preempt-markers.mjs (EI-21884510946030513) so
// `test:affected` — the runner the green-checkpoint gate invokes — can share the
// one liveness rule instead of carrying a second copy that had no rule at all.
export { reapPreemptMarkerDebris };

// Re-exported so this module's own callers and tests (packages/operator-core/lib/__tests__/
// test-file-router.test.ts) keep importing it from here unchanged. The IMPLEMENTATION moved to
// lib/vitest-summary.mjs (WI-37607) so `test:affected` can share the one detector instead of
// having none — see that function's header for why the split existed and what it cost.
export { parseTransformFailure };
// P-006 / R-8 sub-req 5: both MOVED to lib/vitest-summary.mjs when affected-tests.mjs — the path
// the release promise runs on — became their second consumer. Re-exported so this router stays
// their public name for every existing caller, exactly as parseTransformFailure is above.
export { testsExecutedFrom, testsSkippedFrom };

export function unscopedFocusedRunWarning(env = process.env) {
  if (env.PAPERCUSP_TEST_RUN_HARNESS?.trim()) return null;
  return 'Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).';
}

/**
 * A governed child that never starts has no test verdict. Keep the reason for
 * that refusal typed all the way to the terminal marker: retryable PG
 * contention is actionable backpressure, while every other pre-launch failure
 * is simply undetermined. The retryability predicate lives beside the
 * governed runner, so this router does not duplicate its PG-code contract.
 */
export function classifyGovernedAdmissionFailure(error) {
  return isRetryableAdmissionFailure(error) ? 'admission-starved' : 'undetermined';
}
import {
  TEST_FILE_EXIT_FAILED,
  TEST_FILE_EXIT_FINALIZATION_ERROR,
  TEST_FILE_EXIT_NOT_MEASURED,
  TEST_FILE_EXIT_PASSED,
  TEST_FILE_EXIT_TEMPFAIL,
} from './lib/test-file-exit-codes.mjs';
import { peekFsMutexSync } from './lib/fs-mutex.mjs';
import { formatMutationProbeWindow, readMutationProbeWindow } from './lib/mutation-probe-window.mjs';
import {
  formatRestrictedHoldRefusal,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER,
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  runRestrictedHoldPreflight,
} from './lib/restricted-hold-preflight.mjs';
import { repoLockName } from './npm-install-safe.mjs';
import { ensurePapercuspTmpdir } from '../libs/test-config/src/tmpdir-guard.ts';

// EI-20767792192323374 — MUST happen HERE, in the launcher, and not in vitest.config.ts.
// Vitest fixes its module-cache root as a class field initializer (`_tmpDir = join(tmpdir(),
// nanoid())`) when `new Vitest()` is constructed, which `createVitest()` does BEFORE it loads any
// vitest config — so the identical call inside @papercusp/test-config's vitest-config.ts is always
// too late for it. Left unset, that root lands at bare `/tmp/<nanoid>`: un-namespaced,
// un-attributable, and in the blast radius of anything sweeping `/tmp/*`. On 2026-08-18 something
// swept it mid-run and 5,448 rows across 4,789 files failed with `ENOENT ... mkdir
// '/tmp/<nanoid>/ssr'`, red-pinning the release gate on an infra artifact.
// Every vitest spawn below passes `env: process.env`, so this propagates to every worker — and it
// covers workspaces whose config does NOT import @papercusp/test-config (the libs/generic
// submodules, which generic-first forbids from depending on it).
ensurePapercuspTmpdir();

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Publish pc-heavy's after-ready marker immediately before the first test process starts.
 *
 * Route discovery and `vitest list` stay preemptible so an exclusive dependency
 * materializer keeps priority while this command is still reversible. Once the
 * exact test set is known, however, repeatedly killing and replaying the same
 * focused run can starve it forever when materializers queue back-to-back. The
 * marker gives that already-derived run pc-heavy's bounded protected window; the
 * wrapper remains the last-resort cleanup owner if this process is killed.
 *
 * @param {string|null|undefined} file
 * @returns {(() => void)|null} cleanup callback when a marker was published
 */
function publishPreemptMarker(file, label) {
  const marker = file?.trim();
  if (!marker) return null;

  // A marker collision says NOTHING about the caller's test set, but it used to
  // abort the whole run as TEST_FILE_ROUTE_ERROR — which reads as "your paths
  // were wrong" and, by this repo's triage rules, means zero files were
  // measured. Observed on a shared box with markers left behind by killed runs:
  // 4 of 5 present markers were dead or unattributable debris
  // (EI-21882371330313535). The asymmetric rule that resolves this lives in
  // lib/preempt-markers.mjs; a LIVE owner still wins and its EEXIST propagates.
  if (createPreemptMarkerExclusive(marker) === 'reclaimed') {
    console.error(`${label} reclaimed-stale-marker pid=${process.pid}`);
  }
  console.error(`${label} pid=${process.pid}`);

  // Our own marker is published and safe; only now sweep the neighbours. Doing
  // it AFTER publication means a sweep that somehow misbehaves cannot cost this
  // run its barrier, and the whole call is swallowed for the same reason.
  try {
    const reaped = reapPreemptMarkerDebris(dirname(marker), { self: marker });
    if (reaped.length > 0) {
      console.error(`${label} reaped-abandoned-markers count=${reaped.length}`);
    }
  } catch {
    // Hygiene is never worth failing a run over.
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      unlinkSync(marker);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

export function publishPreemptReadyMarker(file = process.env.PC_HEAVY_PREEMPT_READY_FILE) {
  return publishPreemptMarker(file, 'PC_HEAVY_PREEMPT_READY');
}

/**
 * Publish the short PSI-finalization handoff after every requested file has
 * reported completion. pc-heavy owns the unique path and removes it if the
 * child is interrupted before this callback can run.
 *
 * @param {string|null|undefined} file
 * @returns {(() => void)|null} cleanup callback when a marker was published
 */
export function publishPreemptFinalizationMarker(
  file = process.env.PC_HEAVY_PSI_FINALIZATION_FILE,
) {
  return publishPreemptMarker(file, 'PC_HEAVY_PSI_FINALIZATION');
}

// WI-5621 (2026-07-20): this is THE most frequently invoked test runner in the
// repo (CLAUDE.md tells every agent to reach for `npm run test:file` after any
// edit), yet — unlike scripts/affected-tests.mjs (capped since WI-3792) — it
// ran every invocation at Vitest's uncapped, cores-sized default fork pool. On
// a ~90-agent fleet where dozens of agents run `test:file` concurrently, that
// is the dominant source of the fleet-wide CPU oversubscription observed in
// WI-5621 (loadavg 60-100+ on a 128-core box, causing unrelated tests to flake
// under scheduling contention). Apply the same shared, load-adaptive cap
// affected-tests.mjs uses — see scripts/lib/worker-cap.mjs for the rationale.
applyWorkerCapEnv({ cores: availableParallelism(), load1: loadavg()[0] });

const UNIT_CONFIG_RE = /^vitest\.config\.(?:[cm]?[jt]s)$/;
const INTEGRATION_CONFIG_RE = /^vitest\.integration\.config\.(?:[cm]?[jt]s)$/;
// EI-24442044145393058: a package that declares an e2e config owns its `*.e2e.test.*` files,
// so their recorded test layer is 'e2e'. Without one, the file stays on the unit route.
const E2E_CONFIG_RE = /^vitest\.e2e\.config\.(?:[cm]?[jt]s)$/;

// `release:trace` reports paths relative to the workspace that owns each test, while the
// root-level `test:file` command is normally invoked with repo-relative paths. Keep the
// package-relative compatibility lookup deliberately narrow: only concrete npm workspaces
// declared by the root manifest are candidates, and a path that exists in more than one
// workspace is refused instead of being routed arbitrarily.
const workspaceDirsCache = new Map();
const nestedRepositoryRootsCache = new Map();

function workspaceDirs(root) {
  const cached = workspaceDirsCache.get(root);
  if (cached) return cached;

  let patterns;
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    patterns = Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces
      : packageJson.workspaces?.packages;
  } catch {
    patterns = [];
  }
  if (!Array.isArray(patterns)) patterns = [];

  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (pattern.endsWith('/*')) {
      const parent = resolve(root, pattern.slice(0, -2));
      let entries;
      try {
        entries = readdirSync(parent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') || !existsSync(resolve(parent, entry, 'package.json'))) continue;
        dirs.push(resolve(parent, entry));
      }
    } else if (existsSync(resolve(root, pattern, 'package.json'))) {
      dirs.push(resolve(root, pattern));
    }
  }

  const result = [...new Set(dirs)];
  workspaceDirsCache.set(root, result);
  return result;
}

function hasWorkspaceManifest(dir) {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    const workspaces = packageJson.workspaces;
    return Array.isArray(workspaces) || Array.isArray(workspaces?.packages);
  } catch {
    return false;
  }
}

/**
 * Find checked-out nested repository roots that are also package workspaces.
 *
 * Gate/release evidence reports paths relative to the repository that owns a test. The
 * superproject's package.json declares the nested packages (for example
 * `libs/papercusp/packages/orchestrator`) as workspaces, but the evidence path is relative
 * to the nested repository (`packages/orchestrator/...`). Only consider an ancestor that
 * proves both properties — a .git marker and its own workspaces manifest — so ordinary
 * package directories never become a broad path-escape fallback.
 */
function nestedRepositoryRoots(root) {
  const cached = nestedRepositoryRootsCache.get(root);
  if (cached) return cached;

  const roots = new Set();
  for (const workspace of workspaceDirs(root)) {
    let candidate = workspace;
    while (candidate !== root && isWithinRoot(candidate, root)) {
      if (existsSync(join(candidate, '.git')) && hasWorkspaceManifest(candidate)) roots.add(candidate);
      candidate = dirname(candidate);
    }
  }

  const result = [...roots].sort();
  nestedRepositoryRootsCache.set(root, result);
  return result;
}

function isWithinRoot(candidate, root) {
  const rootRelative = relative(root, candidate);
  return rootRelative !== '..' && !rootRelative.startsWith(`..${sep}`) && !isAbsolute(rootRelative);
}

function resolveRequestedTestFile(file, root) {
  const direct = resolve(root, file);
  if (existsSync(direct) || isAbsolute(file) || file.split(/[\\/]/).includes('..')) return direct;

  const candidateRoots = [...new Set([...workspaceDirs(root), ...nestedRepositoryRoots(root)])];
  const candidates = candidateRoots
    .map((dir) => resolve(dir, file))
    .filter((candidate) => isWithinRoot(candidate, root) && existsSync(candidate))
    .sort();
  if (candidates.length > 1) {
    const listed = candidates.map((candidate) => relative(root, candidate)).join(', ');
    throw new Error(`requested test file is ambiguous across workspaces: ${file} (${listed})`);
  }
  return candidates[0] ?? direct;
}

function configsIn(dir) {
  try {
    return readdirSync(dir).filter(
      (name) => UNIT_CONFIG_RE.test(name) || INTEGRATION_CONFIG_RE.test(name) || E2E_CONFIG_RE.test(name),
    );
  } catch {
    return [];
  }
}

/**
 * A directory is a config-less Vitest workspace when it holds a `package.json` whose `test`
 * script runs `vitest` but ships no explicit `vitest.config.*`. This is the standard
 * `libs/generic/*` borrowable-lib shape (CLAUDE.md § "Borrowable libraries — generic-first"):
 * its documented `npm test` is a plain config-less `vitest run` from the package cwd, so the
 * router must be able to route those files there instead of falling off the end of the walk-up.
 */
function isVitestPackageDir(dir) {
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const test = pkg?.scripts?.test;
    return typeof test === 'string' && /\bvitest\b/.test(test);
  } catch {
    return false;
  }
}

// `templates/` is shipped content rather than an npm workspace, but its portable fixture
// suites are owned by @papercusp/template-kit's Vitest config. The affected-tests selector has
// the same cross-tree ownership, and test:file must honor it too; walking ancestors alone can
// never discover a config under libs/generic/template-kit for a path under templates/.
const NON_WORKSPACE_VITEST_ROUTES = [
  {
    prefix: 'templates/',
    pathPattern: /\/checks\/[^/]+\.fixture\.test\.[cm]?[jt]sx?$/,
    cwd: 'libs/generic/template-kit',
    config: 'vitest.config.ts',
  },
  // papercusp-app's composition check is the one non-fixture template suite owned by
  // template-kit. Routing it through the repository-root config discovers the same check in
  // the gitignored desktop sidecar mirror and executes both versions in one result.
  {
    prefix: 'templates/papercusp-app/',
    pathPattern: /\/checks\/composition-integrity\.test\.[cm]?[jt]sx?$/,
    cwd: 'libs/generic/template-kit',
    config: 'vitest.config.ts',
  },
];

// papercusp-desktop is intentionally not a root npm workspace: it is the Tauri/Cargo desktop
// package, and its JavaScript tests are owned by Node's built-in test runner rather than Vitest.
// Keep this route explicit, like the templates route above, so a path cannot be silently sent to
// an arbitrary package's runner just because it happens to end in `.test.js`.
const NON_WORKSPACE_NODE_ROUTES = [
  // Root maintenance scripts use Node's built-in runner directly. Without this
  // route the repository-root Vitest config imports them, their node:test cases
  // pass, and Vitest then reports the same file red as "No test suite found".
  {
    prefix: 'scripts/',
    pathPattern: /\.test\.mjs$/,
    cwd: '.',
  },
  {
    prefix: 'papercusp-desktop/test/',
    pathPattern: /\.test\.[cm]?js$/,
    cwd: 'papercusp-desktop',
  },
];

function nonWorkspaceVitestRoute(rootRelative, absolute, root) {
  const normalized = rootRelative.split(sep).join('/');
  const match = NON_WORKSPACE_VITEST_ROUTES.find(
    (candidate) => normalized.startsWith(candidate.prefix) && candidate.pathPattern.test(normalized),
  );
  if (!match) return null;
  const cwd = resolve(root, match.cwd);
  if (!existsSync(resolve(cwd, match.config))) return null;
  return { cwd, config: match.config, absolute, requested: relative(cwd, absolute) };
}

function nonWorkspaceNodeRoute(rootRelative, absolute, root) {
  const normalized = rootRelative.split(sep).join('/');
  const match = NON_WORKSPACE_NODE_ROUTES.find(
    (candidate) => normalized.startsWith(candidate.prefix) && candidate.pathPattern.test(normalized),
  );
  if (!match) return null;
  const cwd = resolve(root, match.cwd);
  if (!existsSync(resolve(cwd, 'package.json'))) return null;
  return { runner: 'node', cwd, config: null, absolute, requested: relative(cwd, absolute) };
}

export function discoverVitestRoute(file, root = REPO_ROOT) {
  root = resolve(root);
  const absolute = resolveRequestedTestFile(file, root);
  if (!existsSync(absolute)) throw new Error(`requested test file does not exist: ${relative(root, absolute)}`);
  const rootRelative = relative(root, absolute);
  if (rootRelative.startsWith(`..${sep}`) || rootRelative === '..' || isAbsolute(rootRelative)) {
    throw new Error(`requested test file is outside the repository: ${absolute}`);
  }

  // These specs belong to the packaged Tauri/WebdriverIO runner. Letting the
  // repository-root Vitest config collect one produces a false test failure
  // ("describe is not defined") before the desktop interaction is exercised.
  const normalized = rootRelative.split(sep).join('/');
  if (normalized.startsWith('tools/perf-test/wdio/specs/') && /\.spec\.[cm]?[jt]sx?$/.test(normalized)) {
    throw new Error(
      `packaged desktop WebdriverIO spec ${rootRelative} has no test:file route; ` +
        'run npm run test:wdio --prefix tools/perf-test/wdio against the packaged Tauri app',
    );
  }

  const nonWorkspaceRoute = nonWorkspaceVitestRoute(rootRelative, absolute, root);
  if (nonWorkspaceRoute) return nonWorkspaceRoute;

  const wantsIntegration = /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/.test(absolute);
  const wantsE2e = /\.e2e\.test\.[cm]?[jt]sx?$/.test(absolute);
  let dir = dirname(absolute);
  let unitFallback = null;
  let packageFallback = null;
  while (dir === root || dir.startsWith(`${root}${sep}`)) {
    const configs = configsIn(dir);
    const integration = configs.find((name) => INTEGRATION_CONFIG_RE.test(name));
    const unit = configs.find((name) => UNIT_CONFIG_RE.test(name));
    if (wantsIntegration && integration) return { cwd: dir, config: integration, absolute, requested: relative(dir, absolute) };
    const e2e = wantsE2e && !packageFallback ? configs.find((name) => E2E_CONFIG_RE.test(name)) : undefined;
    if (e2e) return { cwd: dir, config: e2e, absolute, requested: relative(dir, absolute) };
    // Keep walking after an already-discovered config-less package so an ancestor's
    // fallback unit config cannot preempt that nearer package route.
    if (!wantsIntegration && unit && !packageFallback) {
      return { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    }
    if (unit && !unitFallback) unitFallback = { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    // Nearest config-less Vitest package (`libs/generic/*` shape): its own `npm test` is a plain
    // config-less `vitest run`, so route there (config: null) when no config file owns the file.
    if (!packageFallback && configs.length === 0 && isVitestPackageDir(dir)) {
      packageFallback = { cwd: dir, config: null, absolute, requested: relative(dir, absolute) };
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  // A config-less package is the nearest owner even when an ancestor (usually the
  // repository root) has a fallback Vitest config.  The root config's include globs
  // are not authoritative for a package that deliberately runs plain `vitest run`
  // from its own cwd.
  if (packageFallback) return packageFallback;
  if (unitFallback) return unitFallback;
  throw new Error(
    `no Vitest config owns ${rootRelative}; add a vitest.config.* at the workspace root or run the suite's documented non-Vitest command`,
  );
}

/**
 * Discover the runner for a requested test file. Vitest remains the default route; the explicit
 * Node:test route covers the desktop package's supported JavaScript test files, which are outside
 * the root workspace/config walk by design.
 */
export function discoverTestRoute(file, root = REPO_ROOT) {
  root = resolve(root);
  const absolute = resolveRequestedTestFile(file, root);
  if (!existsSync(absolute)) throw new Error(`requested test file does not exist: ${relative(root, absolute)}`);
  const rootRelative = relative(root, absolute);
  if (rootRelative.startsWith(`..${sep}`) || rootRelative === '..' || isAbsolute(rootRelative)) {
    throw new Error(`requested test file is outside the repository: ${absolute}`);
  }
  return nonWorkspaceNodeRoute(rootRelative, absolute, root) ?? discoverVitestRoute(file, root);
}

// `test:file` accepts exact test files, not the production modules those tests import. Keep this
// check filename-based and runner-neutral so a source path is filtered before route discovery (a
// source file under a config-less tree may not have any test runner route at all).
const TEST_FILE_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFilePath(file) {
  return typeof file === 'string' && TEST_FILE_SUFFIX_RE.test(file.replaceAll('\\', '/'));
}

export function formatUnsupportedTestInputs(files) {
  const paths = files ?? [];
  if (paths.length === 0) return null;
  return [
    `TEST_FILE_UNSUPPORTED_INPUT requested=${paths.length} — test:file accepts test paths only; ` +
      'non-test source inputs are skipped and are not collection failures:',
    ...paths.map((file) => `  ⚠ NON_TEST  ${file} — skipped; pass its importing *.test.* or *.spec.* file instead`),
  ].join('\n');
}

export function groupRoutes(routes) {
  const groups = new Map();
  for (const route of routes) {
    const runner = route.runner ?? 'vitest';
    const key = `${runner}\0${route.cwd}\0${route.config}`;
    const group = groups.get(key) ?? { runner, cwd: route.cwd, config: route.config, routes: [] };
    group.routes.push(route);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * EI-18822211427354845: a caller that wants a machine-readable report passes ONE
 * `--outputFile=<path>` through the `--` passthrough (this is exactly what the
 * `testing:run` tool does), and every group below forwarded it verbatim to its OWN
 * `vitest run`. Each group therefore OVERWROTE the previous group's report, and only
 * the LAST group survived on disk — so a caller distilling that file reported ONE
 * group as if it were the whole run. A two-workspace request whose FIRST group was
 * red came back `failed:0, failures:[]`: the verdict bit survived (callers also AND
 * the exit code) but the diagnostics silently described the wrong group.
 *
 * This is the same defect EI-13535 fixed for the router's OWN verdict, one layer up:
 * `aggregateGroupResults` already sums across groups, so the report the router emits
 * must follow the same rule rather than being last-writer-wins.
 *
 * Group 0 KEEPS the caller's exact path; only groups 1..N-1 are suffixed
 * `<base>.<index><ext>`. That is deliberate and load-bearing for the rollout: this
 * script is spawned fresh from the working tree on every run, while its `testing:run`
 * consumer is server-side code that only goes live on the next deploy. Suffixing EVERY
 * group would mean the not-yet-updated consumer finds no file at the path it asked for
 * and hard-fails `no_report` on every multi-workspace run during that window. Leaving
 * group 0 in place keeps an old consumer working exactly as well as it did before (it
 * reads one group's report), while a NEW consumer merges every `*.json` in the private
 * temp dir it owns and gets the complete run. A single-group run is byte-identical to
 * the caller's request either way.
 */
export function perGroupVitestArgs(vitestArgs, groupIndex, groupCount) {
  if (groupCount <= 1 || groupIndex === 0) return vitestArgs;
  const perGroupPath = (p) => {
    const dot = p.lastIndexOf('.');
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf(sep));
    // Only treat a dot AFTER the last separator as an extension, so a dotted
    // DIRECTORY (…/my.dir/report) is never split in the middle.
    return dot > slash && dot > 0
      ? `${p.slice(0, dot)}.${groupIndex}${p.slice(dot)}`
      : `${p}.${groupIndex}.json`;
  };
  const out = [];
  for (let i = 0; i < vitestArgs.length; i += 1) {
    const arg = vitestArgs[i];
    if (arg.startsWith('--outputFile=')) {
      out.push(`--outputFile=${perGroupPath(arg.slice('--outputFile='.length))}`);
    } else if (arg === '--outputFile' && i + 1 < vitestArgs.length) {
      out.push(arg, perGroupPath(vitestArgs[i + 1]));
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

/**
 * Strip `--outputFile` for the EI-18099113673609528 detail-recovery re-runs below.
 * Those re-run INDIVIDUAL files purely to print human-readable detail to a live
 * stdio; letting them keep the report path would clobber the group's real report
 * with a single file's results — the same last-writer-wins bug as above, arriving
 * by a different door.
 */
export function withoutOutputFileArg(vitestArgs) {
  const out = [];
  for (let i = 0; i < vitestArgs.length; i += 1) {
    const arg = vitestArgs[i];
    if (arg.startsWith('--outputFile=')) continue;
    if (arg === '--outputFile') { i += 1; continue; }
    out.push(arg);
  }
  return out;
}

export function listedFiles(output, cwd, filesOnly = false) {
  if (filesOnly) {
    return [...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        // Keep unit-test stubs that still return Vitest's tree form working while the
        // production call uses --filesOnly. A format-only launcher change must not turn
        // those tests into false route reds.
        .map((line) => line.includes(' > ') ? line.split(' > ', 1)[0]?.trim() ?? '' : line)
        .filter((line) => line !== '' && !/\s/.test(line) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line))
        .map((file) => resolve(cwd, file)),
    )];
  }
  return [...new Set(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes(' > '))
      .map((line) => line.split(' > ', 1)[0]?.trim())
      .filter(Boolean)
      .map((file) => resolve(cwd, file)),
  )];
}

/**
 * Keep Vitest's listed files to the canonical files the caller explicitly requested.
 *
 * Vitest applies positional paths as filters, but an explicit path can still cause a config's
 * collection to report a matching copy from a sibling `.papercusp/worktrees/` checkout. Passing
 * that raw list to `vitest run` makes the router execute the sibling copy too, even though the
 * caller named only the canonical staging path. The requested route set is the authority: an
 * extra listed path is ignored, while a requested path that was not listed remains unmatched and
 * is refused by `evaluateMatch` below.
 *
 * @param {{ absolute: string }[]} routes
 * @param {string[]} matched files reported by `vitest list`
 * @returns {string[]} only listed files that are one of the requested canonical paths
 */
export function canonicalMatch(routes, matched) {
  const requested = new Set(routes.map((route) => route.absolute));
  return matched.filter((file) => requested.has(file));
}

/**
 * The false-green refusal decision, isolated from I/O so it is unit-testable (P-009 / WI-4534).
 *
 * A run is SAFE only when three things all hold: Vitest's own `list` exited cleanly, every
 * requested file resolved to a listed test, and at least one test was listed. Zero-match and
 * partial-match are the two ways a raw `vitest run <paths>` reports success while silently
 * skipping what you asked for — vitest exits 0 on a PARTIAL match (asked 3, ran 2), and exits 0
 * on a zero match under `--passWithNoTests`. Neither is catchable by a vitest flag alone; only
 * comparing REQUESTED against what `vitest list` actually resolved catches both. This is that
 * comparison, so the caller can turn a false-green into a hard error.
 *
 * @param {{ routes: {absolute: string, requested: string}[], matched: string[], listStatus: number }} args
 * @returns {{ ok: boolean, unmatched: {absolute: string, requested: string}[], requested: number, matched: number }}
 */
export function evaluateMatch({ routes, matched, listStatus }) {
  const matchedSet = new Set(matched);
  const unmatched = routes.filter((route) => !matchedSet.has(route.absolute));
  const ok = listStatus === 0 && unmatched.length === 0 && matched.length > 0;
  return { ok, unmatched, requested: routes.length, matched: matched.length };
}

/**
 * Treat a Vitest run as failed when either its process status or its own summary says so.
 *
 * EI-21124682504777505: Vitest 4.1.8 has emitted `Test Files N failed` / `Tests N failed`
 * while returning status 0. The exit code alone is therefore not a complete verdict; keep the
 * summary cross-check in this router as well as in affected-tests.mjs so `test:file` cannot
 * false-green the same red suite.
 *
 * @param {{ status: number|null, output: string }} args
 */
export function vitestRunFailed({ status, output }) {
  if (status !== 0) return true;
  const summary = parseSummaryFailedCounts(output);
  return Boolean(summary && (summary.testFiles > 0 || summary.tests > 0));
}

/**
 * Combine every GROUP's outcome (one per owning cwd/config — a multi-workspace request produces
 * >1) into a single honest final verdict, isolated from I/O so it is unit-testable (EI-13535).
 *
 * BUG THIS FIXES: the router used to `return` the moment ANY one group either mismatched
 * (`evaluateMatch` refused it) or its `vitest run` failed — silently abandoning every group that
 * hadn't been reached yet. A 3-file request spanning 2 workspaces (1 file in workspace A, 2 in
 * workspace B) whose workspace-A group ran first and failed reported `executed=1` and returned
 * WITHOUT EVER RUNNING (or even checking the match of) workspace B's 2 files — so an agent fixing
 * the one reported failure and re-running could get a clean `status=passed` while the other 2
 * files were NEVER EXECUTED AT ALL, exactly the false-green class this router exists to prevent
 * (CLAUDE.md's "hard-fails a zero or partial match before executing" promise did not cover this
 * cross-group case). The fix: `main` now runs EVERY group unconditionally (no early return inside
 * the loop) and this function aggregates their results afterward, so `executed` always reflects
 * every group that could run, a mismatch in one group never hides another group's files, and the
 * final status is decided from the true combined outcome.
 *
 * @param {{ requested: number, matched: number, executed: number, unmatchedCount: number, failed: boolean, launchError: boolean, timedOut?: boolean }[]} groupResults
 * @returns {{ ok: boolean, requested: number, matched: number, executed: number, anyUnmatched: boolean, anyFailed: boolean, launchError: boolean, anyTimedOut: boolean }}
 */
/**
 * EI-18099113673609528: Vitest 4's default (and verbose) reporter silently drops ALL per-suite
 * error detail — no "Failed Suites" section, no per-file `FAIL` line, no stack, no message —
 * when TWO OR MORE requested files fail to even COLLECT (a transform/parse/top-level-throw
 * error, not a normal assertion failure) in the same run. A single collection failure still
 * prints a full "Failed Suites" block with the underlying error; add a second simultaneous one
 * and the whole block vanishes, leaving only the bare summary lines:
 *
 *   Test Files  2 failed (2)
 *        Tests  no tests
 *
 * Reproduced directly against vitest 4.1.8 (two sibling files each with a deliberately
 * unterminated template literal, run together) — confirmed upstream reporter behavior, not a
 * flag/config issue in this repo (no custom reporter is configured; `--reporter=verbose` shows
 * the SAME empty output). Detects that exact silent-failure signature so the caller can recover
 * by re-running the files individually (where the same collection error DOES print in full).
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {boolean} true when the run failed with zero per-suite/per-test error detail
 */
export function looksLikeSilentCollectionFailure(output) {
  // EI-18819483316574031: strip ANSI FIRST. vitest colourises both the summary row and the
  // `❯ <file> (0 test)` tree rows, inserting SGR escapes between `Test Files` and its count
  // and around the `❯`/parens — so every matcher below silently missed on real (coloured)
  // output and this detector never fired outside tests, which all use clean text. Same root
  // cause, same day, as the green-checkpoint guard that let a red suite advance the pin.
  const plain = stripVitestAnsi(output ?? '');
  if (!/Test Files\s+\d+ failed/.test(plain)) return false;
  // A "Failed Suites"/"Failed Tests" block means Vitest DID print the underlying error for at
  // least one file — the single-collection-failure case, which is unaffected by this bug.
  if (/Failed Suites|Failed Tests/.test(plain)) return false;
  // Each file whose collection failed renders as "❯ <file> (0 test)" in the tree with nothing
  // beneath it (a normal per-test failure instead renders "(N test | M failed)" plus a `×` line
  // per failing test — real detail). Two or more zero-test files with no Failed-Suites block is
  // exactly the reproduced silent-failure signature (a single one always gets its own block).
  const zeroTestFiles = (plain.match(/❯\s*\S+\s*\(0 test\)/g) ?? []).length;
  return zeroTestFiles >= 2;
}

/**
 * EI-18662389554660036: a concurrent `npm install` on this shared tree rewrites
 * `node_modules` out from under every other agent's test run — `vitest`'s own
 * bin can vanish mid-install, or an overlapping second install can leave a
 * package half-written (e.g. `@vitest/mocker`'s `dist/` with only `.d.ts`
 * files, zero `.js`). Neither failure mode names its actual cause: the shell
 * reports a bare "command not found", and Node reports a bare
 * ERR_MODULE_NOT_FOUND stack into node_modules — both read exactly like a
 * real dependency/build problem. Detect the signature so the caller can print
 * an actionable hint (check for a concurrent installer) instead of leaving the
 * agent to chase a phantom bug.
 *
 * @param {string} output combined stdout+stderr of a `vitest list`/`vitest run` invocation
 * @returns {boolean} true when the output looks like node_modules was being rewritten concurrently
 */
export function looksLikeMidInstallCorruption(output) {
  // Require the shell diagnostic to END its line. This detector's own Vitest suite has a test
  // named `flags the shell "vitest: not found" signature`; when any OTHER assertion in that file
  // failed, searching the whole output matched the passing test title and fabricated a concurrent
  // install diagnosis. The real reproduced shell shape (`sh: 1: vitest: not found`) is a complete
  // diagnostic line, so anchoring preserves the signal while rejecting reporter/source echo.
  if (
    output.split(/\r?\n/).some((line) => /(?:^|:\s)vitest:\s*not found\s*$/i.test(line.trim()))
  )
    return true;
  // Require the three pieces on the SAME diagnostic line. Test reporters can echo arbitrary
  // source in an assertion diff; this detector's own implementation contains both tokens, so
  // searching the whole output independently made an ordinary source-string mismatch diagnose
  // itself as a concurrent install (EI-21417347162023894).
  if (
    output.split(/\r?\n/).some(
      (line) =>
        /(?:Error\s+)?\[ERR_MODULE_NOT_FOUND\]:/.test(line) &&
        /Cannot find (?:module|package)/.test(line) &&
        /node_modules[\\/]/.test(line),
    )
  )
    return true;
  return false;
}

const MID_INSTALL_HINT =
  'TEST_FILE_MID_INSTALL_SUSPECTED node_modules looks mid-install or corrupt (a peer agent may be running ' +
  '`npm install` on this shared tree right now — see EI-18662389554660036). Check `ps aux | grep "npm install"` ' +
  'and locks:list, then retry once it finishes. Prefer `npm run install:safe` for any future install on this tree ' +
  'so it serializes instead of racing concurrent test runs.';

/**
 * EI-19304880034803985 — the hint above only ever fires on the FAILURE
 * signature (`looksLikeMidInstallCorruption`), but the dominant real symptom
 * is a HANG: `npx vitest list`/`npx vitest run` blocks indefinitely while
 * node_modules is being rewritten out from under it, so this script never
 * reaches the code that would print a hint at all — the caller just burns its
 * outer timeout (120s/560s measured) and sees an unexplained stall.
 *
 * Widen the TRIGGER rather than write a new detector (the fix `install:safe`
 * already holds is `scripts/lib/fs-mutex.mjs`'s named mutex): peek it — a
 * non-blocking read, never an acquire — immediately BEFORE each vitest spawn
 * point, and print a phase-aware hint UP FRONT when it is held. A writer first
 * reserves the lock while draining admitted readers; that reservation alone
 * does not mean its install callback has started. This turns a silent hang
 * into a stated wait: the message is already flushed to stdout the moment the
 * (possibly-hanging) spawnSync call begins, so it survives even if the outer
 * caller kills this process on its own timeout.
 */
export function warnIfInstallInFlight(label) {
  let peek;
  try {
    peek = peekFsMutexSync(repoLockName());
  } catch {
    return; // diagnostic only — must never affect the real run
  }
  if (!peek.held) return;
  const owner = peek.owner ?? {};
  const pidInfo = owner.pid ? ` (pid ${owner.pid}${owner.host ? `@${owner.host}` : ''})` : '';
  if (owner.phase === 'draining-readers') {
    const reservedSince = owner.acquiredAt ? ` since ${owner.acquiredAt}` : '';
    console.error(
      `TEST_FILE_INSTALL_DRAINING_READERS install writer${pidInfo} reserved${reservedSince} — ` +
        `${label}: admitted readers can continue; the install callback has not started.`,
    );
    return;
  }
  if (owner.phase !== 'running') {
    const reservedSince = owner.acquiredAt ? ` since ${owner.acquiredAt}` : '';
    console.error(
      `TEST_FILE_INSTALL_MUTEX_HELD install writer${pidInfo} reserved${reservedSince} — ` +
        `${label}: writer phase is unknown; lock presence does not establish an active install.`,
    );
    return;
  }
  const runningSince = owner.runningAt ? ` since ${owner.runningAt}` : '';
  console.error(
    `TEST_FILE_MID_INSTALL_SUSPECTED an \`npm install\` is in flight${pidInfo}${runningSince} — ` +
      `${label} may HANG (not fail) until it completes — see EI-19304880034803985 / EI-18662389554660036. ` +
      'Check locks:list / `ps aux | grep "npm install"`, then retry once it finishes.',
  );
}

/**
 * EI-19462803905923939 — a transform/parse failure ANYWHERE in a workspace's import graph makes
 * `vitest list` collect zero test files and exit non-zero, so the zero-match guard below fires and
 * the terminal line reads `TEST_FILE_ROUTE_ERROR ... requested=1 matched=0`. That is a statement
 * about ROUTING and about the file the caller named — and both halves are wrong: the router worked
 * perfectly and the named file was fine.
 *
 * Measured 2026-08-03: a peer mid-edit on this shared tree left `libs/generic/search/src/hybrid.ts`
 * in a broken intermediate state (a `*​/` closed a JSDoc block and the next line continued with
 * `*`). `npm run lint:tool-prompts` reported `unmatched lib/__tests__/tools-md-sync.test.ts` and
 * refused; the real cause sat ~20 lines earlier, above the `| tail -N` cut that CLAUDE.md's own
 * idioms prescribe throughout. The wrong conclusions that misattribution invites are both
 * expensive: "the router is broken / my file moved" (go debug this script) or "my change broke the
 * import graph" (go revert or bisect your own correct work).
 *
 * This changes ONLY the attribution: the zero-match refusal keeps its semantics (non-zero exit, no
 * false green, `TEST_FILE_RESULT` still absent). Reproduced against the real vitest+esbuild for
 * BOTH shapes — a broken file the caller NAMED and a broken file only reachable through the import
 * graph — whose output is byte-identical apart from the path. That is precisely why the culprit is
 * compared against the requested set instead of being assumed external: telling a caller whose own
 * file has a syntax error that "your file is fine" would just swap one confident false statement
 * for another.
 *
 * ⚠ THE IMPLEMENTATION NOW LIVES IN `lib/vitest-summary.mjs` and is re-exported at the top of this
 * file (WI-37607). The docblock above is kept here because it records WHY the detector exists and
 * what the misattribution cost — context a reader of this runner still needs.
 */

/**
 * EI-19467022057492490 — the sibling gap `transformFailureMarker` above leaves open. That fix
 * covers exactly one culprit shape: an esbuild "Transform failed with N error" parse failure.
 * `vitest list` can ALSO fail-to-collect a whole group for a RUNTIME reason — a `vi.mock` factory
 * that throws at import time, a top-level side effect that crashes, a module self-installing
 * something the batch's other files don't expect — none of which esbuild ever sees, so
 * `parseTransformFailure` returns `[]` and the caller falls back to the bare, undifferentiated
 * `TEST_FILE_ROUTE_ERROR requested=N matched=0`. That line reads as "all N requested files are
 * broken", which INVERTS the real situation when only one of them is: a peer re-running the whole
 * named set at HEAD to triage a gate red (the documented recipe CLAUDE.md itself prescribes) sees
 * every file "still red", starts fixing files that were never broken, or disbelieves a correct
 * "it's green here" report from whoever already isolated the real culprit.
 *
 * Reproduced 2026-08-03 on green-checkpoint candidate 8564677998c4 (EI-19467022057492490): a
 * 3-file GATE_HELD_BY set batched into one `test:file` call reported `matched=0` for all three
 * (`Error: [vitest] No "configureSearchDefaults" export is defined on the "@papercusp/search"
 * mock` — a vi.mock factory crash in ONE file), while two of the three collect and pass cleanly
 * the moment they are listed alone.
 *
 * Fixes the misattribution the same way `transformFailureMarker` does: name exactly which
 * requested files are broken and which are healthy, instead of leaving the caller to (wrongly)
 * infer "all of them". Isolated from I/O — `perFile` is the caller's own per-file re-list outcomes
 * (main() below performs the actual re-listing, matching the untested-orchestration /
 * tested-decision split every other attribution helper in this file already uses) — so the
 * decision of what to print is unit testable without spawning a real `vitest list`.
 *
 * @param {{ requested: string, ok: boolean }[]} perFile per-file re-list outcome, one per requested route
 * @param {string} cwd the group's cwd (for the label only)
 * @param {number} groupRequested the group's original `requested` count (for the header)
 * @param {number} groupMatched the group's original `matched` count (for the header)
 * @returns {string | null} null when nothing was broken in isolation (a different, non-per-file cause —
 *   caller keeps today's undifferentiated output rather than a misleading "all healthy" claim)
 */
export function collectionAttributionMarker({ perFile, cwd, groupRequested, groupMatched }) {
  if (!perFile || perFile.length === 0) return null;
  const broken = perFile.filter((f) => !f.ok);
  const healthy = perFile.filter((f) => f.ok);
  // Nothing collects alone either — the whole-group matched=0 has no per-file attribution to add;
  // keep today's plain route-error rather than a marker that (falsely) claims to have narrowed it.
  if (broken.length === 0) return null;
  const cwdLabel = relative(REPO_ROOT, cwd) || '.';
  const lines = [
    `TEST_FILE_COLLECTION_ATTRIBUTION (group cwd=${cwdLabel}) requested=${groupRequested} matched=${groupMatched} — ` +
      `a collection crash in ${broken.length} of ${perFile.length} requested file(s) poisoned the whole batch's ` +
      "\`vitest list\` (not an esbuild parse error — parseTransformFailure found none), which is why matched=0 " +
      'above misreports EVERY requested file as unmatched. Re-listed each file alone to attribute it:',
  ];
  for (const f of broken) lines.push(`  ✗ BROKEN  ${f.requested} — fails to collect even alone`);
  for (const f of healthy) lines.push(`  ✓ ok      ${f.requested} — collects cleanly alone; NOT the cause`);
  if (healthy.length > 0) {
    lines.push(
      '  Treat only the BROKEN file(s) as suspect. The ok file(s) are not "still red" — re-verify them ' +
        'with their own `npm run test:file -- <that one file>` rather than trusting this batch\'s route error.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the honest terminal marker for a zero-match run whose real cause was a transform failure.
 *
 * Isolated from I/O so the ATTRIBUTION — the part that can be wrong in a costly way — is unit
 * testable. esbuild prints the culprit path relative to the vite root when it is inside it and
 * absolute when it is not, so both forms are resolved against the group cwd before comparison.
 *
 * @returns {string | null} null when no transform failure is present (caller keeps today's output)
 */
export function transformFailureMarker({ locations, routes, cwd, requested, matched }) {
  if (!locations || locations.length === 0) return null;
  const requestedAbs = new Set((routes ?? []).map((route) => route.absolute));
  const named = [];
  const external = [];
  for (const loc of locations) {
    const abs = isAbsolute(loc.file) ? loc.file : resolve(cwd, loc.file);
    (requestedAbs.has(abs) ? named : external).push({ ...loc, abs });
  }
  const fmt = (loc) => `${relative(REPO_ROOT, loc.abs) || loc.abs}:${loc.line}:${loc.col}`;
  const head =
    `TEST_FILE_TRANSFORM_ERROR requested=${requested} matched=${matched} cause=transform ` +
    `culprit=${[...named, ...external].map(fmt).join(',')}`;
  if (named.length > 0) {
    return (
      `${head}\n  A file you NAMED failed to PARSE (${named.map(fmt).join(', ')}) — vitest could ` +
      'not collect it, which is why matched=0 above. That is a real syntax error in your own ' +
      'file: NOT a routing problem, and NOT a peer mid-edit. Fix the parse error printed above.'
    );
  }
  return (
    `${head}\n  The file(s) you named are FINE — a module in their import graph failed to PARSE, ` +
    'so vitest collected zero test files and the zero-match guard fired. This is NOT a routing ' +
    'problem and NOT a fault in the file you named.\n  On this shared tree that is usually a PEER ' +
    'mid-edit (EI-19462803905923939): re-run in a minute before investigating, and check ' +
    '`git status` on the module named above.'
  );
}

/**
 * EI-19425177453558152 — `-t <pattern>` matching ZERO tests used to report `status=passed`.
 *
 * `executed` in this router counts FILES, not tests, so a run where vitest collected 625 tests
 * and executed none of them still reported `executed=1 status=passed` and exit 0. The router
 * already hard-fails a zero-or-partial FILE match before executing — and CLAUDE.md advertises
 * exactly that, which is precisely what teaches callers to trust its verdict. Closing the first
 * door and leaving the second open is worse than closing neither.
 *
 * Report the pattern AS VITEST RECEIVED IT. The reported invocation was `-t 'cd + EXIT-trap'`;
 * npm's arg chain ate the quotes, so vitest got `-t cd` plus two stray POSITIONALS (which vitest
 * reads as extra FILE filters, narrowing the run further). Echoing the received form makes the
 * quote-eating self-diagnosing instead of a mystery.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {{ flag: string, pattern: string, strays: string[] } | null}
 */
export function nameFilterFrom(vitestArgs) {
  const args = vitestArgs ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const joined = /^(-t|--testNamePattern)=([\s\S]*)$/.exec(arg);
    if (joined) {
      return { flag: joined[1], pattern: joined[2], strays: positionalsAfter(args, i + 1) };
    }
    if (arg === '-t' || arg === '--testNamePattern') {
      const next = args[i + 1];
      // A trailing flag with no value: vitest never received a pattern, so there is no
      // name-filter run to police. Never invent one.
      if (next === undefined) return null;
      return { flag: arg, pattern: next, strays: positionalsAfter(args, i + 2) };
    }
  }
  return null;
}

/**
 * WI-39830 — vitest's CAC parser reads a `-`-prefixed pattern as a NEW OPTION, never as the
 * value of a preceding `-t`, so the SPLIT form makes every test whose name starts with `-`
 * unaddressable by name. Measured here against `lib/harness-invoke-once.test.ts` (65 tests, 2
 * of them named `--model=<x> …`):
 *
 *   no filter                     -> exit 0, 65 matched   (positive control)
 *   -t '--model='                 -> exit 1,  0 matched   CACError: Unknown option `--model`
 *   --testNamePattern=--model=    -> exit 0,  2 matched   (both real tests)
 *
 * A pattern CAC *does* know fails differently but just as hard (`-t '--silent'` ->
 * "option `-t, --testNamePattern <pattern>` value is missing"), so neither shape degrades to a
 * quiet wrong answer — but neither runs the test either, and an opaque CACError reads as
 * "my pattern is wrong" rather than "the router mangled it".
 *
 * This repo's test names routinely START with `--` (lint-tsc.test.ts, mutation-probe-script.test.ts,
 * harness-invoke-once.test.ts, scripts-pg-url.test.ts …), so this is a live trap, not a corner
 * case. Rewriting HERE — the one seam the `testing:run` tool, `npm run test:file`, and the
 * per-file fallback re-run all funnel through — fixes every caller at once.
 *
 * Converts unconditionally rather than sniffing for a leading dash: the joined form is
 * unambiguous for EVERY value (CAC splits on the FIRST `=`, so a pattern that itself contains
 * `=` survives intact), and one rule with no branch cannot be wrong about which branch it is in.
 * A trailing `-t` with no value is left alone — there is no pattern to join, and vitest's own
 * error for it is the correct one.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {string[]} the same args, with any split `-t <pattern>` joined to `--testNamePattern=<pattern>`
 */
export function joinNameFilterArgs(vitestArgs) {
  const args = vitestArgs ?? [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '-t' || arg === '--testNamePattern') && i + 1 < args.length) {
      out.push(`--testNamePattern=${args[i + 1]}`);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Bare (non-flag) args left after the pattern — the fingerprint of shell/npm quote-eating. */
function positionalsAfter(args, from) {
  const strays = [];
  for (let i = from; i < args.length; i += 1) {
    if (args[i].startsWith('-')) break;
    strays.push(args[i]);
  }
  return strays;
}

/**
 * EI-19451028801041450 — the machine-reporter half of the guard above.
 *
 * `testsExecutedFrom` parses vitest's HUMAN summary row, so it is inert for any caller that
 * passes `--reporter=json`: there is no `Tests` row on stdout at all, the parse returns
 * "unreadable", and the check fails OPEN on every single call, forever. That is not a
 * hypothetical caller — `testing:run` (the surface CLAUDE.md's routing table tells every agent
 * to prefer over `npm run test:file`) ALWAYS passes `--reporter=json --outputFile=…`.
 *
 * THE GENERALIZABLE SHAPE, worth more than this fix: an output-sniffing guard silently scopes
 * itself to whichever output format its author happened to test with. It does not fail loudly
 * when a caller changes reporters — it just quietly stops being a guard, while still reporting
 * itself as working and still passing its own CLI-level verification.
 *
 * The router already KNOWS the report path (`--outputFile` is in vitestArgs and it already
 * rewrites it per group), so read the report and count EXACTLY instead of sniffing stdout.
 *
 * ⚠ The two readers MUST agree on what "executed" means, which is why they live adjacent:
 * executed = passed + failed. A skipped/pending/todo test was COLLECTED, not run — counting it
 * would defeat the whole guard, since a zero-match `-t` is precisely the case where vitest
 * collects every test and skips every one (measured: numTotalTests 19, numPendingTests 19,
 * numPassedTests 0).
 *
 * Returns `null` — never 0 — for anything unreadable (no path, missing file, malformed JSON, a
 * report without the count fields). `null` means UNVERIFIED and preserves the existing
 * three-state contract in aggregateGroupResults; fabricating a 0 here would invent reds.
 *
 * @param {string | null} reportPath value of `--outputFile`, if any
 * @param {string} [cwd] the group's cwd — vitest resolves a relative --outputFile against it
 * @returns {number | null} tests executed, or null if the report could not be read
 */
export function testsExecutedFromReport(reportPath, cwd) {
  if (!reportPath) return null;
  const resolved = isAbsolute(reportPath) ? reportPath : resolve(cwd ?? process.cwd(), reportPath);
  let report;
  try {
    report = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    return null; // diagnostic only — an unreadable report must never fail a real run
  }
  if (!report || typeof report !== 'object') return null;
  const { numPassedTests: passed, numFailedTests: failed } = report;
  if (typeof passed !== 'number' || typeof failed !== 'number') return null;
  return passed + failed;
}

/**
 * The `--outputFile` path in play for a group, or null.
 *
 * ⚠ Deliberately recognises ONLY the two bare forms `perGroupVitestArgs` rewrites
 * (`--outputFile=<p>` and `--outputFile <p>`) — NOT vitest's per-reporter
 * `--outputFile.json=<p>`. Widening this without also widening `perGroupVitestArgs` would be a
 * correctness bug, not extra coverage: a form that is not rewritten per group points every
 * group at ONE shared file, so each group would read whichever group wrote last and report
 * another group's count as its own. Keep the two functions recognising the same set.
 *
 * Last occurrence wins, matching how vitest itself treats a repeated flag.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {string | null}
 */
export function outputFilePathFrom(vitestArgs) {
  const args = vitestArgs ?? [];
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--outputFile=')) {
      found = arg.slice('--outputFile='.length);
    } else if (arg === '--outputFile' && i + 1 < args.length) {
      found = args[i + 1];
      i += 1;
    }
  }
  const trimmed = typeof found === 'string' ? found.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * EI-19380376466745152 — A SKIPPED ASSERTION IS AN ABSENT MEASUREMENT WEARING A PASS.
 *
 * The measured incident: an agent fixed a real regression, ran the owning file, read
 * `Tests  8 passed | 1 skipped (9)` plus `Test Files  1 passed (1)`, exit 0, and filed that as
 * proof. A peer had landed `it.skip` on THE EXACT ASSERTION being fixed six minutes earlier. The
 * eight passes were siblings that were already green before the fix existed; the fix was never
 * once exercised by the thing cited as evidence for it. It was caught only because a different
 * peer happened to un-skip the test later.
 *
 * Every signal in that run reads as success — file-level `1 passed`, exit 0, a skip count that is
 * one token in a line whose expected shape is a pass, and a clean `git status` because the skip
 * was already committed. This is the same class as the two traps already documented in this file
 * (`-p .` typechecking zero files and reading as clean; a group re-run whose green means "did not
 * ALL fail"): a verification whose SUBJECT was silently absent.
 *
 * The counting half is below; the naming half is `assertionOutcomesFromReport`. A COUNT alone
 * would not have prevented the incident — the agent already had the count. What they lacked was
 * the skipped test's NAME, which is the only thing that makes "one of these was skipped"
 * distinguishable from "the one I was fixing was skipped".
 *
 * Three-state like its executed-counting sibling: `null` is UNREADABLE, never a measured zero.
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {number | null} tests collected-but-not-run, or null when unreadable
 */
/** Report statuses that mean COLLECTED BUT NOT RUN. Vitest has used all three spellings. */
const NOT_EXECUTED_STATUSES = new Set(['skipped', 'pending', 'todo', 'disabled']);

/**
 * Per-assertion outcomes (names included) from vitest's JSON report.
 *
 * The human reporter prints COUNTS ONLY — verified empirically against vitest 4.1.8: a file with
 * one `it.skip` prints `✓ lib/voice-prefs.test.ts (5 tests | 1 skipped)` and
 * `Tests  4 passed | 1 skipped (5)`, and nowhere names the skipped test. So the report is the
 * only source for the half that actually matters, which is why `main` INJECTS a private json
 * reporter when the caller supplied none (see `withInjectedJsonReport`).
 *
 * `null` — never an empty result — for anything unreadable, preserving this file's three-state
 * convention: an absent report must degrade to "names unavailable", never to "nothing skipped".
 *
 * @param {string | null} reportPath value of `--outputFile`, if any
 * @param {string} [cwd] the group's cwd — vitest resolves a relative --outputFile against it
 * @returns {{ executed: string[], skipped: Array<{ name: string, file: string }> } | null}
 */
export function assertionOutcomesFromReport(reportPath, cwd) {
  if (!reportPath) return null;
  const resolved = isAbsolute(reportPath) ? reportPath : resolve(cwd ?? process.cwd(), reportPath);
  let report;
  try {
    report = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    return null; // diagnostic only — an unreadable report must never fail a real run
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return null;
  const executed = [];
  const skipped = [];
  for (const fileResult of report.testResults) {
    const file = typeof fileResult?.name === 'string' ? fileResult.name : '';
    for (const assertion of fileResult?.assertionResults ?? []) {
      const name =
        typeof assertion?.fullName === 'string' && assertion.fullName.trim() !== ''
          ? assertion.fullName
          : typeof assertion?.title === 'string'
            ? assertion.title
            : '';
      if (name === '') continue;
      if (NOT_EXECUTED_STATUSES.has(assertion?.status)) skipped.push({ name, file });
      else executed.push(name);
    }
  }
  return { executed, skipped };
}

const MAX_FAILED_ASSERTION_DIAGNOSTICS = 20;
const MAX_FAILED_ASSERTION_FIELD_CHARS = 500;
const MAX_FAILED_ASSERTION_MESSAGE_CHARS = 2_000;
const MAX_FAILED_ASSERTION_OUTPUT_CHARS = 12_000;

/**
 * Failed assertion details from a Vitest JSON report.
 *
 * This intentionally reads assertionResults only. A file-level `message` describes an import or
 * collection failure, not an ordinary assertion, and belongs to the collection-failure path
 * above. Keeping the two shapes separate prevents a collection error from being mislabelled as a
 * failed test when both are present in one report.
 *
 * Like assertionOutcomesFromReport, null means the report was unreadable and [] means it was
 * readable but contained no failed assertions. Callers must preserve that distinction.
 *
 * @param {string | null} reportPath value of --outputFile, if any
 * @param {string} [cwd] the group's cwd — vitest resolves a relative --outputFile against it
 * @returns {Array<{ file: string, name: string, messages: string[] }> | null}
 */
export function failedAssertionsFromReport(reportPath, cwd) {
  if (!reportPath) return null;
  const resolved = isAbsolute(reportPath) ? reportPath : resolve(cwd ?? process.cwd(), reportPath);
  let report;
  try {
    report = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return null;
  const failures = [];
  for (const fileResult of report.testResults) {
    const file = typeof fileResult?.name === 'string' ? fileResult.name : '';
    for (const assertion of Array.isArray(fileResult?.assertionResults) ? fileResult.assertionResults : []) {
      if (assertion?.status !== 'failed') continue;
      const name =
        typeof assertion?.fullName === 'string' && assertion.fullName.trim() !== ''
          ? assertion.fullName
          : typeof assertion?.title === 'string'
            ? assertion.title
            : '';
      const messages = Array.isArray(assertion?.failureMessages)
        ? assertion.failureMessages.filter((message) => typeof message === 'string' && message.trim() !== '')
        : [];
      failures.push({
        file,
        name,
        messages,
      });
    }
  }
  return failures;
}

function boundedDiagnosticText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Format failed assertion details for a live test:file caller.
 *
 * Every field, assertion count, and the complete output are bounded. JSON-encoding the fields
 * keeps each diagnostic on one line while preserving multiline assertion messages for a caller to
 * decode or copy. An empty string means there are no details to print; null input is deliberately
 * treated the same way at this formatting boundary because report readability is handled by the
 * parser's null-vs-empty result.
 *
 * @param {Array<{ file: string, name: string, messages: string[] }> | null} failures
 * @returns {string}
 */
export function formatFailedAssertionDiagnostics(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  const lines = [];
  let chars = 0;
  for (const failure of failures.slice(0, MAX_FAILED_ASSERTION_DIAGNOSTICS)) {
    const file = boundedDiagnosticText(failure?.file, MAX_FAILED_ASSERTION_FIELD_CHARS) || '(unknown file)';
    const name = boundedDiagnosticText(failure?.name, MAX_FAILED_ASSERTION_FIELD_CHARS) || '(unnamed assertion)';
    const message = boundedDiagnosticText(
      Array.isArray(failure?.messages)
        ? failure.messages.filter((entry) => typeof entry === 'string').join('\n')
        : '',
      MAX_FAILED_ASSERTION_MESSAGE_CHARS,
    ) || '(failure message unavailable)';
    const line =
      `TEST_FILE_ASSERTION_FAILURE file=${JSON.stringify(file)} name=${JSON.stringify(name)} ` +
      `message=${JSON.stringify(message)}`;
    const nextChars = chars + (lines.length > 0 ? 1 : 0) + line.length;
    if (nextChars > MAX_FAILED_ASSERTION_OUTPUT_CHARS) break;
    lines.push(line);
    chars = nextChars;
  }
  const omitted = failures.length - lines.length;
  if (omitted > 0) {
    const truncation = `TEST_FILE_ASSERTION_FAILURES_TRUNCATED omitted=${omitted} ` +
      `limit=${MAX_FAILED_ASSERTION_OUTPUT_CHARS}chars`;
    const nextChars = chars + (lines.length > 0 ? 1 : 0) + truncation.length;
    if (nextChars <= MAX_FAILED_ASSERTION_OUTPUT_CHARS) lines.push(truncation);
  }
  return lines.join('\n');
}

/**
 * Whether the caller already chose a reporter or a report path.
 *
 * Machine/custom reporters own stdout's format (`testing:run` passes `--reporter=json`), and a
 * caller-supplied `--outputFile` already supplies the report this runner reads. The injection
 * helper can safely add a private report alongside explicitly selected human reporters.
 */
export function callerChoseReporting(vitestArgs) {
  const args = vitestArgs ?? [];
  return args.some(
    (arg) => arg === '--reporter' || arg.startsWith('--reporter=') || arg === '--outputFile' || arg.startsWith('--outputFile='),
  );
}

/**
 * Add a private json report ALONGSIDE the default human reporter.
 *
 * Verified against vitest 4.1.8 rather than assumed, because the whole feature rests on it:
 * `vitest run --reporter=default --reporter=json --outputFile=<p> <file>` keeps the human
 * `Tests  4 passed | 1 skipped (5)` row on stdout AND writes the machine report to `<p>`. Passing
 * `--reporter=json` alone would replace stdout with JSON and silently break every human caller.
 *
 * CLI reporters REPLACE the configured list, rather than extending it. Retain the first-party
 * evidence reporters as testing:run does; otherwise a green direct run silently loses its ledger
 * receipt (EI-22627645585922385). Respect the config's opt-out and source-map arming gates.
 * The workspace config still supplies the source-map importDurations settings. Missing reporter
 * files in a partial/foreign checkout must not turn this diagnostic injection into a load error.
 *
 * Preserve explicit human reporters; leave machine/custom reporters and caller-owned report
 * paths unchanged. Human formatting alone must not disable assertion receipts or the ledger.
 *
 * @param {string[]} vitestArgs
 * @param {string | null} reportPath
 * @param {{ repoRoot?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ args: string[], injectedReportPath: string | null }}
 */
export function withInjectedJsonReport(vitestArgs, reportPath, { repoRoot = REPO_ROOT, env = process.env } = {}) {
  const args = vitestArgs ?? [];
  if (!reportPath) return { args, injectedReportPath: null };
  const humanReporters = new Set(['default', 'verbose', 'dot']);
  const selectedReporters = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outputFile' || args[i].startsWith('--outputFile=')) {
      return { args, injectedReportPath: null };
    }
    if (args[i] === '--reporter') selectedReporters.push(args[++i]);
    else if (args[i].startsWith('--reporter=')) selectedReporters.push(args[i].slice('--reporter='.length));
  }
  if (selectedReporters.some((reporter) => !humanReporters.has(reporter))) {
    return { args, injectedReportPath: null };
  }
  const evidenceReporters = [];
  const adminReporter = join(repoRoot, 'libs/test-config/src/admin-test-runs-reporter.ts');
  if (env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER !== '1' && existsSync(adminReporter)) {
    evidenceReporters.push(`--reporter=${adminReporter}`);
  }
  const sourceMapReporter = join(repoRoot, 'libs/test-config/src/executed-source-map-reporter.ts');
  if (env.PC_EXECUTED_SOURCE_MAP_WORKSPACE?.trim() && existsSync(sourceMapReporter)) {
    evidenceReporters.push(`--reporter=${sourceMapReporter}`);
  }
  return {
    args: [...args, ...(selectedReporters.length ? [] : ['--reporter=default']), '--reporter=json', ...evidenceReporters, `--outputFile=${reportPath}`],
    injectedReportPath: reportPath,
  };
}

/**
 * Keep the injected JSON report private.
 *
 * Vitest's JSON reporter always logs `JSON report written to <path>` after flushing an output
 * file. The router-generated path points into a disposable directory that `main()` removes in
 * its finally block, so forwarding that notice advertises a path that cannot be inspected after
 * the command exits. Suppress only the notice for the path THIS router injected; caller-selected
 * reporters and output files remain untouched. The original output is still used below for
 * classification and summary parsing, and the report itself remains available until those reads
 * finish.
 *
 * @param {string} output captured child stdout/stderr
 * @param {string | null} injectedReportPath the private path supplied by withInjectedJsonReport
 * @returns {string} output with the disposable-path notice removed
 */
export function suppressInjectedJsonReportNotice(output, injectedReportPath) {
  if (!output || !injectedReportPath) return output;
  const escapedPath = injectedReportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const notice = new RegExp(
    `^[^\\r\\n]*JSON report written to ${escapedPath}[^\\r\\n]*(?:\\r?\\n|$)`,
    'gm',
  );
  return output.replace(notice, '');
}

/** `--require-ran=<substring>` — this router's own option, not vitest's. */
export function requireRanFrom(ownArgs) {
  const args = ownArgs ?? [];
  let found = null;
  for (const arg of args) {
    if (arg.startsWith('--require-ran=')) found = arg.slice('--require-ran='.length);
  }
  const trimmed = typeof found === 'string' ? found.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The postcondition that closes the class: DID THE ASSERTION I AM VERIFYING ACTUALLY EXECUTE?
 *
 * An agent verifying a specific fix knows the name of the assertion that proves it. Everything
 * else in a test run is a PROXY for that question (file passed, exit 0, count went up), and every
 * proxy reads as success in the incident above. This turns it into a checked postcondition.
 *
 * Four verdicts, deliberately distinct — collapsing any two of them recreates a false green:
 *   `ran`        — an executed assertion's full name contains the substring.
 *   `skipped`    — it exists but was COLLECTED AND NOT RUN. The incident, caught.
 *   `absent`     — no assertion by that name at all (a typo, a rename, or the wrong file).
 *   `unverified` — no readable report, so the question was not answered. NOT a pass.
 *
 * @param {string | null} pattern
 * @param {{ executed: string[], skipped: Array<{ name: string, file: string }> } | null} outcomes
 */
export function requireRanVerdict(pattern, outcomes) {
  if (!pattern) return { status: 'not-requested', matches: [] };
  if (!outcomes) return { status: 'unverified', matches: [] };
  const ran = outcomes.executed.filter((name) => name.includes(pattern));
  if (ran.length > 0) return { status: 'ran', matches: ran };
  const skipped = outcomes.skipped.filter((entry) => entry.name.includes(pattern));
  if (skipped.length > 0) return { status: 'skipped', matches: skipped.map((entry) => entry.name) };
  return { status: 'absent', matches: [] };
}

/**
 * EI-21974750710808305 — a run that COLLECTED tests and executed ZERO of them measured nothing,
 * so it is evidence in NEITHER direction and must never be reported as `status=passed`.
 *
 * Extracted as a pure verdict (the `requireRanVerdict` pattern above) precisely so the decision is
 * testable at all: buried inside `main()` it could only be exercised by running the whole router.
 *
 * THREE-STATE-SAFE, and that is the whole design. It fires only on POSITIVE evidence from a
 * READABLE report — names of collected-and-skipped tests, with no executed names beside them. When
 * no report was readable both lists are empty, so an unreadable run yields `no-collected-skips` and
 * keeps its existing behaviour rather than being turned into a fabricated refusal. Collapsing
 * "unreadable" into "nothing executed" is the exact mistake this file already learned twice
 * (EI-19380376466745152, and the `??`-not-`||` note at the testsExecuted push site).
 *
 * @returns {{ vacuous: boolean, reason: string }}
 */
export function allSkippedVerdict(summary) {
  const executedNames = summary?.executedNames ?? [];
  const skippedNames = summary?.skippedNames ?? [];
  // A genuine red anywhere in the request is a real measurement — report it as `failed`, never
  // soften it into a refusal.
  if (summary?.anyFailed) return { vacuous: false, reason: 'genuine-failure' };
  // An unmeasured skip count means the run's own accounting is incomplete; refusing on it would be
  // fabricating a verdict from a hole.
  if (summary?.skippedUnmeasuredGroups !== 0) return { vacuous: false, reason: 'skip-count-unmeasured' };
  if (skippedNames.length === 0) return { vacuous: false, reason: 'no-collected-skips' };
  if (executedNames.length > 0) return { vacuous: false, reason: 'tests-executed' };
  return { vacuous: true, reason: 'every-collected-test-was-skipped' };
}

export function aggregateGroupResults(groupResults) {
  const requested = groupResults.reduce((sum, g) => sum + g.requested, 0);
  const matched = groupResults.reduce((sum, g) => sum + g.matched, 0);
  const executed = groupResults.reduce((sum, g) => sum + g.executed, 0);
  const launchError = groupResults.some((g) => g.launchError);
  const anyFinalizationError = groupResults.some((g) => g.finalizationError);
  // A governed admission refusal is a typed NOT-MEASURED outcome, not a route
  // error. Keep the type only when every launch-error group carries it: a
  // mixture of an admission refusal and an ordinary launch failure cannot be
  // honestly attributed to admission, while different admission kinds collapse
  // to `undetermined` rather than choosing one group arbitrarily.
  const launchErrorGroups = groupResults.filter((g) => g.launchError);
  const governedAdmissionKinds = launchErrorGroups
    .map((g) => g.governedAdmissionFailureKind)
    .filter((kind) => kind === 'admission-starved' || kind === 'undetermined');
  const governedAdmissionFailureKind =
    launchErrorGroups.length > 0 && governedAdmissionKinds.length === launchErrorGroups.length
      ? [...new Set(governedAdmissionKinds)].length === 1
        ? governedAdmissionKinds[0]
        : 'undetermined'
      : undefined;
  const anyUnmatched = groupResults.some((g) => g.unmatchedCount > 0);
  const anyFailed = groupResults.some((g) => g.failed);
  // EI-21902345477441137: a group the watchdog reaped produced NO verdict — `failed` is
  // deliberately `false` for it (see the push site), so it never contaminates `anyFailed`. Track
  // it separately so the caller can report NOT-MEASURED instead of a false green or false red.
  const anyTimedOut = groupResults.some((g) => g.timedOut);
  // Tests-executed is measured ONLY under a name filter, so three states are distinct and must
  // stay so: `undefined` = not applicable (no filter), `null` = filter present but the count was
  // unreadable, a number = measured. Collapsing unreadable into zero would fabricate reds.
  const measured = groupResults.filter((g) => typeof g.testsExecuted === 'number');
  const testsExecuted = measured.length > 0 ? measured.reduce((sum, g) => sum + g.testsExecuted, 0) : null;
  const testsUnmeasuredGroups = groupResults.filter((g) => g.testsExecuted === null).length;
  // Only a clean, fully-matched, fully-launchable run is `ok` — a launch error or ANY group's
  // partial/zero match still refuses the false-green, exactly as the single-group path always did.
  const ok = !launchError && !anyUnmatched;
  // EI-19380376466745152: skipped tests are three-state for the same reason executed ones are —
  // an unreadable count must never aggregate into "nothing was skipped", which is the reassuring
  // reading and, in the incident this came from, the wrong one. A group that never ran (launch
  // error, zero match) contributes `undefined` and counts as UNMEASURED, not as a clean zero.
  const skipMeasured = groupResults.filter((g) => typeof g.testsSkipped === 'number');
  const testsSkipped =
    skipMeasured.length > 0 ? skipMeasured.reduce((sum, g) => sum + g.testsSkipped, 0) : null;
  const skippedUnmeasuredGroups = groupResults.filter((g) => typeof g.testsSkipped !== 'number').length;
  const skippedNames = groupResults.flatMap((g) => g.skippedNames ?? []);
  const executedNames = groupResults.flatMap((g) => g.executedNames ?? []);
  return {
    ok,
    requested,
    matched,
    executed,
    testsExecuted,
    testsUnmeasuredGroups,
    testsSkipped,
    skippedUnmeasuredGroups,
    skippedNames,
    executedNames,
    anyUnmatched,
    anyFailed,
    launchError,
    governedAdmissionFailureKind,
    anyFinalizationError,
    anyTimedOut,
  };
}

/**
 * EI-18681435059177620 — A TEST RESULT IS ONLY EVIDENCE WHEN IT NAMES THE FILE STATE IT DESCRIBED.
 *
 * This is a SHARED, concurrently-edited checkout by design (CLAUDE.md § branch discipline: no
 * branches, no worktrees, git-sync sweeps the whole tree on a schedule). A test result is therefore
 * a measurement of a MOVING TARGET, and nothing in the result used to record which target it
 * measured. The reported incident: three measurements of ONE file inside 25 minutes each described
 * a different state of it, and each was cited as though it described "the file" — producing a
 * fleet-critical false alarm ("DO NOT SHIP", hardened into a `facts:assert`) and then a false
 * all-clear ("the detach fixes it", already stale when posted). Every number was true. Only
 * mtime+git forensics by the original reporter caught either one.
 *
 * ⚠ THE DIRTY FLAG ALONE CANNOT CATCH THE MEASURED CASE, which is why these snapshots carry a
 * CONTENT FINGERPRINT and not just a clean/dirty bit. In the incident's second measurement the file
 * was dirty BEFORE the run and dirty AFTER it — what changed was its CONTENT (`runGatedDelivery`
 * was written 4 minutes after the run that "tested" it). A dirty→dirty transition is invisible to
 * `git status`, so a status-only stamp would have reported that run as correctly described and
 * reproduced the exact failure it was built to prevent.
 *
 * SCOPE, stated on the banner itself because overclaiming here is the same defect one level up:
 * this covers the paths the caller NAMED. An edit to any other module in their import graph
 * invalidates the result just as thoroughly and is NOT measured (finding that set would mean
 * resolving the graph — far past "two git calls" — and a stamp that silently implied whole-graph
 * coverage would be worse than none).
 *
 * Diagnostics MUST never affect the real run: every git call is guarded, and an unmeasurable state
 * is reported as `unknown`, NEVER as `clean`. Reporting an unmeasured path as clean would
 * manufacture exactly the false confidence this exists to remove.
 */
const PROVENANCE_UNKNOWN = 'unknown';

/**
 * Content fingerprint of one file — the drift primitive. `null` for missing/unreadable, which
 * `diffProvenanceSnapshots` treats as "cannot compare", never as "unchanged".
 */
export function fileFingerprint(absolute) {
  try {
    return createHash('sha1').update(readFileSync(absolute)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** Short HEAD sha, or null when git cannot answer (never a fabricated value). */
function gitHeadSha(root) {
  try {
    const res = run('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: root });
    if (!res || res.error || res.status !== 0) return null;
    const sha = (res.stdout ?? '').trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

/**
 * Resolve the repository that owns one requested path.
 *
 * The superproject stores a submodule as one gitlink, so asking its `git ls-files` about a file
 * inside that directory returns an empty answer even when the nested repository tracks the file.
 * Ask git from the path's directory instead; this works for the superproject, checked-out
 * submodules, and nested submodules without maintaining a second copy of `.gitmodules` parsing.
 */
function gitRepoRootForPath(absolute, fallbackRoot) {
  try {
    const res = run('git', ['-C', dirname(absolute), 'rev-parse', '--show-toplevel'], { cwd: fallbackRoot });
    if (!res || res.error || res.status !== 0) return fallbackRoot;
    const candidate = resolve((res.stdout ?? '').trim());
    return isWithinRoot(candidate, fallbackRoot) ? candidate : fallbackRoot;
  } catch {
    return fallbackRoot;
  }
}

/**
 * Read the nested repository's HEAD and the gitlink commit pinned by its immediate superproject.
 * The latter is essential evidence: a clean nested worktree at a different commit than the
 * superproject pin is not reproducible from this checkout and must not receive a clean verdict.
 */
function gitRepoDetails(absolute, root) {
  const repoRoot = gitRepoRootForPath(absolute, root);
  const repoPath = relative(root, repoRoot) || '.';
  const details = {
    repoRoot,
    repoPath,
    repoRelativePath: relative(repoRoot, absolute),
    repoHead: gitHeadSha(repoRoot),
    superprojectPin: null,
    pointerState: repoRoot === root ? 'not-applicable' : 'unknown',
  };
  if (repoRoot === root) return details;

  try {
    const parent = run('git', ['-C', repoRoot, 'rev-parse', '--show-superproject-working-tree'], { cwd: root });
    if (!parent || parent.error || parent.status !== 0) return details;
    const parentRoot = resolve((parent.stdout ?? '').trim());
    if (!parentRoot || parentRoot === repoRoot) return details;
    const parentRelativePath = relative(parentRoot, repoRoot);
    if (!parentRelativePath || parentRelativePath.startsWith('..')) return details;
    const staged = run('git', ['ls-files', '--stage', '--', parentRelativePath], { cwd: parentRoot });
    if (!staged || staged.error || staged.status !== 0) return details;
    const match = /^160000 ([0-9a-f]+)\s+\d+\t/.exec((staged.stdout ?? '').trim());
    if (!match) return details;
    details.superprojectPin = match[1];
    details.pointerState = details.repoHead === null
      ? 'unknown'
      : details.superprojectPin.startsWith(details.repoHead)
        ? 'matched'
        : 'mismatch';
  } catch {
    // Diagnostics must degrade to UNKNOWN rather than manufacture a clean pointer claim.
  }
  return details;
}

function groupPathsByRepo(absolutePaths, root, repositories = new Map()) {
  const groups = new Map();
  for (const absolute of absolutePaths) {
    const details = repositories.get(absolute) ?? gitRepoDetails(absolute, root);
    repositories.set(absolute, details);
    const group = groups.get(details.repoRoot) ?? { ...details, paths: [] };
    group.paths.push(absolute);
    groups.set(details.repoRoot, group);
  }
  return groups;
}

/**
 * Per-path working-tree state for exactly the paths asked about.
 *
 * `-z` (NUL-separated) deliberately over plain `--porcelain`: porcelain QUOTES and escapes paths
 * containing spaces/unicode, so a text parse silently mis-keys those paths and reports them clean.
 * Rename records emit a second NUL-terminated field (the source path) which carries no `XY ` status
 * prefix — those are skipped rather than parsed as a path, so a rename can never be read as a
 * status line for some other file.
 *
 * TRACKED-NESS IS DECIDED BY `ls-files`, NOT BY THE ABSENCE OF A STATUS RECORD, and that is the
 * whole reason this takes two calls. `git status` reports an IGNORED file by collapsing it to its
 * ignored DIRECTORY (measured here: a file under the gitignored `.papercusp/scratch/` is reported
 * as the record `!! .papercusp/scratch/`, even with `--ignored=matching -uall`), so no exact-path
 * match ever fires for it. Inferring `clean` from "git named nothing for this path" therefore made
 * the most confident possible statement — reproducible by anyone — about the least reproducible
 * possible state: a file that is not in git AT ALL. `ls-files` answers tracked-ness directly and
 * is immune to that collapse.
 */
function gitPathStates(absolutePaths, root, repositories = new Map()) {
  const states = new Map(
    absolutePaths.map((absolute) => {
      const details = repositories.get(absolute) ?? gitRepoDetails(absolute, root);
      repositories.set(absolute, details);
      return [absolute, { state: PROVENANCE_UNKNOWN, ...details }];
    }),
  );
  if (absolutePaths.length === 0) return states;

  for (const group of groupPathsByRepo(absolutePaths, root, repositories).values()) {
    const relativePaths = group.paths.map((absolute) => relative(group.repoRoot, absolute));
    let tracked;
    let status;
    try {
      tracked = run('git', ['ls-files', '-z', '--', ...relativePaths], { cwd: group.repoRoot });
      status = run('git', ['status', '--porcelain', '-z', '--', ...relativePaths], { cwd: group.repoRoot });
    } catch {
      continue;
    }
    // Either call failing leaves every path `unknown` — never `clean`.
    if (!tracked || tracked.error || tracked.status !== 0) continue;
    if (!status || status.error || status.status !== 0) continue;

    const trackedSet = new Set(
      (tracked.stdout ?? '')
        .split('\0')
        .filter(Boolean)
        .map((p) => resolve(group.repoRoot, p)),
    );
    // A path git does not track is not reproducible by a peer, whether it is merely untracked or
    // ignored outright — both read `untracked` on the banner.
    for (const absolute of group.paths) {
      const current = states.get(absolute);
      states.set(absolute, { ...current, state: trackedSet.has(absolute) ? 'clean' : 'untracked' });
    }

    for (const record of (status.stdout ?? '').split('\0')) {
      if (record.length < 4) continue;
      const code = record.slice(0, 2);
      const reported = record.slice(3);
      if (!/^[ MADRCU?!]{2}$/.test(code)) continue; // a rename's source field — not a status record
      const absolute = resolve(group.repoRoot, reported);
      if (!states.has(absolute)) continue;
      const current = states.get(absolute);
      states.set(absolute, { ...current, state: code === '??' || code === '!!' ? 'untracked' : 'dirty' });
    }
  }

  // A nested repository can be clean while checked out at a commit different from the
  // superproject's gitlink. Preserve the existing state vocabulary but make that mismatch loud.
  for (const [absolute, entry] of states) {
    if (entry.pointerState === 'mismatch' && entry.state === 'clean') {
      states.set(absolute, { ...entry, state: 'dirty' });
    } else if (entry.pointerState === 'unknown' && entry.state === 'clean') {
      states.set(absolute, { ...entry, state: PROVENANCE_UNKNOWN });
    }
  }
  return states;
}

/** Added/deleted line counts vs HEAD (staged + unstaged), for the paths git can diff. */
function gitLineDeltas(absolutePaths, root, repositories = new Map()) {
  const deltas = new Map();
  if (absolutePaths.length === 0) return deltas;

  for (const group of groupPathsByRepo(absolutePaths, root, repositories).values()) {
    const relativePaths = group.paths.map((absolute) => relative(group.repoRoot, absolute));
    let res;
    try {
      res = run('git', ['diff', '--numstat', 'HEAD', '--', ...relativePaths], { cwd: group.repoRoot });
    } catch {
      continue;
    }
    if (!res || res.error || res.status !== 0) continue;
    for (const line of (res.stdout ?? '').split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      const absolute = resolve(group.repoRoot, match[3]);
      deltas.set(absolute, {
        added: match[1] === '-' ? null : Number(match[1]),
        deleted: match[2] === '-' ? null : Number(match[2]),
      });
    }
  }
  return deltas;
}

/**
 * Snapshot the provenance of the NAMED paths. Deduped and order-stable so the pre-run and post-run
 * snapshots are directly comparable entry-for-entry.
 */
export function snapshotProvenance(absolutePaths, root = REPO_ROOT) {
  const unique = [...new Set(absolutePaths)];
  const repositories = new Map();
  const states = gitPathStates(unique, root, repositories);
  const deltas = gitLineDeltas(unique, root, repositories);
  return {
    head: gitHeadSha(root),
    // EI-19323399466378077 — the run-start ISO timestamp, captured at the moment THIS snapshot is
    // taken (the pre-run call is the run's actual start). Without this a reader comparing a
    // backgrounded log against the live tree has only filesystem mtime to go on, which git-sync's
    // scheduled sweep makes unsound (the mtime/commit-time reflects when the sweep ran, not when
    // the edit landed) — the exact ambiguity that cost a full re-run to disambiguate (WI-6951).
    startedAt: new Date().toISOString(),
    entries: unique.map((absolute) => ({
      absolute,
      path: relative(root, absolute) || absolute,
      ...(states.get(absolute) ?? { state: PROVENANCE_UNKNOWN }),
      fingerprint: fileFingerprint(absolute),
      ...(deltas.get(absolute) ?? { added: null, deleted: null }),
    })),
  };
}

/** `[DIRTY +30/-0]` / `[clean]` / `[UNTRACKED]` / `[state UNKNOWN]` — the per-path suffix. */
function repoEvidenceLabel(entry) {
  if (!entry.repoPath || entry.repoPath === '.') return '';
  return ` repo=${entry.repoPath} repoHead=${entry.repoHead ?? PROVENANCE_UNKNOWN} ` +
    `superprojectPin=${entry.superprojectPin ?? PROVENANCE_UNKNOWN} pointer=${entry.pointerState ?? 'unknown'}`;
}

function stateLabel(entry) {
  const repo = repoEvidenceLabel(entry);
  if (entry.state === 'clean') return `[clean${repo}]`;
  if (entry.state === 'untracked') return `[UNTRACKED — exists only on this box${repo}]`;
  if (entry.state === PROVENANCE_UNKNOWN) return `[state UNKNOWN — git could not be read${repo}]`;
  const counts =
    typeof entry.added === 'number' && typeof entry.deleted === 'number'
      ? ` +${entry.added}/-${entry.deleted}`
      : '';
  return `[DIRTY${counts}${repo}]`;
}

/**
 * One copy-pasteable "read the COMMITTED blob" probe per repository that owns an uncommitted path.
 *
 * One line per repo, not per path: the shape is what a reader has to learn, and the SUBMODULE shape
 * is the half that is invisible from where the agent is standing. From the superproject, both
 * `git status --porcelain <sub>/<file>` and `git show <sha>:<sub>/<file>` answer about the GITLINK,
 * so they report nothing for a file the nested repository is tracking dirty — the check that would
 * catch this false-stale is exactly the one that silently returns empty unless you enter the
 * submodule first. Emitting the `git -C <sub>` form removes that from the reader's memory.
 *
 * The candidate sha is deliberately a `<placeholder>`: this process does not know which sha the
 * gate is judging (that is `state:read { cell:'gate.greenCheckpoint.candidate' }`), and printing a
 * guessed one would re-create, inside the fix, the same confidently-wrong-object error.
 */
export function committedBlobProbes(entries) {
  const byRepo = new Map();
  for (const entry of entries) {
    const repo = entry.repoPath && entry.repoPath !== '.' ? entry.repoPath : null;
    if (byRepo.has(repo)) continue;
    byRepo.set(
      repo,
      repo === null
        ? `git show <candidate>:${entry.path}`
        : `git -C ${repo} show <candidate-pin-for-${repo}>:${entry.repoRelativePath ?? entry.path}` +
          '   # submodule: from the superproject, git status/show answer about the gitlink, not this file',
    );
  }
  return [...byRepo.values()];
}

/**
 * The banner, isolated from I/O so the part that can be WRONG IN A COSTLY WAY — what a pasted
 * result claims about itself — is unit testable (the tested-decision / untested-orchestration split
 * every other helper in this file follows).
 *
 * @param {{ head: string|null, entries: object[] }} snapshot
 * @param {string} phase `pre-run` or `post-run`
 */
export function formatProvenanceBanner(snapshot, phase) {
  const entries = snapshot.entries ?? [];
  const unreproducible = entries.filter((e) => e.state === 'dirty' || e.state === 'untracked');
  const unknown = entries.filter((e) => e.state === PROVENANCE_UNKNOWN);
  const head = snapshot.head ?? PROVENANCE_UNKNOWN;
  // EI-19323399466378077 — APPENDED, never inserted mid-line: a snapshot built by hand (this
  // file's own unit tests) carries no `startedAt`, so the suffix is empty and the summary line
  // stays byte-identical to what those tests already assert with `.toContain(...)`.
  const startedAtSuffix = snapshot.startedAt ? ` startedAt=${snapshot.startedAt}` : '';
  const lines = [
    `TEST_FILE_PROVENANCE head=${head} testedPaths=${entries.length} ` +
      `uncommitted=${unreproducible.length} unknown=${unknown.length} phase=${phase}${startedAtSuffix}`,
    `  HEAD         : ${head}`,
  ];
  entries.forEach((entry, index) => {
    lines.push(`  ${index === 0 ? 'tested files :' : '              '} ${entry.path}  ${stateLabel(entry)}`);
  });
  lines.push(
    '  scope        : the NAMED paths above only — an edit to any OTHER module in their import ' +
      'graph invalidates this result just as thoroughly and is NOT measured here',
  );
  if (unreproducible.length > 0) {
    lines.push(
      `  ⚠ ${unreproducible.length} of ${entries.length} tested path(s) carry uncommitted changes — this result ` +
        'describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.',
    );
    // EI-19385411226259421 — the caveat above is about CITATION; this one is about the INFERENCE
    // that actually costs a gate pass. Every containment trap CLAUDE.md documents runs in the
    // direction "your change is missing from the candidate"; this is the mirror, and it is the
    // dangerous direction because it makes you STOP looking. Measured 2026-08-02: 7 files named by
    // a red verdict, all 7 passed at tip, 6 were genuinely stale and the 7th was green only on a
    // peer's uncommitted fix — reporting "all stale" would have told the fleet there was nothing
    // to fix while the gate was about to red on that same file again.
    lines.push(
      '  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — ' +
        'the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.',
      '     Falsify against the judged candidate BEFORE recording any of them as stale:',
      ...committedBlobProbes(unreproducible).map((probe) => `       ${probe}`),
    );
  }
  if (unknown.length > 0) {
    lines.push(
      `  ⚠ ${unknown.length} path(s) could not be measured — treat their state as UNKNOWN, not as clean.`,
    );
  }
  return lines.join('\n');
}

/**
 * Did the ground move under the run? Compares the pre-run and post-run snapshots.
 *
 * A `null` fingerprint on EITHER side is "cannot compare", never "unchanged" — a file that became
 * unreadable mid-run is precisely the case where a silent `unchanged` would be a lie.
 */
export function diffProvenanceSnapshots(before, after) {
  const afterByPath = new Map((after?.entries ?? []).map((e) => [e.absolute, e]));
  const changed = [];
  const uncomparable = [];
  for (const prior of before?.entries ?? []) {
    const now = afterByPath.get(prior.absolute);
    if (!now) continue;
    if (prior.fingerprint === null || now.fingerprint === null) {
      uncomparable.push({ path: prior.path, reason: now.fingerprint === null ? 'unreadable after the run' : 'unreadable before the run' });
      continue;
    }
    if (prior.fingerprint !== now.fingerprint) changed.push({ path: prior.path });
  }
  const headMoved =
    before?.head != null && after?.head != null && before.head !== after.head
      ? { from: before.head, to: after.head }
      : null;
  return { changed, uncomparable, headMoved, drifted: changed.length > 0 };
}

/**
 * The drift warning, or null when nothing moved.
 *
 * ⚠ DELIBERATELY DOES NOT CHANGE THE EXIT CODE, and that is a judgment call worth stating. A tested
 * file changing mid-run genuinely means the verdict describes neither the before nor the after
 * state — but this exit code is consumed by gates, and turning a correct green into a red on a
 * DIAGNOSTIC signal would make this a new false-RED generator. False reds are expensive here too:
 * on 2026-08-12 six consecutive gate reds were all stale tree churn and zero were standing defects.
 * So the drift rides on the RESULT line instead (`provenance=drifted`), which makes it impossible
 * to paste the verdict WITHOUT its caveat — the item's actual goal — while leaving the pass/fail
 * bit meaning exactly what it always meant. A HEAD-only move is likewise non-fatal, but its
 * provenance is UNKNOWN: this runner measures only the named test files, not their import graph.
 */
export function formatProvenanceDrift(diff) {
  if (!diff || (diff.changed.length === 0 && diff.uncomparable.length === 0 && !diff.headMoved)) return null;
  const lines = [];
  if (diff.changed.length > 0 || diff.uncomparable.length > 0) {
    lines.push(
      `TEST_FILE_PROVENANCE_DRIFT changed=${diff.changed.length} uncomparable=${diff.uncomparable.length} ` +
        `headMoved=${diff.headMoved ? `${diff.headMoved.from}->${diff.headMoved.to}` : 'no'}; ` +
        'a tested path CHANGED WHILE THIS RUN WAS EXECUTING — the result below describes NEITHER the ' +
        'state it started on nor the state on disk now. Re-run before citing it as evidence.',
    );
    for (const c of diff.changed) lines.push(`  ~ ${c.path} — content changed mid-run`);
    for (const u of diff.uncomparable) lines.push(`  ? ${u.path} — ${u.reason}; drift UNKNOWN`);
  } else {
    // HEAD moved but no NAMED test path changed. That is not direct evidence of drift, but neither
    // is it evidence that the measurement still stands: an imported production module may be the
    // content git-sync committed. Until this runner measures the import graph/change radius, the
    // only honest verdict is UNKNOWN and a settled-HEAD rerun.
    lines.push(
      `TEST_FILE_PROVENANCE_HEAD_MOVED from=${diff.headMoved.from} to=${diff.headMoved.to}; ` +
        'the named test paths did not change, but their imported source/change radius was not measured. ' +
        'Result provenance is UNKNOWN; re-run at settled HEAD before citing it as evidence.',
    );
  }
  return lines.join('\n');
}

/**
 * The fields appended to the terminal `TEST_FILE_RESULT` / `TEST_FILE_DRYRUN` line.
 *
 * This placement is the load-bearing half of the fix, for the reason already learned twice in this
 * file (EI-19462803905923939 / EI-19467022057492490): the terminal marker line is the LAST thing a
 * `| tail -N` reads — the idiom CLAUDE.md prescribes throughout — and it is the one line agents
 * actually paste into a work-item or a coord message. A banner printed only at the top scrolls out
 * of exactly the excerpt that gets quoted as evidence.
 *
 * `provenance` is three-state on purpose, mirroring this file's other three-state guards: `stamped`
 * (measured, nothing moved), `drifted` (a tested path changed mid-run), `unknown` (git unreadable or
 * HEAD moved beyond the named-path measurement radius — NOT a clean bill).
 */
export function provenanceResultFields(snapshot, diff) {
  const entries = snapshot?.entries ?? [];
  const unknown = entries.filter((e) => e.state === PROVENANCE_UNKNOWN).length;
  const uncommitted = entries.filter((e) => e.state === 'dirty' || e.state === 'untracked').length;
  const verdict =
    diff?.drifted || (diff?.uncomparable?.length ?? 0) > 0
      ? 'drifted'
      : diff?.headMoved || snapshot?.head == null || unknown > 0
        ? PROVENANCE_UNKNOWN
        : 'stamped';
  // EI-19323399466378077 — the run-start ISO timestamp, when the snapshot carries one (the real
  // `main()` call site does, via `snapshotProvenance`; this function's own unit tests construct
  // snapshots by hand without it, so their exact `.toBe(...)` assertions stay unaffected).
  // APPENDED LAST so `head=`/`uncommittedPaths=`/`provenance=` keep their existing positions for
  // every consumer already tokenising this line.
  const startedAtSuffix = snapshot?.startedAt ? ` startedAt=${snapshot.startedAt}` : '';
  return (
    `head=${snapshot?.head ?? PROVENANCE_UNKNOWN} ` +
    `uncommittedPaths=${uncommitted}/${entries.length} provenance=${verdict}${startedAtSuffix}`
  );
}

export function parseCli(argv) {
  const separator = argv.indexOf('--');
  // Keep the explicit separator form, but also accept the way npm users naturally forward
  // options (`test:file -- file -t pattern`). Once the first option appears, the remainder is
  // Vitest's argv; `--dry` is this router's own option and may still appear before it.
  // This router's OWN options must not be mistaken for the first vitest arg, or everything after
  // them (including the file list) would be forwarded to vitest as argv. `--require-ran` takes the
  // `=` form only, deliberately: a space-separated value would be indistinguishable from a test
  // path in exactly this scan.
  const isOwnOption = (arg) => arg === '--dry' || arg.startsWith('--require-ran=');
  const firstVitestArg = separator < 0
    ? argv.findIndex((arg) => !isOwnOption(arg) && arg.startsWith('-'))
    : -1;
  const own = separator >= 0
    ? argv.slice(0, separator)
    : firstVitestArg >= 0
      ? argv.slice(0, firstVitestArg)
      : argv;
  const vitestArgs = separator >= 0
    ? argv.slice(separator + 1)
    : firstVitestArg >= 0
      ? argv.slice(firstVitestArg)
      : [];
  const dry = own.includes('--dry');
  const requireRan = requireRanFrom(own);
  const files = own.filter((arg) => !isOwnOption(arg));
  // WI-39830: normalize the name filter to the joined form ONCE, here, so every downstream
  // consumer of `vitestArgs` gets it — the main `vitest run` spawn, the per-file fallback
  // re-run, and `nameFilterFrom` (which already accepts both forms) alike.
  return { dry, requireRan, files, vitestArgs: joinNameFilterArgs(vitestArgs) };
}

/**
 * Identify Vitest options that print CLI metadata instead of executing tests.
 *
 * A file route can still resolve successfully when one of these is forwarded: Vitest prints its
 * help/version text, exits 0, and the router's file-count accounting would otherwise manufacture a
 * `TEST_FILE_RESULT ... status=passed` marker for a run that executed no assertions. Keep this
 * check on the router boundary so every caller (including the npm-forwarded and explicit `--`
 * forms) gets the same NOT-MEASURED contract.
 *
 * @param {string[]} vitestArgs args forwarded after the router's file list
 * @returns {string | null} the first non-verdict option, if any
 */
export function nonVerdictOptionFrom(vitestArgs) {
  const args = vitestArgs ?? [];
  return (
    args.find(
      (arg) =>
        arg === '-h' ||
        arg === '--help' ||
        arg.startsWith('--help=') ||
        arg === '-v' ||
        arg === '--version' ||
        arg.startsWith('--version='),
    ) ?? null
  );
}

function run(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

// The supported testing:run surface uses the same five-minute whole-run budget for a SHORT list.
// Keep the direct test:file CLI bounded too: unlike Vitest's per-test timeout, this parent timer
// can still fire when a fork worker is synchronously spinning and its own event loop cannot run
// timers.
//
// The DEFAULT SCALES WITH THE REQUESTED FILE COUNT. A flat five-minute budget was calibrated for
// a handful of files, but the green-checkpoint's `--related` narrowing hands this router ONE
// positional list of a few hundred files per workspace (235 for @papercusp/web on 2026-09-06)
// under a one-worker allocation. The flat budget reaped that run at 300s with two files completed
// on EVERY gate run from 2026-09-04 on — a `TEST_FILE_NOT_MEASURED` exit 2 that the gate then
// held `main` on, with no test-failure verdict behind it. The budget is a CEILING, not a duration:
// a wedged run is still caught by the caller's stall watchdog (the gate reaps on stalledForSec)
// and by pc-heavy, so a generous ceiling costs nothing on a healthy run.
//
// The FLOOR is ten minutes, not five: it is also the budget of the gate's single-file flake retry,
// and one legitimate file already exceeds five minutes under gate load —
// apps/operator/scripts/hooks/cc/__tests__/pc-heavy.test.ts (153 process-spawning tests) runs
// ~170–215s on a quiet box and took 325s in the 2026-09-06 gate retry (run 245728d3), where the
// 300s floor reaped it and turned a 3-test failure verdict into TEST_FILE_NOT_MEASURED. A single
// file that genuinely hangs is still reaped inside ten minutes.
export const DEFAULT_TEST_FILE_RUN_TIMEOUT_MS = 600_000;
export const TEST_FILE_RUN_TIMEOUT_PER_FILE_MS = 20_000;
export const MAX_TEST_FILE_RUN_TIMEOUT_MS = 120 * 60_000;
// `vitest list` is a reversible collection preflight, but it still imports the
// requested files and can wedge before emitting any file row. Keep a separate,
// shorter absolute ceiling: unlike `vitest run`, a list has no test execution
// progress that justifies extending its deadline.
export const DEFAULT_TEST_FILE_LIST_TIMEOUT_MS = 120_000;
export const MAX_TEST_FILE_LIST_TIMEOUT_MS = 10 * 60_000;

/** Default whole-run budget for a positional list of `fileCount` files: the flat five-minute
 * floor, widened by a per-file allowance, capped at the router maximum. A count that is not a
 * positive integer falls back to the single-file floor. */
export function defaultTestFileRunTimeoutMs(fileCount = 1) {
  const count = Number.isSafeInteger(fileCount) && fileCount > 0 ? fileCount : 1;
  return Math.min(
    MAX_TEST_FILE_RUN_TIMEOUT_MS,
    Math.max(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS, count * TEST_FILE_RUN_TIMEOUT_PER_FILE_MS),
  );
}

/** Resolve the whole-file watchdog from the CLI environment. Unlike an outer
 * task timeout, this is the deadline that owns and reaps the Vitest process
 * tree, so slow-but-progressing files need a supported way to widen it. An
 * explicit PAPERCUSP_TEST_FILE_TIMEOUT_MS always wins; otherwise the budget is
 * derived from `fileCount` (see defaultTestFileRunTimeoutMs). */
export function testFileRunTimeoutMs(env = process.env, fileCount = 1) {
  const raw = env.PAPERCUSP_TEST_FILE_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return defaultTestFileRunTimeoutMs(fileCount);
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('PAPERCUSP_TEST_FILE_TIMEOUT_MS must be a positive integer number of milliseconds');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TEST_FILE_RUN_TIMEOUT_MS) {
    throw new Error(
      `PAPERCUSP_TEST_FILE_TIMEOUT_MS must be between 1 and ${MAX_TEST_FILE_RUN_TIMEOUT_MS} milliseconds`,
    );
  }
  return parsed;
}

/** Resolve the absolute collection-preflight deadline. */
export function testFileListTimeoutMs(env = process.env) {
  const raw = env.PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_TEST_FILE_LIST_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS must be a positive integer number of milliseconds');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TEST_FILE_LIST_TIMEOUT_MS) {
    throw new Error(
      `PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS must be between 1 and ${MAX_TEST_FILE_LIST_TIMEOUT_MS} milliseconds`,
    );
  }
  return parsed;
}

export const TEST_FILE_RUN_TIMEOUT_MS = testFileRunTimeoutMs();
export const TEST_FILE_PROGRESS_INTERVAL_MS = 10_000;
export const TEST_FILE_WATCHDOG_STALL_WINDOW_MS = 5 * 60_000;
export const TEST_FILE_WATCHDOG_EXTENSION_MS = 5 * 60_000;
const TEST_FILE_KILL_GRACE_MS = 2_000;
const TEST_FILE_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const SYSTEMD_RUN_PATH = process.platform === 'linux'
  ? ['/usr/bin/systemd-run', '/bin/systemd-run'].find((candidate) => existsSync(candidate)) ?? null
  : null;
const SETSID_PATH = process.platform === 'linux'
  ? ['/usr/bin/setsid', '/bin/setsid'].find((candidate) => existsSync(candidate)) ?? null
  : null;
/**
 * Slack added on top of the watchdog ceiling when deriving a test scope's `RuntimeMaxSec`. The
 * router's own watchdog is the real timeout; this bound only exists for the case where the router
 * itself is gone (SIGKILLed by a caller's deadline, OOM-killed), so it must never be the tighter
 * of the two — a pc-heavy freeze can stall the router's timers while systemd's clock keeps going.
 */
const TEST_FILE_SCOPE_RUNTIME_SLACK_MS = 30 * 60_000;
const TEST_FILE_SCOPE_STOP_TIMEOUT_SEC = 10;
let testScopeSequence = 0;

/**
 * A unique, recognisable unit name for one test child's scope. An anonymous `run-uNNN.scope`
 * cannot be stopped by the router (it never learns the name) nor attributed by a human reading
 * `systemctl --user list-units`; host-memory-reduction-2026-09-27 P-008 found nine of them still
 * holding leaked fixture loops 19 days after their routers had died.
 */
export function nextTestScopeUnit(pid = process.pid, nowMs = Date.now()) {
  testScopeSequence += 1;
  return `papercusp-test-${pid}-${nowMs.toString(36)}-${testScopeSequence}.scope`;
}

/** `RuntimeMaxSec` for a test scope: the watchdog ceiling plus its kill grace plus slack. */
export function testScopeRuntimeMaxSec(watchdogMaxMs, killGraceMs = TEST_FILE_KILL_GRACE_MS) {
  return Math.ceil((watchdogMaxMs + killGraceMs + TEST_FILE_SCOPE_RUNTIME_SLACK_MS) / 1000);
}

/**
 * Stop one test scope, killing EVERY process still in its cgroup — including fixtures a test
 * spawned `detached: true` into their own process group, which the process-group watchdog cannot
 * reach. Reports how many tasks were still resident when the stop was requested, so a leak is
 * visible in the run's output instead of in `ps` three weeks later. `--no-block` queues the stop
 * (SIGTERM, then SIGKILL after TimeoutStopSec) without making the router wait on it.
 */
export function stopTestScope(unit, env = process.env, spawnSyncImpl = spawnSync) {
  const options = { encoding: 'utf8', env, timeout: 5_000 };
  const shown = spawnSyncImpl('systemctl', ['--user', 'show', '--property=TasksCurrent', '--value', unit], options);
  const tasks = Number.parseInt(String(shown?.stdout ?? '').trim(), 10);
  const stopped = spawnSyncImpl('systemctl', ['--user', 'stop', '--no-block', unit], options);
  return { tasks: Number.isSafeInteger(tasks) ? tasks : null, stopStatus: stopped?.status ?? null };
}

/**
 * EI-21903376339103215: read the cumulative wall-clock ms pc-heavy has spent SIGSTOPping the
 * CURRENT admission, from the record file it persists at
 * `${PC_HEAVY_ADMISSION_DIR}/${PC_HEAVY_ADMISSION_ID}.state` (pc-heavy.sh's `_psi_write_record`).
 * A SIGSTOP freeze pauses this whole process tree without pausing wall clock, so a `Date.now()`
 * budget inside a frozen subject (this router's own watchdog timers, or a deeper vitest test's
 * own timeout logic) can report a confident timeout that the freeze — not a genuine defect —
 * produced. Returns `null` when pc-heavy admission is not in play (the two env vars are pc-heavy's
 * own export, present only when this process was launched under it) or the record is unreadable —
 * kept distinct from `0`, which means pc-heavy IS in use and genuinely reports no freeze (yet).
 * Callers diff two readings taken around one run to attribute freeze time to THAT run's own
 * wall-clock window, since one pc-heavy admission can cover several sequential groups.
 */
function readPcHeavyFrozenTotalMs(env = process.env) {
  const dir = env.PC_HEAVY_ADMISSION_DIR;
  const id = env.PC_HEAVY_ADMISSION_ID;
  if (!dir || !id) return null;
  let raw;
  try {
    raw = readFileSync(join(dir, `${id}.state`), 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq) !== 'frozen_total_ms') continue;
    const value = Number(line.slice(eq + 1).trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * Diff two `readPcHeavyFrozenTotalMs()` readings into "how much freeze time fell inside this
 * window" — `0` whenever either side is unreadable (pc-heavy not in play, or the record vanished),
 * never a negative number (a record reset between readings must not read as a negative freeze).
 */
function pcHeavyFreezeMsBetween(before, after) {
  return before === null || after === null ? 0 : Math.max(0, after - before);
}

function defaultKillOwnedProcess(child, signal, ownsProcessGroup) {
  if (ownsProcessGroup) return killSpawnedProcessTree(child, signal);
  try {
    child.kill(signal);
    return 'child';
  } catch {
    return 'gone';
  }
}

/**
 * Can `systemd-run --user` reach the caller's user manager from this child env? It connects over
 * the session bus, which systemd locates through XDG_RUNTIME_DIR (`$XDG_RUNTIME_DIR/bus`) or an
 * explicit DBUS_SESSION_BUS_ADDRESS. A private XDG runtime directory alone is not a bus:
 * isolated background tests deliberately create one without exposing the live user session.
 * With neither a bus socket nor an explicit address it exits 1 BEFORE the command runs —
 * indistinguishable from the test file failing, and with no output at all.
 */
export function userBusReachable(env = process.env) {
  if (env?.DBUS_SESSION_BUS_ADDRESS) return true;
  if (!env?.XDG_RUNTIME_DIR) return false;
  try {
    return statSync(join(env.XDG_RUNTIME_DIR, 'bus')).isSocket();
  } catch {
    return false;
  }
}

/**
 * Choose how one captured test child is launched, against the env that child will actually get.
 *
 * Measured 2026-09-06 (pc-heavy.test.ts, WI-42293 fixtures): a fixture that spawns this router
 * with a deliberately minimal env (PATH only) had every nested child exit 1 in ~200ms once the
 * systemd-run launcher landed, because `systemd-run --user` could not find a bus — the fixtures'
 * finalization marker was never published and the whole file went red on the gate. A stripped
 * env (a fixture, a cron job, a container without a user session) therefore falls back to the
 * `setsid --wait` process-group boundary instead of manufacturing a silent red.
 */
export function resolveTestChildLauncher({
  command,
  args,
  env,
  systemdRunPath,
  setsidPath,
  scopeUnit = null,
  runtimeMaxSec = testScopeRuntimeMaxSec(MAX_TEST_FILE_RUN_TIMEOUT_MS),
}) {
  const childEnv = env ?? process.env;
  // `testing:run` already places this router in a bounded managed task scope and
  // stamps both values below into the payload. Starting another user scope here
  // moves Vitest OUT of that owned cgroup: the outer deadline then kills only
  // the router while the nested `run-u*.scope` keeps its workers alive. The
  // collision-free run-group marker alone is not enough (a direct caller may set
  // it for reporter attribution), and an inherited task deadline alone is not
  // enough (an arbitrary parent task may still need this router's isolation).
  // Together they prove that the outer testing runner already owns bounded
  // lifetime. Keep the child in that cgroup and use setsid solely for the local
  // process-group watchdog.
  const outerTestingRunOwnsLifetime = Boolean(
    childEnv.PAPERCUSP_TEST_RUN_GROUP && childEnv.PAPERCUSP_TASK_DEADLINE_EPOCH_MS,
  );
  const systemd =
    !outerTestingRunOwnsLifetime && systemdRunPath && userBusReachable(childEnv)
      ? systemdRunPath
      : null;
  const ownsProcessGroup = Boolean(systemd || setsidPath);
  const spawnCommand = systemd ?? setsidPath ?? command;
  // A sibling scope escapes the caller's cgroup, so the caller's own deadline cannot reach it:
  // name it (so this router can stop it) and bound it (so systemd stops it if this router dies).
  const ownedScope = systemd ? scopeUnit ?? nextTestScopeUnit() : null;
  const spawnArgs = systemd
    ? [
      '--user',
      '--scope',
      '--collect',
      `--unit=${ownedScope}`,
      `--property=RuntimeMaxSec=${runtimeMaxSec}`,
      `--property=TimeoutStopSec=${TEST_FILE_SCOPE_STOP_TIMEOUT_SEC}`,
      command,
      ...args,
    ]
    : setsidPath
      ? ['--wait', command, ...args]
      : args;
  const launcher = systemd ? 'systemd-run' : setsidPath ? 'setsid' : 'direct';
  return { launcher, ownsProcessGroup, spawnCommand, spawnArgs, scopeUnit: ownedScope };
}

/** Share outcome retention across the asynchronous Vitest and synchronous Node:test routes. */
export async function runGovernedTestFileProcess(governedProcessImpl, options, runChild) {
  let childResult;
  let childCompleted = false;
  try {
    return await governedProcessImpl(options, (...args) => {
      return Promise.resolve(runChild(...args)).then((result) => {
        childResult = result;
        childCompleted = true;
        return result;
      });
    });
  } catch (cause) {
    const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause });
    // Admission, execution and receipt finalization share one promise. Once
    // the child returned, a later rejection cannot erase its measured outcome
    // or justify running the child again (WI-10004947).
    if (childCompleted) {
      error.code = 'GOVERNED_FINALIZATION_FAILED';
      return { ...childResult, governedFinalizationError: error };
    }
    const kind = classifyGovernedAdmissionFailure(cause);
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: Object.assign(error, { code: 'GOVERNED_ADMISSION_FAILED', governedAdmissionFailureKind: kind }),
      timedOut: false,
      actualDemand: options.demand,
      governedAdmissionError: true,
      governedAdmissionFailureKind: kind,
    };
  }
}

function printTestFinalizationError(result) {
  const error = result.governedFinalizationError;
  if (!error) return;
  console.error(
    `TEST_FILE_FINALIZATION_ERROR detail=${JSON.stringify(error.message)} ` +
      `origin=${JSON.stringify(error.cause?.stack ?? error.stack)} — child outcome retained; no automatic rerun`,
  );
}

/**
 * Run one captured test child without blocking this router's event loop.
 *
 * On Linux, prefer `systemd-run --user --scope --collect` so the short-lived child tree moves into
 * a sibling user scope instead of remaining in the caller's cgroup. The process-group watchdog
 * still targets the scope's owned group id, never a name/pattern. Hosts without systemd-run retain
 * the `setsid --wait` process-group boundary; other platforms fall back to signaling the owned
 * direct child only.
 *
 * `spawnImpl`/`killProcessImpl` are narrow test seams. Production callers omit them.
 */
export function runCapturedTestProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    files = [],
    cwdLabel = cwd ?? '.',
    timeoutMs = TEST_FILE_RUN_TIMEOUT_MS,
    progressIntervalMs = TEST_FILE_PROGRESS_INTERVAL_MS,
    watchdogStallWindowMs = TEST_FILE_WATCHDOG_STALL_WINDOW_MS,
    watchdogExtensionMs = TEST_FILE_WATCHDOG_EXTENSION_MS,
    // Preflight `vitest list` must have an absolute ceiling: it produces no
    // per-file completion rows, so output alone cannot prove that collection
    // is advancing. Ordinary `vitest run` keeps the larger gate-wide ceiling.
    watchdogMaxMs = MAX_TEST_FILE_RUN_TIMEOUT_MS,
    killGraceMs = TEST_FILE_KILL_GRACE_MS,
    maxBuffer = TEST_FILE_MAX_CAPTURE_BYTES,
    systemdRunPath = SYSTEMD_RUN_PATH,
    setsidPath = SETSID_PATH,
    spawnImpl = spawn,
    killProcessImpl = defaultKillOwnedProcess,
    stopScopeImpl = stopTestScope,
    onProgress = (line) => console.error(line),
    onAllFilesComplete = () => null,
    // Tests may replace this narrow governance seam; production callers leave
    // the canonical bridge in place.
    governedProcessImpl = runGovernedTestProcess,
  } = options;
  // The launcher is resolved per spawn, inside runChild, against the env the child actually
  // gets (the governed env when admission supplies one) — see resolveTestChildLauncher.
  const plannedDemand = buildGovernedProcessDemand({
    fileCount: files.length,
    diskBytes: maxBuffer,
    fileDescriptors: 16 + Math.max(1, files.length),
  });

  // WI-42293 / EI-21752720321040227: this function deliberately NEVER releases
  // the PSI-finalization marker. Releasing it here — as the `child.once('close')`
  // handler used to — ends the protected window while the run is still producing
  // its terminal evidence: the governed sampler stop, outcome classification and
  // admission release all happen AFTER close and take ~500ms-1s, and `main()`
  // does not print TEST_FILE_RESULT until later still. pc-heavy's PSI monitor
  // froze a run in exactly that gap and reported a child that had already exited
  // 0 as `undetermined` / exit 75 — the "never destroy a completed focused run"
  // case the marker exists to prevent.
  //
  // Release is owned by three parties that all outlive this call:
  //   1. `main()`'s `cleanupPreemptMarkers()`, in a finally AFTER TEST_FILE_RESULT;
  //   2. the next group's `onAllFilesComplete`, which supersedes the marker;
  //   3. pc-heavy itself, which removes it at every terminal/reap boundary and is
  //      the last-resort owner if this process is killed.
  // Holding it is fail-safe either way: pc-heavy bounds the deferral by
  // PC_HEAVY_PSI_FINALIZATION_MAX_SEC, so a stuck marker cannot pin a slot.
  const runChild = (admissionContext, governedEnv, { inherited = false } = {}) => new Promise((resolveRun) => {
    const startedAt = Date.now();
    // EI-21903376339103215: snapshot BEFORE spawning so the close handler below can diff against
    // it and attribute only THIS run's own freeze time, not freeze time from an earlier group
    // sharing the same pc-heavy admission.
    const freezeMsAtStart = readPcHeavyFrozenTotalMs();
    const sampler = createGovernedProcessDemandSampler(plannedDemand);
    const { ownsProcessGroup, spawnCommand, spawnArgs, scopeUnit } = resolveTestChildLauncher({
      command,
      args,
      env: governedEnv ?? env,
      systemdRunPath,
      setsidPath,
      runtimeMaxSec: testScopeRuntimeMaxSec(watchdogMaxMs, killGraceMs),
    });
    const child = spawnImpl(spawnCommand, spawnArgs, {
      cwd,
      env: governedEnv ?? env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sampler.attach(child.pid);
    const stdout = [];
    const stderr = [];
    const completedFiles = new Set();
    const progressRemainders = { stdout: '', stderr: '' };
    let capturedBytes = 0;
    let spawnError = null;
    let captureError = null;
    let timedOut = false;
    let settled = false;
    let terminationStarted = false;
    let forceTimer = null;
    let progressWatchdog = null;
    let allFilesCompleteObserved = false;
    const signalForwarders = new Map();

    const normalized = (file) => String(file).replaceAll('\\', '/');
    const requestedFiles = files.map(normalized);
    const emitProgress = (state, status = null, signal = null, isSettled = false) => {
      const pendingFiles = requestedFiles.filter((file) => !completedFiles.has(file));
      const outcome = formatTaskOutcomeFields({ status, signal, settled: isSettled });
      onProgress(
        `TEST_FILE_PROGRESS state=${state} cwd=${JSON.stringify(cwdLabel)} ` +
          `elapsedMs=${Date.now() - startedAt} capturedBytes=${capturedBytes} ` +
          `completedFiles=${JSON.stringify([...completedFiles])} ` +
          `pendingFiles=${JSON.stringify(pendingFiles)} timeoutMs=${timeoutMs} ` +
          `exitStatus=${outcome.exitStatus} signal=${outcome.signal}`,
      );
    };
    const killOwned = (signal) => {
      try {
        return killProcessImpl(child, signal, ownsProcessGroup);
      } catch {
        return 'gone';
      }
    };
    // Anything still in the scope once the Vitest main process is gone is a leak by definition — a
    // fixture spawned `detached: true` into its own process group, which `killOwned` cannot reach,
    // or a worker that ignored teardown. Stopping the scope kills its whole cgroup, and that is
    // also what lets `close` fire when such a straggler still holds the captured stdio pipes.
    let scopeStopped = false;
    const stopOwnedScope = (reason) => {
      if (!scopeUnit || scopeStopped) return;
      scopeStopped = true;
      let stop = null;
      try {
        stop = stopScopeImpl(scopeUnit, governedEnv ?? env ?? process.env);
      } catch {
        stop = null;
      }
      if (stop?.tasks > 0) {
        onProgress(
          `TEST_FILE_LEAKED_PROCESSES scope=${scopeUnit} tasks=${stop.tasks} reason=${reason} ` +
            `cwd=${JSON.stringify(cwdLabel)} files=${JSON.stringify(requestedFiles)}`,
        );
      }
    };
    const terminate = (state) => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      if (state === 'timeout') timedOut = true;
      emitProgress(state);
      killOwned('SIGTERM');
      forceTimer = setTimeout(() => {
        if (settled) return;
        emitProgress('reaping');
        killOwned('SIGKILL');
        stopOwnedScope(state);
      }, killGraceMs);
      forceTimer.unref?.();
    };
    const removeSignalForwarders = () => {
      for (const [signal, handler] of signalForwarders) process.removeListener(signal, handler);
      signalForwarders.clear();
    };
    // The Linux launcher deliberately makes the Vitest tree a nested process group so this
    // watchdog can target it without touching a caller's shell/agent group. Preserve
    // pc-heavy/testing:run's no-escape contract too: if THEY terminate this router, synchronously
    // reap the nested group before restoring the signal's default disposition on the router itself.
    // SIGKILL is used for this cleanup-only path because the parent is already terminating and
    // cannot stay alive for a grace timer; the normal watchdog path above still performs TERM ->
    // bounded grace -> KILL.
    if (ownsProcessGroup) {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const handler = () => {
          if (settled) return;
          emitProgress(`parent-${signal.toLowerCase()}`);
          killOwned('SIGKILL');
          stopOwnedScope(`parent-${signal.toLowerCase()}`);
          removeSignalForwarders();
          process.kill(process.pid, signal);
        };
        signalForwarders.set(signal, handler);
        process.once(signal, handler);
      }
    }
    const noteCompletedFiles = (channel, chunk) => {
      const combined = progressRemainders[channel] + chunk.toString('utf8');
      const lastNewline = combined.lastIndexOf('\n');
      if (lastNewline < 0) {
        progressRemainders[channel] = combined.slice(-16_384);
        return false;
      }
      const completeLines = combined.slice(0, lastNewline + 1);
      progressRemainders[channel] = combined.slice(lastNewline + 1);
      const before = completedFiles.size;
      const progress = parseBatchProgress(completeLines, { totalFiles: requestedFiles.length });
      for (const file of progress.completedFilePaths) completedFiles.add(normalized(file));
      return completedFiles.size > before;
    };
    const notifyAllFilesComplete = () => {
      if (
        allFilesCompleteObserved ||
        requestedFiles.length === 0 ||
        !requestedFiles.every((file) => completedFiles.has(file))
      ) {
        return;
      }
      allFilesCompleteObserved = true;
      try {
        // The returned cleanup is intentionally discarded here — see the note on
        // marker ownership above `runChild`. The caller keeps its own handle and
        // releases only once its terminal evidence is out.
        onAllFilesComplete();
      } catch (error) {
        captureError ??= error;
        terminate('finalization-marker');
      }
    };
    const capture = (channel, chunks) => (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      progressWatchdog?.noteProgress();
      capturedBytes += chunk.length;
      if (capturedBytes <= maxBuffer) {
        chunks.push(chunk);
      } else if (!captureError) {
        captureError = Object.assign(
          new Error(`test child exceeded the ${maxBuffer}-byte capture ceiling`),
          { code: 'ENOBUFS' },
        );
        terminate('output-limit');
      }
      if (noteCompletedFiles(channel, chunk)) {
        notifyAllFilesComplete();
        emitProgress('file-completed');
      }
    };

    progressWatchdog = createProgressAwareWatchdog({
      timeoutMs,
      maxMs: watchdogMaxMs,
      stallWindowMs: watchdogStallWindowMs,
      extensionMs: watchdogExtensionMs,
      onExtend: () => emitProgress('watchdog-extended'),
      onKill: () => terminate('timeout'),
    });
    child.stdout?.on('data', capture('stdout', stdout));
    child.stderr?.on('data', capture('stderr', stderr));
    child.once('error', (error) => { spawnError = error; });
    child.once('exit', () => stopOwnedScope('exit'));

    let progressTimer = null;
    const scheduleProgress = () => {
      progressTimer = setTimeout(() => {
        if (settled) return;
        emitProgress('running');
        scheduleProgress();
      }, progressIntervalMs);
      progressTimer.unref?.();
    };
    scheduleProgress();
    emitProgress('started');

    child.once('close', (status, signal) => {
      settled = true;
      removeSignalForwarders();
      if (progressTimer) clearTimeout(progressTimer);
      progressWatchdog?.stop();
      if (forceTimer) clearTimeout(forceTimer);
      // The finalization marker is deliberately NOT released here — nor anywhere
      // else in this function; see the marker-ownership note above `runChild`.
      // Releasing it at close ends the protected window while the run is still
      // producing its terminal evidence.
      emitProgress('finished', status, signal, true);
      resolveRun({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: spawnError ?? captureError,
        timedOut,
        actualDemand: sampler.stop({ diskBytes: capturedBytes }),
        admissionReceiptId: admissionContext?.receiptId ?? null,
        admissionInherited: inherited,
        // EI-21903376339103215: ms of pc-heavy SIGSTOP freeze that fell inside this run's own
        // wall-clock window (0 when pc-heavy is not in play or no freeze occurred). Callers use
        // this to qualify a timeout-shaped failure/timedOut verdict as possibly-freeze-induced
        // instead of reporting it as an unqualified clean red.
        freezeMs: pcHeavyFreezeMsBetween(freezeMsAtStart, readPcHeavyFrozenTotalMs()),
      });
    });
  });
  // A repeated invocation of the same file is a NEW resident process and must
  // not reuse a completed receipt. Keep the human-readable command in the
  // identity while adding a per-call nonce for durable idempotency.
  const processIdentity = `${process.pid}:${randomUUID()}:${JSON.stringify({ command, args, cwd, files, cwdLabel })}`;
  const governedOptions = {
    workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE,
    namespace: 'test-files-process',
    owner: `test-files:${cwdLabel}:${process.pid}`,
    idempotencyKey: governedProcessIdempotencyKey('test-files', processIdentity),
    payloadRef: `test-files:${cwdLabel}`,
    timeoutMs,
    demand: plannedDemand,
    metadata: {
      processKind: 'test-files-child',
      cwd: cwdLabel,
      fileCount: files.length,
      timeoutMs,
    },
    env,
    settle: classifyGovernedTestProcessOutcome,
  };
  return runGovernedTestFileProcess(governedProcessImpl, governedOptions, runChild);
}

/**
 * Run Vitest's collection preflight without blocking the router event loop.
 *
 * `main()` must list requested files before executing them so a partial/zero
 * match cannot read as green. That preflight used `spawnSync`, which meant a
 * synchronous transform/import wedge could also prevent the parent watchdog's
 * timers from running. Reuse the async process-group runner, but keep this
 * reversible read ungoverned (the historical list path was not a test-process
 * admission) and give it an absolute deadline: a noisy collection process
 * cannot extend a preflight forever just by writing logs.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: object, cwdLabel?: string, timeoutMs?: number,
 *   spawnImpl?: Function, killProcessImpl?: Function, onProgress?: Function }} [options]
 * @returns {Promise<object>}
 */
export function runVitestList(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    cwdLabel = cwd ?? '.',
    timeoutMs = DEFAULT_TEST_FILE_LIST_TIMEOUT_MS,
    progressIntervalMs = TEST_FILE_PROGRESS_INTERVAL_MS,
    watchdogStallWindowMs = TEST_FILE_WATCHDOG_STALL_WINDOW_MS,
    watchdogExtensionMs = TEST_FILE_WATCHDOG_EXTENSION_MS,
    killGraceMs = TEST_FILE_KILL_GRACE_MS,
    systemdRunPath = SYSTEMD_RUN_PATH,
    setsidPath = SETSID_PATH,
    spawnImpl,
    killProcessImpl,
    stopScopeImpl,
    onProgress,
  } = options;
  return runCapturedTestProcess(command, args, {
    cwd,
    env,
    cwdLabel,
    // No file-completion rows are expected from `vitest list`; pass an empty
    // file set so its output cannot accidentally satisfy the run accounting.
    files: [],
    timeoutMs,
    progressIntervalMs,
    watchdogStallWindowMs,
    watchdogExtensionMs,
    killGraceMs,
    systemdRunPath,
    setsidPath,
    watchdogMaxMs: timeoutMs,
    ...(spawnImpl ? { spawnImpl } : {}),
    ...(killProcessImpl ? { killProcessImpl } : {}),
    ...(stopScopeImpl ? { stopScopeImpl } : {}),
    ...(onProgress
      ? { onProgress }
      : { onProgress: (line) => console.error(line.replace(/^TEST_FILE_PROGRESS\b/, 'TEST_FILE_LIST_PROGRESS')) }),
    // Collection is a reversible preflight and must not consume a second
    // resource-governor lease before the real test process starts.
    governedProcessImpl: (_governedOptions, run) => run(undefined, env, { inherited: true }),
  });
}

// `testing:run` is the supported routed surface for focused tests. Keep every
// CLI refusal actionable: a bare TEST_FILE_ROUTE_ERROR leaves agents guessing
// whether to retry the same command, hand-pick a Vitest config, or use the tool
// that already owns this routing contract.
export const TESTING_RUN_GUIDANCE = 'For the supported routed test surface, use testing:run { files: [...] }.';

export function formatRouteError(detail) {
  return `TEST_FILE_ROUTE_ERROR ${detail}; ${TESTING_RUN_GUIDANCE}`;
}

/**
 * @param {string[]} [argv]
 * @param {{runCapturedTestProcessImpl?: typeof runCapturedTestProcess}} [options]
 */
export async function main(
  argv = process.argv.slice(2),
  {
    runCapturedTestProcessImpl = runCapturedTestProcess,
    runVitestListImpl = runVitestList,
    restrictedHoldPreflightImpl = runRestrictedHoldPreflight,
  } = {},
) {
  let cleanupPreemptReadyMarker = null;
  let cleanupPreemptFinalizationMarker = null;
  const cleanupPreemptMarkers = () => {
    const readyCleanup = cleanupPreemptReadyMarker;
    const finalizationCleanup = cleanupPreemptFinalizationMarker;
    cleanupPreemptReadyMarker = null;
    cleanupPreemptFinalizationMarker = null;
    readyCleanup?.();
    finalizationCleanup?.();
  };
  // EI-19380376466745152: a scratch dir for the private json reports injected below. Lazily
  // created, owned by this run, and removed in the same finally as the preempt markers — an
  // injected diagnostic must never leave litter in the tree or fail a real run, so every
  // filesystem call here is guarded and degrades to "no report" rather than throwing.
  let injectedReportDir = null;
  const injectedReportDirFor = () => {
    if (injectedReportDir !== null) return injectedReportDir;
    try {
      injectedReportDir = mkdtempSync(join(tmpdir(), 'papercusp-test-files-report-'));
    } catch {
      injectedReportDir = '';
    }
    return injectedReportDir === '' ? null : injectedReportDir;
  };
  const cleanupInjectedReports = () => {
    const dir = injectedReportDir;
    injectedReportDir = '';
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — a leftover temp dir is not worth failing a green run over */
    }
  };
  const ensurePreemptReady = () => {
    if (cleanupPreemptReadyMarker) return true;
    try {
      cleanupPreemptReadyMarker = publishPreemptReadyMarker();
      return true;
    } catch (error) {
      console.error(
        formatRouteError(
          `refusing execution phase: could not publish the pc-heavy after-ready marker: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return false;
    }
  };
  // Publishing supersedes the previous group's marker, so consecutive groups
  // never stack protection. Releasing is deliberately NOT done per child: it is
  // owned by `cleanupPreemptMarkers()` in main()'s finally (which runs only after
  // TEST_FILE_RESULT is printed) and, as last resort, by pc-heavy's terminal/reap
  // cleanup. See the ownership note above `runChild` in runCapturedTestProcess.
  const finalizationCallbacks = () => ({
    onAllFilesComplete: () => {
      cleanupPreemptFinalizationMarker?.();
      cleanupPreemptFinalizationMarker = publishPreemptFinalizationMarker();
    },
  });
  try {
  const { dry, requireRan, files, vitestArgs } = parseCli(argv);
  if (files.length === 0) {
    console.error('usage: npm run test:file -- <test-file> [test-file…] [-- <vitest args>]');
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
  const nonVerdictOption = nonVerdictOptionFrom(vitestArgs);
  if (nonVerdictOption) {
    console.error(
      `TEST_FILE_NOT_MEASURED requested=${files.length} executed=0 matched=0 status=not-measured ` +
        `reason=non-verdict-option option=${JSON.stringify(nonVerdictOption)} — Vitest printed CLI ` +
        'metadata instead of executing tests; refusing to report a test verdict. ' +
        'Remove the help/version option and rerun the same command.',
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }

  const unsupportedFiles = files.filter((file) => !isTestFilePath(file));
  const testFiles = files.filter((file) => isTestFilePath(file));
  const unsupportedMarker = formatUnsupportedTestInputs(unsupportedFiles);
  if (unsupportedMarker) console.error(unsupportedMarker);
  if (testFiles.length === 0) {
    console.error(
      formatRouteError(
        'no test paths were requested after filtering unsupported non-test inputs; ' +
          'pass a *.test.* or *.spec.* file',
      ),
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }

  if (!dry) {
    const scopeWarning = unscopedFocusedRunWarning();
    if (scopeWarning) console.warn(scopeWarning);
  }

  let routes;
  try {
    routes = testFiles.map((file) => discoverTestRoute(isAbsolute(file) ? relative(REPO_ROOT, file) : file));
  } catch (error) {
    console.error(formatRouteError(error instanceof Error ? error.message : String(error)));
    return TEST_FILE_EXIT_NOT_MEASURED;
  }

  const groups = groupRoutes(routes);
  const nameFilter = nameFilterFrom(vitestArgs);
  let listTimeoutMs;
  try {
    listTimeoutMs = testFileListTimeoutMs(process.env);
  } catch (error) {
    console.error(formatRouteError(error instanceof Error ? error.message : String(error)));
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
  console.log(`TEST_FILE_ROUTE requested=${routes.length} groups=${groups.length}`);
  // EI-18681435059177620: stamp WHAT IS ABOUT TO BE MEASURED before measuring it. Printed up front
  // as well as at the end because a run that is killed, hung, or timed out by its caller still has
  // to say which state it was describing — that partial log is exactly the one that gets pasted.
  const provenanceBefore = snapshotProvenance(routes.map((route) => route.absolute));
  console.log(formatProvenanceBanner(provenanceBefore, 'pre-run'));
  // EI-18750303030034478: an in-tree mutation probe deliberately breaks a tracked file for the length
  // of its guard run, and a red read from that mutant looks exactly like a regression in YOUR change.
  // Diagnostic only: one stderr line, never a verdict input (see scripts/lib/mutation-probe-window.mjs).
  const probeWindowBefore = readMutationProbeWindow(REPO_ROOT);
  if (probeWindowBefore) console.error(formatMutationProbeWindow(probeWindowBefore, REPO_ROOT));
  // WI-10005713 (D-012 / R-11): a session holding an active personal disclosure has no network,
  // but a test or source it WROTE would run here with the network. Refuse before ANY test process
  // starts — the same restrictedHoldRefusal testing:run applies in-process (it marks the child env
  // so this does not run twice). Fail-closed: an unreadable census refuses too.
  if (!dry) {
    const restrictedHold = restrictedHoldPreflightImpl({ repoRoot: REPO_ROOT, files: routes.map((route) => route.absolute) });
    if (restrictedHold.verdict === 'refuse') {
      console.error(formatRestrictedHoldRefusal(restrictedHold));
      return TEST_FILE_EXIT_NOT_MEASURED;
    }
    // WI-10005724: every vitest this router starts inherits process.env, and its root preflight
    // (libs/test-config host-preflight globalSetup) would otherwise repeat the same ~2s census.
    // Only a real admit marks it; a skip means an enclosing root already set (or owns) the marker.
    if (restrictedHold.verdict === 'admit') {
      process.env[RESTRICTED_HOLD_PREFLIGHT_ENV] = RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER;
    }
  }
  // EI-13535: every group runs UNCONDITIONALLY — a mismatch or failure in one workspace's group
  // must never abandon the OTHER groups a multi-workspace request spans (see aggregateGroupResults
  // doc for the full incident). Each iteration always records its outcome and moves on; the final
  // verdict is decided only after every group has had its chance to run.
  const groupResults = [];
  // EI-19462803905923939 / EI-19467022057492490: collected per-group so the attribution can be
  // RESTATED after the aggregate refusal below — see the comment there for why the group-level
  // print is not enough. Holds BOTH attribution shapes (esbuild transform failures and runtime
  // collection crashes) — they are mutually exclusive per group, so a flat list is fine.
  const attributionMarkers = [];
  // EI-19467022057492490: cap the per-file re-list fallback so a pathologically large batch (a
  // huge GATE_HELD_BY set) cannot turn one route error into dozens of extra `vitest list` spawns.
  // Above this, the caller gets today's plain (undifferentiated) route error and re-runs files
  // individually by hand — exactly the documented fallback, just not auto-attributed.
  const MULTI_FILE_ATTRIBUTION_CAP = 25;
  for (const [groupIndex, group] of groups.entries()) {
    const cwdLabel = relative(REPO_ROOT, group.cwd) || '.';
    if (group.runner === 'node') {
      const exact = group.routes.map((route) => route.requested);
      console.log(`ROUTE cwd=${cwdLabel} runner=node:test`);
      for (const file of exact) console.log(`  requested ${file}`);
      if (!dry && !ensurePreemptReady()) return TEST_FILE_EXIT_TEMPFAIL;
      const nodeDemand = buildGovernedProcessDemand({
        fileCount: exact.length,
        diskBytes: 256 * 1024 * 1024,
        fileDescriptors: 16 + Math.max(1, exact.length),
      });
      const nodeIdentity = `${process.pid}:${randomUUID()}:${cwdLabel}:${exact.join('\0')}`;
      const result = await runGovernedTestFileProcess(runGovernedTestProcess, {
        workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE,
        namespace: 'test-files-node-process',
        owner: `test-files:${cwdLabel}:${process.pid}`,
        idempotencyKey: governedProcessIdempotencyKey('test-files-node', nodeIdentity),
        payloadRef: `test-files:${cwdLabel}`,
        timeoutMs: testFileRunTimeoutMs(process.env, exact.length),
        demand: nodeDemand,
        metadata: { processKind: 'test-files-node-child', cwd: cwdLabel, fileCount: exact.length },
        env: process.env,
        settle: classifyGovernedTestProcessOutcome,
      }, async (_admissionContext, governedEnv) => {
        const child = spawnSync(process.execPath, ['--test', ...exact, ...vitestArgs], {
          cwd: group.cwd,
          env: governedEnv,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        });
        return { ...child, actualDemand: nodeDemand };
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      printTestFinalizationError(result);
      if (result.error) {
        if (result.governedAdmissionError) {
          console.error(`TEST_FILE_ADMISSION_ERROR kind=${result.governedAdmissionFailureKind ?? 'undetermined'} detail=${JSON.stringify(result.error.message)} origin=${JSON.stringify(result.error.cause?.stack ?? result.error.stack)}`);
        } else {
          console.error(formatRouteError(`(group cwd=${cwdLabel}) could not launch Node:test: ${result.error.message}`));
        }
      }
      const groupFailed = result.governedAdmissionError
        ? false
        : Boolean(result.error) || result.status !== 0;
      if (groupFailed) {
        console.error(`TEST_FILE_GROUP_RESULT cwd=${cwdLabel} runner=node:test executed=${result.error ? 0 : exact.length} status=failed`);
      }
      groupResults.push({
        requested: group.routes.length,
        matched: group.routes.length,
        executed: result.error ? 0 : exact.length,
        unmatchedCount: 0,
        failed: groupFailed,
        launchError: Boolean(result.error),
        finalizationError: Boolean(result.governedFinalizationError),
        ...(result.governedAdmissionError
          ? { governedAdmissionFailureKind: result.governedAdmissionFailureKind ?? 'undetermined' }
          : {}),
      });
      continue;
    }
    // EI-18822211427354845: each group writes its OWN report file when the run spans
    // several groups, so one group's report can never overwrite another's.
    // EI-19380376466745152: and when the caller chose no reporting of their own, add a PRIVATE
    // json report beside the human one, because skipped test NAMES exist nowhere else. Injected
    // here (not into `vitestArgs`) so the per-file detail-recovery re-run below — which strips
    // `--outputFile` but would keep `--reporter=json`, and would then print JSON where a human is
    // meant to read a failure — never sees these args.
    const injectedReportDir = injectedReportDirFor();
    const { args: groupVitestArgs, injectedReportPath } = withInjectedJsonReport(
      perGroupVitestArgs(vitestArgs, groupIndex, groups.length),
      injectedReportDir ? join(injectedReportDir, `group-${groupIndex}.json`) : null,
    );
    const requested = group.routes.map((route) => route.requested);
    // A null config is a config-less Vitest package (libs/generic/* shape): omit `--config`
    // entirely so Vitest auto-discovers its defaults from the package cwd, exactly as its own
    // documented `npm test` (`vitest run`) does.
    const configArgs = group.config ? ['--config', group.config] : [];
    console.log(`ROUTE cwd=${cwdLabel} config=${group.config ?? '(package default)'}`);
    for (const file of requested) console.log(`  requested ${file}`);

    warnIfInstallInFlight(`\`vitest list\` (group cwd=${cwdLabel})`);
    // Vitest 4's default tree output omits files whose collected tests are all skipped.
    // File-level output keeps the route guard about requested FILES, not runnable tests.
    const listed = await runVitestListImpl(
      'npx',
      ['vitest', 'list', '--filesOnly', ...configArgs, ...requested],
      {
        cwd: group.cwd,
        env: process.env,
        cwdLabel,
        timeoutMs: listTimeoutMs,
      },
    );
    const listedOutput = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}${listed.error ? listed.error.message : ''}`;
    if (listed.timedOut) {
      console.error(
        `TEST_FILE_LIST_WATCHDOG cwd=${cwdLabel} files=${JSON.stringify(requested)} ` +
          `timeoutMs=${listTimeoutMs} status=timed-out — owned collection child tree reaped; ` +
          'NOT MEASURED — Vitest did not produce a complete collection listing. ' +
          'Widen with PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS=<milliseconds> and rerun the same command.',
      );
      groupResults.push({
        requested: group.routes.length,
        matched: 0,
        executed: 0,
        unmatchedCount: group.routes.length,
        failed: false,
        launchError: true,
      });
      continue;
    }
    if (listed.error) {
      console.error(formatRouteError(`(group cwd=${cwdLabel}) could not launch Vitest: ${listed.error.message}`));
      if (looksLikeMidInstallCorruption(listedOutput)) {
        console.error(MID_INSTALL_HINT);
      }
      groupResults.push({
        requested: group.routes.length,
        matched: 0,
        executed: 0,
        unmatchedCount: group.routes.length,
        failed: false,
        launchError: true,
      });
      continue;
    }
    const listedMatches = listedFiles(`${listed.stdout ?? ''}\n${listed.stderr ?? ''}`, group.cwd, true);
    // EI-21108362231170830: do not trust every path Vitest emits after an explicit request. A
    // matching test in `.papercusp/worktrees/` is not part of this run and must never reach the
    // exact `vitest run` argument list below.
    const matched = canonicalMatch(group.routes, listedMatches);
    const verdict = evaluateMatch({ routes: group.routes, matched, listStatus: listed.status });
    if (!verdict.ok) {
      if (listed.stdout) process.stdout.write(listed.stdout);
      if (listed.stderr) process.stderr.write(listed.stderr);
      for (const route of verdict.unmatched) console.error(`  unmatched ${route.requested}`);
      console.error(formatRouteError(
        `(group cwd=${cwdLabel}) requested=${verdict.requested} matched=${verdict.matched}; refusing a false-green zero/partial-match run for this group`,
      ));
      if (looksLikeMidInstallCorruption(listedOutput)) {
        console.error(MID_INSTALL_HINT);
      }
      // EI-19462803905923939: a transform failure anywhere in the import graph produces exactly
      // this zero match, so name the real culprit instead of leaving `matched=0` to be read as a
      // routing fault or as a defect in the file the caller named.
      const transformMarker = transformFailureMarker({
        locations: parseTransformFailure(listedOutput),
        routes: group.routes,
        cwd: group.cwd,
        requested: verdict.requested,
        matched: verdict.matched,
      });
      if (transformMarker) {
        console.error(transformMarker);
        attributionMarkers.push(transformMarker);
      } else if (group.routes.length > 1 && group.routes.length <= MULTI_FILE_ATTRIBUTION_CAP) {
        // EI-19467022057492490: no esbuild culprit found, but a multi-file group's whole `vitest
        // list` still failed — re-list each requested file ALONE so a lone runtime collection
        // crash (e.g. a vi.mock factory throw) doesn't misattribute every OTHER healthy file in
        // the batch as broken. Deliberately only for multi-file groups: a single-file group's
        // error already IS about the one file the caller named — no ambiguity to resolve.
        const perFile = [];
        for (const route of group.routes) {
          const singleListed = await runVitestListImpl(
            'npx',
            ['vitest', 'list', '--filesOnly', ...configArgs, route.requested],
            {
              cwd: group.cwd,
              env: process.env,
              cwdLabel,
              timeoutMs: listTimeoutMs,
            },
          );
          const singleOutput = `${singleListed.stdout ?? ''}\n${singleListed.stderr ?? ''}`;
          const singleMatched = listedFiles(singleOutput, group.cwd, true);
          perFile.push({
            requested: route.requested,
            ok: !singleListed.timedOut && singleListed.status === 0 && singleMatched.includes(route.absolute),
          });
        }
        const attributionMarker = collectionAttributionMarker({
          perFile,
          cwd: group.cwd,
          groupRequested: verdict.requested,
          groupMatched: verdict.matched,
        });
        if (attributionMarker) {
          console.error(attributionMarker);
          attributionMarkers.push(attributionMarker);
        }
      }
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: verdict.unmatched.length,
        failed: false,
        launchError: false,
      });
      continue;
    }
    for (const file of matched) console.log(`  matched ${relative(group.cwd, file)}`);
    if (dry) {
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: 0,
        failed: false,
        launchError: false,
      });
      continue;
    }

    const exact = matched.map((file) => relative(group.cwd, file));
    // Captured so the EI-18099113673609528 silent-collection-failure signature can be detected
    // below; forwarded verbatim on completion so nothing is lost for a live TTY. The ASYNC seam
    // emits bounded progress separately while retaining the existing 256MB capture ceiling.
    warnIfInstallInFlight(`\`vitest run\` (group cwd=${cwdLabel})`);
    if (!ensurePreemptReady()) return TEST_FILE_EXIT_TEMPFAIL;
    // The whole-run budget scales with the positional list (see testFileRunTimeoutMs): a
    // gate `--related` list of a few hundred files must not inherit the single-file floor.
    const runTimeoutMs = testFileRunTimeoutMs(process.env, exact.length);
    const result = await runCapturedTestProcessImpl(
      'npx',
      ['vitest', 'run', ...configArgs, ...exact, ...groupVitestArgs],
      {
        cwd: group.cwd,
        env: process.env,
        files: exact,
        cwdLabel,
        timeoutMs: runTimeoutMs,
        ...finalizationCallbacks(),
      },
    );
    // The injected report is private and removed in main()'s finally. Do not leak Vitest's
    // `JSON report written to ...` notice for that disposable path; otherwise callers receive a
    // drill-down pointer that is guaranteed to be ENOENT after this command exits. Keep the raw
    // result untouched for verdict parsing below, and preserve notices for caller-owned reports.
    const visibleStdout = suppressInjectedJsonReportNotice(result.stdout ?? '', injectedReportPath);
    const visibleStderr = suppressInjectedJsonReportNotice(result.stderr ?? '', injectedReportPath);
    if (visibleStdout) process.stdout.write(visibleStdout);
    if (visibleStderr) process.stderr.write(visibleStderr);
    printTestFinalizationError(result);
    if (result.timedOut) {
      console.error(
        `TEST_FILE_WATCHDOG cwd=${cwdLabel} files=${JSON.stringify(exact)} ` +
          `timeoutMs=${runTimeoutMs} status=timed-out — owned child tree reaped; ` +
          'NOT MEASURED — no test-failure verdict was produced. Widen with ' +
          'PAPERCUSP_TEST_FILE_TIMEOUT_MS=<milliseconds> and rerun the same npm run test:file command.',
      );
      if (result.freezeMs > 0) {
        console.error(
          `TEST_FILE_FREEZE_QUALIFIER cwd=${cwdLabel} frozenMs=${result.freezeMs} — a pc-heavy PSI ` +
            'freeze SIGSTOPped this run for part of its wall-clock window (wall clock kept running ' +
            'while the process tree could not execute), so this timeout-shaped watchdog reap is ' +
            'possibly-freeze-induced, not necessarily a genuine hang (EI-21903376339103215). Before ' +
            're-attributing it to the code under test, re-run once PSI is not under pressure, or ' +
            `widen PAPERCUSP_TEST_FILE_TIMEOUT_MS by at least ${result.freezeMs}ms.`,
        );
      }
    }
    if (result.error) {
      if (result.governedAdmissionError) {
        console.error(`TEST_FILE_ADMISSION_ERROR kind=${result.governedAdmissionFailureKind ?? 'undetermined'} detail=${JSON.stringify(result.error.message)} origin=${JSON.stringify(result.error.cause?.stack ?? result.error.stack)}`);
      } else {
        console.error(formatRouteError(`(group cwd=${cwdLabel}) could not launch Vitest: ${result.error.message}`));
        if (looksLikeMidInstallCorruption(result.error.message)) {
          console.error(MID_INSTALL_HINT);
        }
      }
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: 0,
        failed: false,
        launchError: true,
        ...(result.governedAdmissionError
          ? { governedAdmissionFailureKind: result.governedAdmissionFailureKind ?? 'undetermined' }
          : {}),
      });
      continue;
    }
    const runOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    // EI-21902345477441137: a watchdog reap kills the child via signal, so `result.status` is
    // typically `null` — `null !== 0` would make vitestRunFailed() report a false FAILED verdict
    // for a run that produced no verdict at all. A reaped group is NOT MEASURED, never `failed`;
    // skip the classifier entirely rather than run it against a killed process's exit state.
    const groupFailed = result.timedOut ? false : vitestRunFailed({ status: result.status, output: runOutput });
    const reportPath = outputFilePathFrom(groupVitestArgs);
    // EI-22591950423157299: the private report is removed in main()'s finally, so consume the
    // ordinary assertion failures while it is still present. This is deliberately separate from
    // the file-level collection-failure recovery below: a report with no assertionResults has no
    // assertion detail to print, and must not turn a collection error into a test-name failure.
    const failedAssertionDiagnostics = groupFailed
      ? formatFailedAssertionDiagnostics(failedAssertionsFromReport(reportPath, group.cwd))
      : '';
    if (!result.timedOut && result.status === 0 && groupFailed) {
      const summary = parseSummaryFailedCounts(runOutput);
      console.error(
        `⚠ Vitest exited 0 but its summary reports ${summary?.testFiles ?? 0} failed test file(s) / ` +
          `${summary?.tests ?? 0} failed test(s) — treating this group as failed ` +
          '(EI-21124682504777505: an exit-code/summary mismatch must not read as green)',
      );
    }
    if (result.timedOut) {
      // EI-21902345477441137: this is the SUMMARY line a `grep status=` / `| tail` reader lands
      // on — it must carry the same NOT-MEASURED verdict the TEST_FILE_WATCHDOG detail line above
      // already gave, never `status=failed`, which blames the code under test for a harness reap.
      console.error(`TEST_FILE_GROUP_RESULT cwd=${cwdLabel} executed=${exact.length} status=not-measured`);
    } else if (groupFailed) {
      console.error(`TEST_FILE_GROUP_RESULT cwd=${cwdLabel} executed=${exact.length} status=failed`);
      if (failedAssertionDiagnostics) console.error(failedAssertionDiagnostics);
      if (result.freezeMs > 0) {
        console.error(
          `TEST_FILE_FREEZE_QUALIFIER cwd=${cwdLabel} frozenMs=${result.freezeMs} — a pc-heavy PSI ` +
            'freeze SIGSTOPped this run for part of its wall-clock window (wall clock kept running ' +
            'while the process tree could not execute), so any timeout/deadline-based failure in the ' +
            'report above is possibly-freeze-induced, not necessarily a genuine defect ' +
            '(EI-21903376339103215). Cross-check the specific failing test\'s own duration against ' +
            'frozenMs before treating it as a clean red; a non-timeout assertion failure is unaffected.',
        );
      }
      if (looksLikeMidInstallCorruption(runOutput)) {
        console.error(MID_INSTALL_HINT);
      }
      // EI-18099113673609528: >=2 files + zero per-suite detail is Vitest 4's silent
      // simultaneous-collection-failure reporter gap — re-run each file alone (where the same
      // failure DOES print in full) so the caller isn't left with an undiagnosable "N failed / no
      // tests" and nothing else.
      if (exact.length > 1 && looksLikeSilentCollectionFailure(runOutput)) {
        console.error(
          `TEST_FILE_DETAIL_RECOVERY cwd=${cwdLabel} Vitest printed zero per-suite error detail for ${exact.length} failed files (known Vitest 4 reporter gap when >=2 files fail collection at once) — re-running each file individually to surface the actual error:`,
        );
        for (const file of exact) {
          console.error(`\n>>> re-running ${file} alone for detail`);
          const detailResult = await runCapturedTestProcessImpl(
            'npx',
            ['vitest', 'run', ...configArgs, file, ...withoutOutputFileArg(vitestArgs)],
            {
              cwd: group.cwd,
              env: process.env,
              files: [file],
              cwdLabel,
              ...finalizationCallbacks(),
            },
          );
          if (detailResult.stdout) process.stdout.write(detailResult.stdout);
          if (detailResult.stderr) process.stderr.write(detailResult.stderr);
          printTestFinalizationError(detailResult);
          if (detailResult.timedOut) {
            console.error(
              `TEST_FILE_DETAIL_RECOVERY_TIMEOUT cwd=${cwdLabel} file=${JSON.stringify(file)} ` +
                `timeoutMs=${TEST_FILE_RUN_TIMEOUT_MS} status=timed-out — owned child tree reaped; ` +
                'NOT MEASURED — no test-failure verdict was produced. Widen with ' +
                'PAPERCUSP_TEST_FILE_TIMEOUT_MS=<milliseconds> and rerun.',
            );
          }
        }
      }
    }
    // EI-19380376466745152: read the per-assertion outcomes ONCE per group, before the push below
    // consumes them for three different fields. `null` here means no readable report, not an empty
    // run — the difference is what keeps "names unavailable" from rendering as "nothing skipped".
    const groupOutcomes = assertionOutcomesFromReport(reportPath, group.cwd);
    groupResults.push({
      requested: verdict.requested,
      matched: verdict.matched,
      executed: exact.length,
      // EI-19425177453558152: `executed` counts FILES. Under a name filter that is not enough to
      // know anything ran, so measure TESTS too — `undefined` when no filter is in play keeps the
      // three states (n/a · unreadable · measured) distinct in aggregateGroupResults.
      //
      // EI-19451028801041450: prefer the JSON report's exact counts, and fall back to the stdout
      // summary row only when there is no report. Reading stdout FIRST would be inert for every
      // caller that passes `--reporter=json` (which `testing:run` always does) — under a machine
      // reporter no `Tests` row is printed at all, so the guard would fail open every time.
      // `??` and not `||`: a measured 0 is the whole point of this check and must NOT be
      // retried as if it were unreadable.
      testsExecuted: nameFilter
        ? testsExecutedFromReport(reportPath, group.cwd) ??
          testsExecutedFrom(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
        : undefined,
      // EI-19380376466745152: skipped is measured on EVERY run, not only under a name filter —
      // the incident's run had no filter. Same report-first, stdout-fallback order and the same
      // `??` (a measured 0 must not be retried as if unreadable). `outcomes` is null whenever no
      // report was readable, which degrades to "names unavailable", never to "nothing skipped".
      testsSkipped:
        groupOutcomes !== null
          ? groupOutcomes.skipped.length
          : testsSkippedFrom(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
      skippedNames: groupOutcomes?.skipped ?? [],
      executedNames: groupOutcomes?.executed ?? [],
      unmatchedCount: 0,
      failed: groupFailed,
      launchError: false,
      finalizationError: Boolean(result.governedFinalizationError),
      // EI-21902345477441137: distinct from `failed` — a reaped run produced no verdict at all,
      // so it must never contribute to `anyFailed` (that would be the exact bug this fixes) nor
      // silently read as a clean pass (that would hide a genuine resource-limit problem).
      timedOut: Boolean(result.timedOut),
      // EI-21903376339103215: ms of pc-heavy freeze inside this group's own run window (0 when
      // pc-heavy was not in play or no freeze occurred) — carried through so any consumer of the
      // structured group result (not just the console.error qualifier above) can see it too.
      freezeMs: result.freezeMs ?? 0,
    });
  }

  const summary = aggregateGroupResults(groupResults);
  if (summary.launchError) {
    if (summary.governedAdmissionFailureKind) {
      console.error(
        `TEST_FILE_NOT_MEASURED requested=${summary.requested} executed=${summary.executed} ` +
          `matched=${summary.matched} measuredFiles=0 status=not-measured ` +
          `reason=${summary.governedAdmissionFailureKind} — governed test-process admission ` +
          (summary.governedAdmissionFailureKind === 'admission-starved'
            ? 'was refused after retryable database contention; no test file ran. Retry when the admission queue clears.'
            : 'failed before a test process started; no test file ran. The cause is undetermined, so do not triage the named files.'),
      );
    }
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
  if (summary.anyUnmatched) {
    console.error(formatRouteError(
      `requested=${summary.requested} matched=${summary.matched}; refusing a false-green zero/partial-match run`,
    ));
    // EI-19462803905923939 / EI-19467022057492490: this aggregate line is the LAST thing a
    // `| tail -N` reads — the very idiom CLAUDE.md prescribes throughout — so the attribution has
    // to be restated HERE. Printing it only at the group level (where it also belongs, next to the
    // evidence) still leaves the misleading routing claim as the terminal line, which is the
    // entire defect.
    for (const marker of attributionMarkers) console.error(marker);
    // EI-21884126680256710: a zero/partial-match refusal measured NOTHING, so it must not use the
    // measured-red code. It returned 1 — identical to "your tests failed" — which is how a routing
    // miss gets triaged as a defect in the file named on the line.
    return TEST_FILE_EXIT_NOT_MEASURED;
  }

  // EI-19376339983058011 — THE MARKER'S PRESENCE MUST IMPLY THAT TESTS RAN.
  // A dry run executes nothing, yet used to print the same `TEST_FILE_RESULT` line callers read
  // as a verdict. The reported measurement harness guarded exactly this way —
  // `if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi` — so a dry run satisfied the guard
  // with executed=0 and exit 0, and its zero parsed FAIL lines were recorded as "this candidate
  // passes". Four corpus rows were written that way, each in ~37s, far too fast to have run a
  // suite. Emitting a DISTINCT marker makes the presence test the caller already writes correct
  // by construction, instead of requiring every caller to also parse `status=`.
  if (dry) {
    console.log(
      `TEST_FILE_DRYRUN requested=${summary.requested} executed=0 matched=${summary.matched} status=dry-run ` +
        `${provenanceResultFields(provenanceBefore, null)}`,
    );
    // `--dry` is the one place 0 does NOT mean "measured and green": it means routing resolved and
    // no tests were run BY DESIGN. Called out because the exit-code contract otherwise reserves 0
    // for a measured pass, and an undocumented exception is how a contract stops being one.
    return TEST_FILE_EXIT_PASSED;
  }

  // EI-18681435059177620: re-measure AFTER the run. This is the half that would have caught the
  // reported incident automatically — a tested file edited while the suite was executing leaves a
  // verdict that describes neither state, and until now nothing said so.
  const provenanceAfter = snapshotProvenance(routes.map((route) => route.absolute));
  const provenanceDiff = diffProvenanceSnapshots(provenanceBefore, provenanceAfter);
  const driftMarker = formatProvenanceDrift(provenanceDiff);
  if (driftMarker) console.error(driftMarker);
  console.log(formatProvenanceBanner(provenanceAfter, 'post-run'));
  // Re-read AFTER the run: a probe that opened its window mid-run is the case the pre-run read missed.
  const probeWindowAfter = readMutationProbeWindow(REPO_ROOT);
  if (probeWindowAfter) console.error(formatMutationProbeWindow(probeWindowAfter, REPO_ROOT));

  // The invariant the line below now carries. Unreachable today — a zero/partial match is refused
  // per-group above, and `executed` is derived from that matched set — which is precisely why it
  // is ASSERTED rather than assumed: if a future edit ever makes executed=0 reachable here, this
  // refuses loudly instead of printing a verdict for a run that tested nothing.
  if (summary.executed < 1) {
    console.error(formatRouteError(
      `requested=${summary.requested} matched=${summary.matched} executed=0; ` +
        `refusing to report a verdict for a run that executed no tests`,
    ));
    // EI-21884126680256710: executed=0 is the definition of NOT MEASURED. Returning the
    // genuine-red code here contradicted the refusal printed one line above it.
    return TEST_FILE_EXIT_NOT_MEASURED;
  }

  // EI-19425177453558152 — a name filter that matched ZERO tests measured NOTHING.
  //
  // This deliberately does NOT print `TEST_FILE_RESULT ... status=failed`, which is what the
  // filing suggested: EI-19376339983058011 (directly above) established that the marker's
  // PRESENCE is the verdict callers grep for (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED`).
  // Zero tests ran, so the honest report is UNMEASURED — the marker must be absent, and the
  // failure carried by the exit code plus its own distinct marker.
  if (nameFilter) {
    const receivedAs = [nameFilter.flag, nameFilter.pattern, ...nameFilter.strays].join(' ');
    const strayNote =
      nameFilter.strays.length > 0
        ? ` — vitest received \`${receivedAs}\`, i.e. the pattern "${nameFilter.pattern}" PLUS ` +
          `${nameFilter.strays.length} stray positional(s) [${nameFilter.strays.join(', ')}] it reads as extra FILE ` +
          'filters. That is the signature of a quoted pattern being eaten by the shell/npm arg chain: quote it ' +
          'for the inner command (npm eats one level) or use a space-free pattern.'
        : '';
    // A failed setup/collection or a watchdog can also leave every assertion
    // skipped. Preserve those measured outcomes below; zero executed tests is
    // evidence of an unmatched filter only when the runner otherwise succeeded.
    if (summary.testsExecuted === 0 && summary.testsUnmeasuredGroups === 0 &&
        !summary.anyFailed && !summary.anyTimedOut) {
      console.error(
        `TEST_FILE_NAME_FILTER_NO_MATCH requested=${summary.requested} matched=${summary.matched} ` +
          `executedFiles=${summary.executed} testsExecuted=0 status=failed reason=name-filter-matched-no-tests ` +
          `pattern=${JSON.stringify(nameFilter.pattern)}; refusing to report a verdict for a run that ` +
          `executed no tests${strayNote}`,
      );
      // EI-21884126680256710: `status=failed` in the marker above names the REFUSAL, not a test
      // verdict — nothing ran. The exit code follows the refusal, not the word.
      return TEST_FILE_EXIT_NOT_MEASURED;
    }
    if (summary.testsExecuted === null || summary.testsUnmeasuredGroups > 0) {
      // Fail OPEN — never fabricate a red from an unreadable count (a JSON reporter writes no
      // summary row). Say so out loud so the hole cannot silently reopen.
      console.error(
        `TEST_FILE_NAME_FILTER_UNVERIFIED pattern=${JSON.stringify(nameFilter.pattern)}; could not read vitest's ` +
          "`Tests` summary row, so whether the name filter executed any tests is UNVERIFIED — the status below " +
          `does not rule out a zero-match run${strayNote}`,
      );
    }
  }

  // The provenance fields describe the state this result MEASURED (the pre-run snapshot), not
  // whatever is on disk now; `provenance=drifted` is what says those two differ. Appended AFTER
  // `status=` so every existing consumer keeps parsing unchanged — the doc-claims anchor registry
  // pins `TEST_FILE_RESULT requested=` as the first field, and every reader tokenises `status=`.
  //
  // EI-19380376466745152 — NAME the tests that did not run, before the verdict line.
  //
  // Printed here, immediately above `TEST_FILE_RESULT`, for the reason this file already learned
  // twice about the provenance fields: the tail is what a caller reads and what gets pasted into a
  // work-item as evidence. A warning at the top of a 200-line run scrolls out of exactly that
  // excerpt. `requested=…` stays TEST_FILE_RESULT's first field (pinned by the doc-claims anchor
  // registry) and `skippedTests=` is appended last, so every existing tokenising reader — including
  // testing:run's `status=(passed|failed)\b[^\r\n]*$` marker regex — parses unchanged.
  const skippedNames = summary.skippedNames ?? [];
  if (skippedNames.length > 0) {
    for (const entry of skippedNames) {
      console.log(
        `TEST_FILE_SKIPPED name=${JSON.stringify(entry.name)} file=${JSON.stringify(entry.file)} ` +
          '— COLLECTED, NOT RUN: this assertion produced no evidence in this run',
      );
    }
  } else if (typeof summary.testsSkipped === 'number' && summary.testsSkipped > 0) {
    // Counted but unnamed: the caller chose their own reporting, so no report was injected to
    // read titles from. Say that rather than printing only a number, which is the exact signal
    // the incident proved is too quiet to notice.
    console.log(
      `TEST_FILE_SKIPPED count=${summary.testsSkipped} names=unavailable — ${summary.testsSkipped} ` +
        'test(s) were COLLECTED, NOT RUN, and their titles could not be read (the caller supplied ' +
        'its own --reporter/--outputFile, so no private json report was injected). If one of them ' +
        'is the assertion you are verifying, this run is not evidence for it.',
    );
  }
  if (requireRan) {
    const verdict = requireRanVerdict(requireRan, {
      executed: summary.executedNames ?? [],
      skipped: skippedNames,
    });
    if (verdict.status !== 'ran') {
      const detail =
        verdict.status === 'skipped'
          ? `it was COLLECTED AND SKIPPED (${verdict.matches.map((n) => JSON.stringify(n)).join(', ')})`
          : verdict.status === 'absent'
            ? 'no test with a matching full name was collected at all — check for a rename, a typo, or the wrong file'
            : 'no readable test report, so whether it ran is UNVERIFIED — not a pass';
      // Deliberately withholds TEST_FILE_RESULT, exactly as the name-filter-matched-no-tests
      // refusal above does and for the same reason: its PRESENCE is the verdict callers grep for
      // (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi`), and printing `status=passed`
      // beside a refusal would put a false green in the one line agents paste as evidence.
      console.error(
        `TEST_FILE_REQUIRE_RAN pattern=${JSON.stringify(requireRan)} status=${verdict.status} — ${detail}. ` +
          'Refusing to report this run as evidence for that assertion; the TEST_FILE_RESULT verdict ' +
          'line is withheld on purpose, so this run reads as UNMEASURED rather than green.',
      );
      // EI-21884126680256710: this returned a bare `1` — the GENUINE-RED code — while its own
      // message two lines up says the run "reads as UNMEASURED". A caller branching on the exit
      // code was therefore told the named file failed, which is precisely the misattribution the
      // withheld TEST_FILE_RESULT line exists to prevent. The prose and the exit code now agree.
      return TEST_FILE_EXIT_NOT_MEASURED;
    }
    console.log(
      `TEST_FILE_REQUIRE_RAN pattern=${JSON.stringify(requireRan)} status=ran matches=${verdict.matches.length}`,
    );
  }
  // EI-21902345477441137: a watchdog reap is NOT a test failure — a run the harness killed before
  // it produced a verdict must never be reported as `status=failed` (that blames the code under
  // test for a resource limit) nor silently fold into `status=passed`. When nothing else in this
  // request genuinely failed, withhold TEST_FILE_RESULT and refuse instead, exactly like the
  // other NOT-MEASURED refusals above (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi`).
  // A genuine failure elsewhere in the same multi-group request still reports `status=failed`
  // below, unaffected — this refusal fires only when timing out is the ONLY thing that happened.
  if (summary.anyTimedOut && !summary.anyFailed) {
    console.error(
      `TEST_FILE_NOT_MEASURED requested=${summary.requested} executed=${summary.executed} ` +
        `matched=${summary.matched} status=not-measured — a watchdog reaped at least one run before ` +
        'it finished; no test-failure verdict was produced. Widen with ' +
        'PAPERCUSP_TEST_FILE_TIMEOUT_MS=<milliseconds> and rerun the same command. Refusing to report ' +
        'a TEST_FILE_RESULT verdict for a run that was not measured.',
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
  // EI-21974750710808305: a run that COLLECTED tests and executed ZERO of them is not evidence in
  // EITHER direction, and reported as `status=passed` it becomes a FALSE GREEN in the one line
  // callers paste as proof. This is the SAME vacuity the name-filter branch above already refuses
  // (`TEST_FILE_NAME_FILTER_NO_MATCH`), arriving by a different route: an env-gated suite whose gate
  // was never set, `describe.skipIf`, `.skip`. That guard cannot simply be hoisted, because
  // `testsExecuted` is measured ONLY under a name filter (see the push site, `: undefined`), whereas
  // skipped/executed NAMES are measured on every run (EI-19380376466745152) — so they are the signal.
  //
  // MEASURED, 2026-08-30T23:54Z, /tmp/p002-omp-d052.log — the P-002 real-backend acceptance matrix
  // ran with `PAPERCUSP_REAL_BACKEND_MATRIX` unset, skipped all 14 of its tests, printed 14
  // `TEST_FILE_SKIPPED name=` lines, and still emitted `status=passed ... skippedTests=14` with exit
  // 0. Its runner read that verdict line and recorded `STOP reason=green attempts_used=1` for an
  // acceptance leg that never executed a single test. The 14 advisory lines did not stop it:
  // advisory output does not beat the verdict line, which is exactly why this refusal is not one.
  //
  // Three-state-safe by construction: it fires only on POSITIVE evidence from a readable report —
  // names of tests that were collected-and-skipped, with no executed names beside them. When no
  // report was readable BOTH name lists are empty, so an unreadable run can never be turned into a
  // fabricated refusal; it keeps its existing behaviour. A genuine failure anywhere in the request
  // still reports `status=failed` below, and a partially-skipped run is untouched.
  const allSkipped = allSkippedVerdict(summary);
  if (allSkipped.vacuous) {
    console.error(
      `TEST_FILE_ALL_SKIPPED requested=${summary.requested} executed=${summary.executed} ` +
        `matched=${summary.matched} testsExecuted=0 testsSkipped=${summary.testsSkipped} ` +
        `status=not-measured reason=${allSkipped.reason} — this run executed NO tests, ` +
        'so it is not evidence that anything passed. Find the gate that skipped them (an unset env ' +
        'flag, `describe.skipIf`, `.skip`) and rerun. Refusing to report a TEST_FILE_RESULT verdict ' +
        'for a run that measured nothing.',
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
  const status = summary.anyFailed ? 'failed' : 'passed';
  const skippedField =
    typeof summary.testsSkipped === 'number' && summary.skippedUnmeasuredGroups === 0
      ? String(summary.testsSkipped)
      : 'unknown';
  console.log(
    `TEST_FILE_RESULT requested=${summary.requested} executed=${summary.executed} matched=${summary.matched} ` +
      `status=${status} ${provenanceResultFields(provenanceBefore, provenanceDiff)} skippedTests=${skippedField}` +
      (summary.anyFinalizationError ? ' finalizationError=true' : ''),
  );
  if (summary.anyFinalizationError) return TEST_FILE_EXIT_FINALIZATION_ERROR;
  return summary.anyFailed ? TEST_FILE_EXIT_FAILED : TEST_FILE_EXIT_PASSED;
  } finally {
    cleanupPreemptMarkers();
    cleanupInjectedReports();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // This module is also imported through TypeScript/tsx entrypoints whose dependency graph is
  // transformed to CommonJS (for example apps/operator/scripts/lint-tests.ts). Keep the async
  // exit-code handoff without top-level await, which esbuild correctly rejects in that format.
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error);
      // A rejection here means the router itself threw: nothing was measured, so this is the
      // NOT-MEASURED code and never the genuine-red one.
      process.exitCode = TEST_FILE_EXIT_NOT_MEASURED;
    },
  );
}
