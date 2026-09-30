/**
 * testing:run — run exact test files and return a DISTILLED result.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-021 (D-021 measurement,
 * D-022 design ruling).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * D-021 measured the 7d corpus: 2,645 test-running atoms across 68 of 86 su
 * sessions. Agents already HAVE a good runner and reach for it 70.8% of the
 * time — what they lack is a RESULT. Of 2,620 test-running commands, 84.8%
 * pipe the output to `tail`/`head` (median `tail -60`), 81.7% merge `2>&1`
 * into that pipe, and 15.7% redirect to a log and grep it separately. The
 * command issued immediately after a test run is `cd` 1371x, `grep` 262x,
 * `tail` 109x. The cost this tool removes is the OUTPUT HANDLING, not the
 * execution — which is why it returns counts + per-test failures and offers
 * NO raw-output passthrough (that would re-create the `| tail -80` pipe
 * inside the tool and forfeit the entire saving).
 *
 * ── What it deliberately does NOT reimplement (D-022) ───────────────────────
 * This tool is an ASSEMBLY. `scripts/test-files.mjs` already owns owning-config
 * discovery, the zero/partial-match false-green refusal, the load-adaptive
 * worker cap, mid-install-corruption detection and Vitest-4 silent-collection
 * recovery — so we SHELL it and never re-derive routing. `distillVitestRun`
 * already owns the projection. The `admin-test-runs-reporter` already writes
 * one `harness_shared.test_runs` row per file on every local run, so this tool
 * writes NO rows; it only stamps `PAPERCUSP_TEST_RUN_GROUP=<runId>` so the
 * reporter correlates the run's rows and `testing:flakiness` can find them.
 *
 * ⚠ "one row per file" describes the row GRANULARITY, NOT the write TIMING.
 * The live reporter (libs/test-config/src/admin-test-runs-reporter.ts) QUEUES
 * each row in memory at `onTestModuleEnd` and performs its ONLY write in
 * `flushPending()`, called from `onTestRunEnd`/`onExit` — because `worktree_dirty`
 * and `commit_sha` are whole-RUN facts derived from a before/after git snapshot
 * that does not exist at file-completion time (D-007: "missing proof of stability
 * is dirty, never a false clean"). Consequence: a run killed mid-flight (batch
 * watchdog, SIGKILL) writes NOTHING — every already-computed per-file result is
 * lost, and leaves no trace (zero `cancelled`/`running` rows in 7 days / 459k rows).
 * Measured on real run-groups: per-file completions span up to ~24s while every
 * row is inserted within ~10ms of the others, ~1s after the last file (EI-20343103917336944).
 * ⛔ Do NOT reason about this ledger from
 * `packages/operator-core/test/reporters/admin-test-runs-reporter.ts` — that copy
 * DOES insert per-file, but it is wired to no vitest config and is a superseded
 * fossil; `defineVitestConfig` auto-wires the libs/test-config one.
 *
 * ── The correctness argument ────────────────────────────────────────────────
 * 372 raw-`vitest run` commands appear in the corpus across 44 sessions, 107 of
 * them with no `cd` — i.e. root-level `vitest run <path>`, exactly the
 * zero/partial-match false-green the router exists to refuse (a run that
 * silently executes NOTHING and exits 0). ~14% of all test invocations opt out
 * of that guard. Because this tool can only ever go through the router, that
 * bypass is not expressible here.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Exact FILES only — 82% of the measured family ("run these exact file(s)",
 * 69.5% via the router + 12.3% via raw vitest). `test:affected` (7.9%) is NOT
 * covered: `scripts/affected-tests.mjs` runs each workspace's own `npm test`
 * and has no vitest-arg passthrough, so a JSON reporter cannot be plumbed
 * through it without real work. Keep using `npm run test:affected` for that.
 */

import { z } from 'zod';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import {
  boundTestRunPayload,
  captureWorktreeSnapshot,
  computeWorktreeDirty,
  distillVitestRun,
  mergeDistilledRuns,
  parseFailureDetailsSidecar,
  parseVitestJsonForHarnessRows,
  persistHarnessTestRuns,
  readHarnessTestRunEvidence,
  TESTING_RUN_MAX_PAYLOAD_BYTES,
  startRun,
  startRunDurable,
  type DistilledTestRun,
  type HarnessTestRunEvidence,
  type HarnessTestRunIdQuery,
  type SpawnRequest,
} from '../../testing-run-store';
import { deriveAffectedPlan } from './affected-plan';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { harnessArg, resolveConcreteHarnessSlug } from '../_harness-scope';
import { REPO_ROOT } from '../docs/_repo-paths';
import { selectUnambiguousEvidenceRoot } from '../../evidence-root-selection';
import { withBoundedTimeout, type BoundedTimeoutResult } from '../../bounded-timeout';
import {
  FOREGROUND_TERMINATION_GRACE_MS,
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundClampDisclosure,
} from '../capability/foreground-transport-cap';
import { ensurePapercuspTmpdir } from '@papercusp/test-config/tmpdir-guard';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { managedSpawn, type ManagedSpawnResult } from '../../task-manager/managed-spawn';
import { killScopeUnit, type ScopeControlOutcome } from '../../task-manager/control';
import { mutationProbeRefusal } from './mutation-probe-fence';
import {
  absCgroupDir,
  nodeCgroupFs,
  readProcessCgroupPath,
  sampleCgroup,
  walkCgroupTree,
  type CgroupFs,
} from '../../task-manager/cgroup-read';
import { deriveUserManagerRoot, scopeCgroupRelPath } from '../../task-manager/types';
import { isShuttingDown } from '../../shutdown-state';
import {
  admissionContextFromEnvironment,
  governedExecutionLeaseTtlForTimeout,
  runGovernedOperation,
  type GovernedExecutionSettlement,
} from '../../resource-governor/execution';
import type { ResourceDemand } from '../../resource-governor/admission';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveBashTaskProvenance } from '../capability/bash-task-provenance';
import { loopLaunchRefusal } from '../../verification-attempts/loop-gate';
import {
  prepareTestEvidence,
  finishTestEvidence,
  deferredTestEvidenceRecoveryBundle,
  recoverTestEvidence,
  testEvidenceSchema,
  recoverTestEvidenceSchema,
  remeasureTestEvidenceSchema,
  buildTestEvidenceRemeasure,
  retireRemeasuredPredecessors,
  retractRefusedTestEvidence,
  RECOVERY_WAIT_DEFAULT_MS,
} from './evidence';

/**
 * Core refusals returned before any test process is started. A run refused this way
 * measured nothing, so evidence it prepared is retracted rather than finished
 * (EI-24100872054224181).
 */
const PRE_LAUNCH_REFUSALS: ReadonlySet<string> = new Set([
  'invalid_root', 'ambiguous_workspace_path', 'mutation_probe_active', 'mutation_probe_state_unknown',
]);

/** Hard ceiling on a single run, so a wedged suite can never hold a turn open
 *  indefinitely. 21% of corpus commands already hand-wrapped a `timeout`; this
 *  makes that budget the tool's own rather than something each agent re-picks. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
// The foreground transport yields below 55s, but measured integration work took 227s
// before an adjacent unit group and startup. Give detached recovery the full bounded window.
const DETACHED_RECOVERY_TIMEOUT_MS = MAX_TIMEOUT_MS;
const ADMIN_TEST_RUNS_REPORTER_RELATIVE_PATH = 'libs/test-config/src/admin-test-runs-reporter.ts';
const TEST_FAILURE_DETAILS_FILENAME = 'failure-details.json';

/**
 * A managed Papercusp checkout owns a Vitest reporter that records its run.
 * An independent sibling checkout generally does not; in that case the
 * operator must ingest the JSON report itself after the child exits. Loading
 * Papercusp's TypeScript reporter into the foreign Vitest process is not a
 * reliable fallback: its package resolution and fail-soft database connection
 * both belong to a different checkout.
 */
export function shouldIngestVitestLedgerInProcess(testRoot: string): boolean {
  return resolveAdminTestRunsReporterPath(testRoot) === undefined;
}

/** Resolve the reporter from the checkout that will run Vitest, with a source-tree fallback. */
export function resolveAdminTestRunsReporterPath(testRoot: string): string | undefined {
  try {
    const resolved = createRequire(join(testRoot, 'package.json')).resolve(
      '@papercusp/test-config/admin-test-runs-reporter',
    );
    if (existsSync(resolved)) return resolved;
  } catch {
    // External checkouts may not install @papercusp/test-config; use their local source tree if present.
  }
  const fallback = join(testRoot, ADMIN_TEST_RUNS_REPORTER_RELATIVE_PATH);
  return existsSync(fallback) ? fallback : undefined;
}

const DETACHED_INSPECT_TEST_HINT =
  "For one test file, re-run it detached with capability:inspect { check: 'test', package: '<owning workspace>', path: '<test file>', run_in_background: true }, then poll capability:bash_output. " +
  'capability:inspect accepts one test path per call; split a multi-file run into one detached call per file, and do not pass the file array as onlyPaths (that field is typecheck-only). If this run returns a detachedRunId, poll it with testing:run-status { runId }. ';

const DETACHED_ROUTER_TEST_HINT =
  "For integration test files, re-run detached with capability:bash { command: 'npm run test:file -- <test path>', run_in_background: true }, then poll capability:bash_output. " +
  'The test:file router selects the owning Vitest config; run one file per detached call when needed. If this run returns a detachedRunId, poll it with testing:run-status { runId }. ';

function detachedRunStatusHint(runId: string): string {
  return `started detached recovery run ${runId}; poll it with testing:run-status { runId: '${runId}' }. `;
}

/**
 * A detached run whose initial snapshot was not confirmed within the response
 * budget may be visible only on its owner worker until a later snapshot write
 * succeeds. Avoid promising that status will be available immediately.
 */
function detachedRunUndurableHint(runId: string): string {
  return (
    `started detached recovery run ${runId}, but its initial durable snapshot was NOT confirmed before the response deadline. ` +
    `testing:run-status { runId: '${runId}' } may answer unknown_run if no shared snapshot is available — which is NOT evidence the tests passed. ` +
    'Prefer the detached fallback below. '
  );
}

function detachedRecoveryRuntimeMaxSec(timeoutMs?: number): number {
  return Math.max(1, Math.ceil(Math.max(timeoutMs ?? 0, DETACHED_RECOVERY_TIMEOUT_MS) / 1_000));
}

/**
 * Compose the recovery sentence for a timed-out foreground run. Exported so the
 * durability gate is guarded directly: the promise we make about
 * testing:run-status must track whether the snapshot actually persisted.
 */
export function detachedRecoveryHint(opts: { runId?: string | undefined; durable: boolean }): string {
  if (!opts.runId) return '';
  return opts.durable ? detachedRunStatusHint(opts.runId) : detachedRunUndurableHint(opts.runId);
}

/**
 * Choose the timeout recovery that can actually run the timed-out file.
 *
 * `capability:inspect check:"test"` intentionally launches the package's default
 * `npx vitest` config. That config excludes `*.integration.test.*`, so prescribing
 * it for an integration timeout deterministically fails before the suite starts.
 * The repository's `npm run test:file` router is the owning-config surface for
 * integration files and must be the recovery path instead.
 */
export function detachedTestTimeoutHint(files: string[]): string {
  const hasIntegrationFile = files.some((file) => /\.integration\.test\.[cm]?[jt]sx?$/i.test(file));
  return hasIntegrationFile ? DETACHED_ROUTER_TEST_HINT : DETACHED_INSPECT_TEST_HINT;
}

/**
 * Disclose the effective foreground clamp only when the caller supplied a budget.
 * The default budget is an implementation choice, not a caller-authored deadline,
 * so reporting it as "requested" would be misleading.
 */
export function testingRunTimeoutClampDisclosure(
  requestedTimeoutMs: number | undefined,
  effectiveTimeoutMs: number,
): string {
  return requestedTimeoutMs === undefined ? '' : foregroundClampDisclosure(requestedTimeoutMs, effectiveTimeoutMs);
}

/**
 * Build the store-backed recovery command for a Papercusp checkout. The
 * foreground run's JSON report lives in a private temporary directory that is
 * removed as soon as the bounded call returns; a detached run therefore gets
 * no report path from that run. Its store snapshot is the durable/pollable
 * result surface, while the router remains the source of truth for owning
 * config discovery and zero-match refusal.
 */
export function buildDetachedTestRunRequest(opts: {
  root: string;
  files: string[];
  testNamePattern?: string;
  workspaceId?: string;
  harnessSlug?: string;
  timeoutMs?: number;
  /** expensive-verification-loops P-001: the work-item this run verifies, stamped on
   *  the task-ledger row so a long detached run counts as an attempt against it. */
  workItemId?: string;
}): SpawnRequest {
  // An explicit Vitest reporter replaces the reporters declared by the workspace config.
  // The admin reporter normally writes durable testRunIds directly. A single integration
  // test is different: its suite can mock @papercusp/db-org, which also redirects the
  // reporter's connection into the disposable test database. The foreground runner already
  // avoids that trap by ingesting a JSON report in the parent operator. Preserve the same
  // boundary for the documented one-integration-file detached recovery path: write one JSON
  // artifact and let testing-run-store ingest it after the child closes.
  const adminReporterPath = resolveAdminTestRunsReporterPath(opts.root);
  const parentIngestsIntegration =
    opts.files.length === 1 && /\.integration\.test\.[cm]?[jt]sx?$/i.test(opts.files[0]!);
  const reportPath = parentIngestsIntegration
    ? join(ensurePapercuspTmpdir() ?? tmpdir(), `papercusp-testing-run-detached-${randomUUID()}.json`)
    : null;
  const vitestArgs = [
    ...(reportPath
      ? ['--reporter=json', `--outputFile=${reportPath}`]
      : adminReporterPath
        ? [`--reporter=${adminReporterPath}`]
        : []),
    ...(opts.testNamePattern ? [`--testNamePattern=${opts.testNamePattern}`] : []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...(opts.harnessSlug && opts.harnessSlug !== '*' ? { PAPERCUSP_TEST_RUN_HARNESS: opts.harnessSlug } : {}),
    ...(opts.workspaceId && opts.workspaceId !== '*' ? { PAPERCUSP_WORKSPACE_ID: opts.workspaceId } : {}),
  };
  return {
    kind: 'vitest',
    label: `testing:run timeout recovery (${opts.files.join(', ')})`,
    filePath: opts.files.length === 1 ? opts.files[0] : undefined,
    command: process.execPath,
    args: [join(opts.root, 'scripts', 'test-files.mjs'), ...opts.files, '--', ...vitestArgs],
    cwd: opts.root,
    ...(reportPath
      ? {
          detachedReportArtifacts: [
            {
              reportPath,
              root: opts.root,
              testNamePattern: opts.testNamePattern ?? null,
              ...(opts.harnessSlug && opts.harnessSlug !== '*' && opts.workspaceId && opts.workspaceId !== '*'
                ? { scope: { harnessSlug: opts.harnessSlug, workspaceId: opts.workspaceId } }
                : {}),
            },
          ],
        }
      : {}),
    runtimeMaxSec: detachedRecoveryRuntimeMaxSec(opts.timeoutMs),
    ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * Build one durable recovery process for a request spanning independent checkouts.
 *
 * A normal recovery request has one checkout root, so its detached store process
 * can invoke that root's router directly. A mixed-root request needs one
 * pollable lifecycle while still invoking each checkout's own runner. Keep the
 * orchestration in the detached child: its inherited PAPERCUSP_TEST_RUN_GROUP
 * gives every checkout's reporter one durable run-group id, and its process
 * status becomes the whole operation's terminal status. Every command is
 * attempted even when an earlier checkout exits non-zero.
 */
export function buildDetachedMixedTestRunRequest(opts: {
  groups: TestFileCheckoutGroup[];
  testNamePattern?: string;
  workspaceId?: string;
  harnessSlug?: string;
  timeoutMs?: number;
  /** expensive-verification-loops P-001: the work-item this run verifies, stamped on
   *  the task-ledger row so a long detached run counts as an attempt against it. */
  workItemId?: string;
}): SpawnRequest {
  const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
  const detachedReportArtifacts: NonNullable<SpawnRequest['detachedReportArtifacts']> = [];
  const reportPathFor = (root: string): string => {
    // Reporter-less external checkouts need a machine-readable report after
    // this function returns and the detached child outlives the foreground
    // call. Keep each report in the shared, guarded tmp root and use one
    // collision-free file per child command; the store removes it at close.
    const tmpRoot = ensurePapercuspTmpdir() ?? tmpdir();
    const reportPath = join(tmpRoot, `papercusp-testing-run-detached-${randomUUID()}.json`);
    detachedReportArtifacts.push({
      reportPath,
      root,
      testNamePattern: opts.testNamePattern ?? null,
      ...(opts.harnessSlug && opts.harnessSlug !== '*' && opts.workspaceId && opts.workspaceId !== '*'
        ? { scope: { harnessSlug: opts.harnessSlug, workspaceId: opts.workspaceId } }
        : {}),
    });
    return reportPath;
  };
  for (const group of opts.groups) {
    const adminReporterPath = resolveAdminTestRunsReporterPath(group.root);
    const vitestArgs = [
      ...(adminReporterPath ? [`--reporter=${adminReporterPath}`] : []),
      ...(opts.testNamePattern ? [`--testNamePattern=${opts.testNamePattern}`] : []),
    ];
    if (existsSync(join(group.root, 'scripts', 'test-files.mjs'))) {
      commands.push({
        command: process.execPath,
        args: [
          join(group.root, 'scripts', 'test-files.mjs'),
          ...group.files,
          '--',
          ...(adminReporterPath
            ? vitestArgs
            : ['--reporter=json', `--outputFile=${reportPathFor(group.root)}`, ...vitestArgs]),
        ],
        cwd: group.root,
      });
      continue;
    }
    for (const route of groupDirectVitestRoutes(group.files, group.root)) {
      // A checkout can split into several direct routes (for example a unit
      // file and an integration file with different Vitest configs). Vitest
      // replaces --outputFile on each invocation, so each child needs its own
      // artifact or the last route erases earlier ledger rows.
      const routeVitestArgs = adminReporterPath
        ? vitestArgs
        : ['--reporter=json', `--outputFile=${reportPathFor(group.root)}`, ...vitestArgs];
      commands.push({
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: [
          '--no-install',
          'vitest',
          'run',
          ...(route.config ? ['--config', route.config] : []),
          ...routeVitestArgs,
          ...route.files,
        ],
        cwd: route.cwd,
      });
    }
  }

  const script = [
    "const { spawnSync } = require('node:child_process');",
    'const commands = ' + JSON.stringify(commands) + ';',
    'let exitCode = 0;',
    'for (const entry of commands) {',
    "  const result = spawnSync(entry.command, entry.args, { cwd: entry.cwd, stdio: 'inherit' });",
    '  if (result.error || result.status === null) { exitCode ||= 2; } else if (result.status !== 0) { exitCode ||= result.status; }',
    '}',
    'process.exitCode = exitCode;',
  ].join('\n');
  const root = opts.groups[0]?.root ?? resolveAgentWorkspaceRoot({});
  const env: NodeJS.ProcessEnv = {
    ...(opts.harnessSlug && opts.harnessSlug !== '*' ? { PAPERCUSP_TEST_RUN_HARNESS: opts.harnessSlug } : {}),
    ...(opts.workspaceId && opts.workspaceId !== '*' ? { PAPERCUSP_WORKSPACE_ID: opts.workspaceId } : {}),
  };
  return {
    kind: 'vitest',
    label: 'testing:run mixed-root timeout recovery (' + opts.groups.flatMap((group) => group.files).join(', ') + ')',
    command: process.execPath,
    args: ['-e', script],
    cwd: root,
    ...(detachedReportArtifacts.length > 0 ? { detachedReportArtifacts } : {}),
    // A detached continuation is a fresh operation, not the expired foreground
    // remainder. It gets the full bounded test window, including mixed-root suites.
    runtimeMaxSec: detachedRecoveryRuntimeMaxSec(opts.timeoutMs),
    ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

type TestFilePathResolution = { ok: true; files: string[] } | { ok: false; path: string; matches: string[] };

/**
 * Expand the root package's declared workspace directories. The repository's root workspace
 * patterns are either concrete directories or one-level trailing `/*` globs; keeping this
 * discovery local avoids importing a task runner that would execute work at module load time.
 */
function declaredWorkspaceDirs(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    const dirs = new Set<string>();
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern) continue;
      const normalized = pattern.replace(/\\/g, '/');
      if (normalized.endsWith('/*') && !normalized.slice(0, -2).includes('*')) {
        const base = normalized.slice(0, -2);
        const baseDir = join(root, base);
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(baseDir, entry.name, 'package.json'))) {
            dirs.add(`${base}/${entry.name}`);
          }
        }
        continue;
      }
      if (!normalized.includes('*') && existsSync(join(root, normalized, 'package.json'))) {
        dirs.add(normalized);
      }
    }
    return [...dirs];
  } catch {
    return [];
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * A checkout that can own an absolute test path without relying on Papercusp's
 * router. This requires superproject markers, then accepts either a Vitest
 * config or an installed Vitest binary for the generic runner.
 */
function isWorkspaceCheckoutRoot(root: string): boolean {
  try {
    const git = statSync(join(root, '.git'));
    if (!git.isDirectory() && !git.isFile()) return false;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    return Array.isArray(pkg.workspaces) || Array.isArray(pkg.workspaces?.packages);
  } catch {
    return false;
  }
}

/**
 * Discover independent workspace checkouts sitting beside the requested repo.
 *
 * A structured rubric check is stored as a portable workspace-relative path such
 * as `portal/tests/foo.test.ts`, but the test router must execute it from the
 * `portal` checkout itself.  The plan-audit citation resolver already admits
 * these sibling repositories; keep testing:run on the same admission rule rather
 * than rejecting a real, tracked test merely because it is outside the ambient
 * checkout.  Only direct children with a real `.git` directory and a workspace
 * package are admitted, so release/checkpoint worktrees and arbitrary folders do
 * not become execution roots.
 */
function independentWorkspaceCheckoutRoots(root: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // A stale requested root is handled by the normal resolver; keep the literal
    // path here so a sibling can still be discovered from its parent.
  }
  const parent = dirname(resolve(root));
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = join(parent, entry.name);
    try {
      if (realpathSync(candidate) === realRoot) continue;
      // A pointer-file `.git` identifies a release/checkpoint worktree, not an
      // independent checkout that may supply rubric evidence or run tests.
      if (!statSync(join(candidate, '.git')).isDirectory()) continue;
      if (!isWorkspaceCheckoutRoot(candidate)) continue;
      names.set(entry.name, realpathSync(candidate));
    } catch {
      // Broken symlink / disappearing checkout: leave it out of this snapshot.
    }
  }
  return names;
}

function isVitestCheckoutRoot(root: string): boolean {
  if (!isWorkspaceCheckoutRoot(root)) return false;
  return (
    [
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.config.cts',
      'vitest.config.js',
      'vitest.config.mjs',
      'vitest.config.cjs',
    ].some((name) => existsSync(join(root, name))) || existsSync(join(root, 'node_modules', '.bin', 'vitest'))
  );
}

/** Find the owning superproject for an absolute path, bounded to its ancestors. */
export function checkoutRootForPath(file: string): string | undefined {
  if (!isAbsolute(file)) return undefined;
  let dir = dirname(resolve(file));
  for (let depth = 0; depth < 64; depth += 1) {
    if (isWorkspaceCheckoutRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Select one checkout for a test request. Relative paths retain the caller's
 * ambient tree. Absolute paths switch only when every path resolves to the same
 * discovered checkout; mixed roots stay on the ambient tree and fail loudly
 * through the normal path checks instead of silently combining trees.
 */
export function checkoutRootForTestFiles(files: string[], ambientRoot: string): string {
  const absoluteFiles = files.filter((file) => isAbsolute(file));
  if (absoluteFiles.length === 0) return ambientRoot;
  // A mixed relative + absolute request still contains files owned by the
  // ambient checkout. Looking only at the absolute subset used to switch the
  // WHOLE batch to a sibling checkout, where the relative files were silently
  // omitted. Mixed roots are partitioned by runTestFilesCore below; this
  // selector may switch only when every requested file belongs to the same
  // absolute checkout, matching the contract stated above.
  if (absoluteFiles.length !== files.length) return ambientRoot;
  const roots = absoluteFiles.map(checkoutRootForPath);
  if (roots.some((root): root is undefined => root === undefined)) return ambientRoot;
  const unique = [...new Set(roots as string[])];
  return unique.length === 1 ? unique[0]! : ambientRoot;
}

export interface TestFileCheckoutGroup {
  root: string;
  files: string[];
}

/** Partition one normalized request at the checkout boundary. */
export function groupTestFilesByCheckout(files: string[], ambientRoot: string): TestFileCheckoutGroup[] {
  const ambient = resolve(ambientRoot);
  const groups = new Map<string, TestFileCheckoutGroup>();
  for (const file of files) {
    const discovered = isAbsolute(file) ? checkoutRootForPath(file) : undefined;
    const root = resolve(discovered ?? ambient);
    const group = groups.get(root) ?? { root, files: [] };
    group.files.push(file);
    groups.set(root, group);
  }
  return [...groups.values()];
}

/** Rebase sibling-relative evidence before merging it into the ambient result. */
function rebaseDistilledRunToAmbient(run: DistilledTestRun, groupRoot: string, ambientRoot: string): DistilledTestRun {
  if (resolve(groupRoot) === resolve(ambientRoot)) return run;
  const rebase = (file: string) => (isAbsolute(file) ? resolve(file) : resolve(groupRoot, file));
  return {
    ...run,
    failures: run.failures.map((failure) => ({ ...failure, file: rebase(failure.file) })),
    byFile: Object.fromEntries(Object.entries(run.byFile).map(([file, counts]) => [rebase(file), counts])),
  };
}

/**
 * Discover real Hive checkouts in the canonical and scoped Papercus homes.
 * The optional parent list keeps this focused-testable while production follows
 * the same ordering as the Hive seed routine.
 */
export function discoverKnownHiveCheckoutRoots(
  hiveParents: string[] = [
    join(homedir(), '.papercusp', 'hives'),
    ...(process.env.PAPERCUSP_HOME?.trim() ? [join(process.env.PAPERCUSP_HOME.trim(), 'hives')] : []),
  ],
): string[] {
  const roots = new Set<string>();
  for (const parent of hiveParents) {
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const root = join(parent, entry.name);
        if (isWorkspaceCheckoutRoot(root)) roots.add(root);
      }
    } catch {
      continue;
    }
  }
  return [...roots];
}

export type TestFileRootSource = 'requested' | 'absolute-file-checkout' | 'hive-checkout' | 'canonical-repo';

export interface SelectedTestFileRoot {
  root: string;
  source: TestFileRootSource;
}

function testFilesResolveAtRoot(files: string[], root: string): boolean {
  const hasRouter = existsSync(join(root, 'scripts', 'test-files.mjs'));
  if (!hasRouter && !isVitestCheckoutRoot(root)) return false;
  const resolution = normalizeTestFilePaths(files, root);
  if (!resolution.ok) return false;
  return resolution.files.every((file) => {
    if (isAbsolute(file)) return existsSync(file);
    const candidate = resolve(root, file);
    return isInsideRoot(root, candidate) && existsSync(candidate);
  });
}

/**
 * WI-41400 — select the direct testing:run handler's tree before the core's loud
 * invalid-root pre-flight. A valid requested checkout stays authoritative. A stale
 * phantom root may fall back to exactly one discovered Hive checkout, then to the
 * canonical repo only when there was no discovered match. Ambiguity preserves the
 * requested root so the core refuses loudly instead of choosing an arbitrary tree.
 */
export function selectTestFileRoot(
  files: string[],
  requested: string,
  opts: {
    discoveredRoots?: readonly string[];
    canonicalRepoRoot?: string;
  } = {},
): SelectedTestFileRoot {
  const preferredRoot = checkoutRootForTestFiles(files, requested);
  const preferredSource: TestFileRootSource =
    resolve(preferredRoot) === resolve(requested) ? 'requested' : 'absolute-file-checkout';
  const selected = selectUnambiguousEvidenceRoot<TestFileRootSource>({
    preferred: { root: preferredRoot, source: preferredSource },
    candidates: (opts.discoveredRoots ?? discoverKnownHiveCheckoutRoots()).map((root) => ({
      root,
      source: 'hive-checkout',
    })),
    fallback: { root: opts.canonicalRepoRoot ?? REPO_ROOT, source: 'canonical-repo' },
    resolvesEvery: (root) => testFilesResolveAtRoot(files, root),
  });
  return selected ?? { root: preferredRoot, source: preferredSource };
}

/**
 * Accept the two path vocabularies exposed by the release pipeline:
 * repo-root-relative paths (the router's native contract) and paths relative to exactly one
 * declared npm workspace (the gate's `{ workspace, file }` contract). A workspace-relative
 * spelling is expanded only when the file exists in one workspace; multiple matches are refused
 * before any test process starts so a caller cannot verify an unintended file.
 */
export function normalizeTestFilePaths(
  files: string[],
  root: string,
  workspaceDirs: string[] = declaredWorkspaceDirs(root),
): TestFilePathResolution {
  const normalized: string[] = [];
  const siblings = independentWorkspaceCheckoutRoots(root);
  for (const file of files) {
    if (isAbsolute(file)) {
      normalized.push(file);
      continue;
    }

    const rootCandidate = resolve(root, file);
    if (isInsideRoot(root, rootCandidate) && existsSync(rootCandidate)) {
      normalized.push(file);
      continue;
    }

    const matches = workspaceDirs
      .map((dir) => resolve(root, dir, file))
      .filter((candidate) => isInsideRoot(root, candidate) && existsSync(candidate))
      .map((candidate) => relative(root, candidate).split(sep).join('/'));
    if (matches.length > 1) return { ok: false, path: file, matches };
    if (matches.length === 1) {
      normalized.push(matches[0]!);
      continue;
    }

    // Workspace-relative sibling checkout spelling (`portal/tests/foo.test.ts`).
    // Return the absolute file so checkoutRootForTestFiles can hand the complete
    // request to that repository's own router/config.  Keep the original spelling
    // only when no admitted sibling contains it.
    const first = file.replace(/\\/g, '/').split('/')[0];
    const siblingRoot = first ? siblings.get(first) : undefined;
    if (siblingRoot && file.length > first!.length + 1) {
      const siblingCandidate = resolve(siblingRoot, file.slice(first!.length + 1));
      if (isInsideRoot(siblingRoot, siblingCandidate) && existsSync(siblingCandidate)) {
        normalized.push(siblingCandidate);
        continue;
      }
    }
    normalized.push(file);
  }
  return { ok: true, files: normalized };
}

/**
 * Router exit codes. The contract is stated once in
 * `scripts/lib/test-file-exit-codes.mjs` and pinned by
 * `packages/operator-core/lib/__tests__/test-file-exit-codes.test.ts`:
 * 0 = measured pass, 1 = MEASURED and genuinely failed, 2 = NOT MEASURED
 * (route/launch/admission error, watchdog reap, or a refused false-green),
 * 75 = EX_TEMPFAIL, also not measured and explicitly retryable.
 *
 * This comment used to read "1 = a refused false-green OR a genuine test
 * failure", which was an accurate description of a broken router: four
 * refusals that measured NOTHING returned the same code as a real red, so this
 * consumer could not tell them apart and neither could an agent reading a log.
 * EI-21884126680256710 moved those refusals onto 2, which is what makes the
 * single-meaning reading above true. The literal stays local rather than
 * imported so operator-core's bundle does not take a dependency on `scripts/`;
 * the pin test is what keeps the two copies honest.
 */
const ROUTER_EXIT_ROUTE_ERROR = 2;

export type RouterNotMeasuredReason = 'admission-starved' | 'undetermined' | 'router-watchdog';

export interface RouterNotMeasuredMarker {
  requested: number;
  executed: number;
  matched: number;
  /** Admission knows zero files ran; a watchdog may have partial evidence. */
  measuredFiles?: 0;
  status: 'not-measured';
  reason: RouterNotMeasuredReason;
}

/** Resource reservation made for one resident router/Vitest process. */
export const TEST_PROCESS_DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;
export const TEST_PROCESS_DEFAULT_DISK_BYTES = 256 * 1024 * 1024;
export const TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS = 16;
export const TEST_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = 250;

export interface TestProcessAdmissionDemandOptions {
  /** Number of exact files in this process' group. */
  readonly fileCount?: number;
  /** Allow a caller with a measured workspace profile to tighten the estimate. */
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
  readonly fileDescriptors?: number;
}

/**
 * Build the planned resource vector for a test process. The vector is a
 * reservation (not a host-wide semaphore): it gives the durable governor a
 * useful shape while the close path records the measured peak. Keep the
 * process/fd overhead explicit because a Vitest run includes the router,
 * worker pool, report files, and pipes in addition to the named test file.
 */
export function buildTestProcessDemand(options: TestProcessAdmissionDemandOptions = {}): ResourceDemand {
  const fileCount = Number.isFinite(options.fileCount) ? Math.max(1, Math.floor(options.fileCount!)) : 1;
  const memoryBytes =
    Number.isFinite(options.memoryBytes) && options.memoryBytes! > 0
      ? Math.floor(options.memoryBytes!)
      : TEST_PROCESS_DEFAULT_MEMORY_BYTES;
  const diskBytes =
    Number.isFinite(options.diskBytes) && options.diskBytes! > 0
      ? Math.floor(options.diskBytes!)
      : TEST_PROCESS_DEFAULT_DISK_BYTES;
  const fileDescriptors =
    Number.isFinite(options.fileDescriptors) && options.fileDescriptors! > 0
      ? Math.floor(options.fileDescriptors!)
      : TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + fileCount;
  return {
    // CPU weight is relative residency, so one router/Vitest process reserves
    // one unit regardless of how many exact files it batches.
    cpuWeight: 1,
    memoryBytes,
    diskBytes,
    fileDescriptors,
  };
}

export interface TestProcessResourceSnapshot {
  /** Aggregate user+system CPU time for the process tree, in microseconds. */
  readonly cpuMicros: number | null;
  /** Aggregate resident working set for the process tree, in bytes. */
  readonly rssBytes: number | null;
  /** Aggregate open descriptors for the process tree. */
  readonly fileDescriptors: number | null;
}

function parseProcField(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s*(?:kB)?$`, 'm').exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

async function procStatus(pid: number): Promise<{ rssBytes: number | null } | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const rssKb = parseProcField(text, 'VmHWM') ?? parseProcField(text, 'VmRSS');
    return { rssBytes: rssKb === null ? null : rssKb * 1024 };
  } catch {
    return null;
  }
}

async function procCpuMicros(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = text.lastIndexOf(')');
    if (endOfCommand < 0) return null;
    const fields = text
      .slice(endOfCommand + 2)
      .trim()
      .split(/\s+/);
    // After the comm/state fields, procfs exposes utime at index 11 and stime
    // at index 12. Linux's user HZ is normally 100; retain the raw tick scale
    // if a non-standard value cannot be discovered, since the sampler only
    // uses deltas to derive a relative cpuWeight.
    const user = Number(fields[11]);
    const system = Number(fields[12]);
    if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
    return (user + system) * 10_000;
  } catch {
    return null;
  }
}

async function procChildren(pid: number): Promise<number[]> {
  try {
    const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
  } catch {
    return [];
  }
}

async function processTreePids(rootPid: number): Promise<number[]> {
  if (process.platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 0) return [rootPid];
  const result = [rootPid];
  for (let index = 0; index < result.length; index += 1) {
    const descendants = await procChildren(result[index]);
    for (const pid of descendants) if (!result.includes(pid)) result.push(pid);
  }
  return result;
}

async function procFileDescriptors(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    return (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    return null;
  }
}

/** Read a fail-soft aggregate snapshot for a child and its descendants. */
export async function readTestProcessResourceSnapshot(pid: number): Promise<TestProcessResourceSnapshot> {
  const pids = await processTreePids(pid);
  let cpuMicros = 0;
  let rssBytes = 0;
  let fileDescriptors = 0;
  let cpuMeasured = false;
  let rssMeasured = false;
  let fdMeasured = false;
  const snapshots = await Promise.all(
    pids.map(async (childPid) => {
      const [cpu, status, descriptors] = await Promise.all([
        procCpuMicros(childPid),
        procStatus(childPid),
        procFileDescriptors(childPid),
      ]);
      return { cpu, rssBytes: status?.rssBytes ?? null, descriptors };
    }),
  );
  for (const snapshot of snapshots) {
    if (snapshot.cpu !== null) {
      cpuMicros += snapshot.cpu;
      cpuMeasured = true;
    }
    if (snapshot.rssBytes !== null) {
      rssBytes += snapshot.rssBytes;
      rssMeasured = true;
    }
    if (snapshot.descriptors !== null) {
      fileDescriptors += snapshot.descriptors;
      fdMeasured = true;
    }
  }
  return {
    cpuMicros: cpuMeasured ? cpuMicros : null,
    rssBytes: rssMeasured ? rssBytes : null,
    fileDescriptors: fdMeasured ? fileDescriptors : null,
  };
}

export interface TestProcessDemandSampler {
  attach(pid: number | null | undefined): void;
  sample(): Promise<void>;
  stop(extra?: Partial<ResourceDemand>): Promise<ResourceDemand>;
}

type TestProcessResourceSnapshotReader = (
  pid: number,
) => TestProcessResourceSnapshot | PromiseLike<TestProcessResourceSnapshot>;

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<T>).then === 'function';
}

/**
 * Sample a process tree while it is alive and turn its peak observations into
 * an actual demand vector. The reader is injectable so lifecycle tests can
 * prove accounting without depending on Linux procfs; production falls back
 * to the planned vector when a platform hides a metric.
 */
export function createTestProcessDemandSampler(
  planned: ResourceDemand,
  readSnapshot: TestProcessResourceSnapshotReader = readTestProcessResourceSnapshot,
  now: () => number = Date.now,
): TestProcessDemandSampler {
  let pid: number | null = null;
  let timer: ManagedHandle | null = null;
  let stopped = false;
  let peakRss: number | null = null;
  let peakFds: number | null = null;
  let firstCpu: number | null = null;
  let lastCpu: number | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let cpuWeight: number | null = null;
  let stoppedDemand: ResourceDemand | null = null;
  let sampling: Promise<void> | null = null;
  let stopPromise: Promise<ResourceDemand> | null = null;

  const applySnapshot = (snapshot: TestProcessResourceSnapshot): void => {
    const at = now();
    if (snapshot.rssBytes !== null && Number.isFinite(snapshot.rssBytes)) {
      peakRss = peakRss === null ? snapshot.rssBytes : Math.max(peakRss, snapshot.rssBytes);
    }
    if (snapshot.fileDescriptors !== null && Number.isFinite(snapshot.fileDescriptors)) {
      peakFds = peakFds === null ? snapshot.fileDescriptors : Math.max(peakFds, snapshot.fileDescriptors);
    }
    if (snapshot.cpuMicros !== null && Number.isFinite(snapshot.cpuMicros)) {
      if (firstCpu === null) {
        firstCpu = snapshot.cpuMicros;
        firstAt = at;
      }
      lastCpu = snapshot.cpuMicros;
      lastAt = at;
      if (firstAt !== null && lastAt !== null && lastAt > firstAt && firstCpu !== null && lastCpu !== null) {
        // CPU weight is CPU-seconds per wall-second, a relative residency
        // measure rather than an asserted core count.
        cpuWeight = Math.max(0.01, (lastCpu - firstCpu) / ((lastAt - firstAt) * 1_000));
      }
    }
  };

  const sample = (): Promise<void> => {
    if (stopped || pid === null) return Promise.resolve();
    if (sampling) return sampling;
    const samplePid = pid;
    let result: TestProcessResourceSnapshot | PromiseLike<TestProcessResourceSnapshot>;
    try {
      result = readSnapshot(samplePid);
    } catch {
      return Promise.resolve();
    }
    if (!isPromiseLike(result)) {
      applySnapshot(result);
      return Promise.resolve();
    }
    const inFlight = Promise.resolve(result).then(applySnapshot, () => undefined);
    let tracked: Promise<void>;
    tracked = inFlight.finally(() => {
      if (sampling === tracked) sampling = null;
    });
    sampling = tracked;
    return tracked;
  };

  return {
    attach(nextPid: number | null | undefined): void {
      if (stopped || !Number.isInteger(nextPid) || (nextPid as number) <= 0) return;
      pid = nextPid as number;
      void sample();
      // One sampler is armed per governed test process, so the timer is
      // `instanced` (each arm coexists and the inventory aggregates them into
      // one row). It is `must-sample`: procfs has no push source for a live
      // process's peak RSS/CPU, which is the actual-demand this governed
      // execution releases with.
      timer = managedSetInterval(
        'lifecycle:test-process-resource-sampler',
        TEST_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
        sample,
        { category: 'lifecycle', instanced: true, classification: 'must-sample' },
      );
    },
    sample,
    stop(extra = {}): Promise<ResourceDemand> {
      if (stoppedDemand) return Promise.resolve(stoppedDemand);
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (!stopped) await sample();
        stopped = true;
        timer?.stop();
        timer = null;
        stoppedDemand = {
          cpuWeight: extra.cpuWeight ?? cpuWeight ?? planned.cpuWeight ?? 1,
          memoryBytes: extra.memoryBytes ?? peakRss ?? planned.memoryBytes,
          diskBytes: extra.diskBytes ?? planned.diskBytes,
          fileDescriptors: extra.fileDescriptors ?? peakFds ?? planned.fileDescriptors,
        };
        return stoppedDemand;
      })();
      return stopPromise;
    },
  };
}

/** Public outcome shape used by the settlement classifier and focused tests. */
export interface TestProcessOutcome {
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** The operator released its request during host shutdown while the
   * cgroup-confined child continued under systemd ownership. */
  readonly hostShutdownDetached?: boolean;
  readonly spawnError?: string;
  readonly output: string;
  readonly actualDemand?: ResourceDemand;
}

/**
 * A process that exited with a real code did run and may have produced a
 * legitimate red test report, so release its measured residency. A timeout,
 * caller abort, spawn error, or signal-only exit has no trustworthy verdict and
 * cancels the receipt; callers surface those as timeout/aborted/route errors,
 * never as green.
 */
export function classifyTestProcessOutcome(outcome: TestProcessOutcome): GovernedExecutionSettlement {
  if (outcome.timedOut) return { kind: 'cancel', reason: 'test process timed out before a verdict was produced' };
  if (outcome.aborted) return { kind: 'cancel', reason: 'test process was aborted before a verdict was produced' };
  if (outcome.spawnError) return { kind: 'cancel', reason: `test process spawn failed: ${outcome.spawnError}` };
  if (
    /TEST_FILE_WATCHDOG|TEST_FILE_ROUTE_ERROR|worker\s+(?:exited|crash)|TasksMax|SIG(?:TERM|KILL)/i.test(outcome.output)
  ) {
    return { kind: 'cancel', reason: 'test worker/route exited without a trustworthy verdict' };
  }
  if (outcome.code === null || outcome.signal) {
    return {
      kind: 'cancel',
      reason: `test process exited without a trustworthy verdict (code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'})`,
    };
  }
  return { kind: 'release', actualDemand: outcome.actualDemand };
}

/** The distilled outcome of one runTestFilesCore invocation — either the bounded
 *  run payload (`ok` reflects the tests; counts always complete; no `error` field) or a
 *  typed refusal naming why nothing could be judged. Discriminate on `error`. */
export type TestFilesCoreResult =
  | ({ ok: boolean; runId: string; root: string; error?: undefined } & DistilledTestRun & {
        /** Explicit selector used for an evidence-bearing run, when present. */
        testNamePattern?: string;
        /** Every checkout executed for a partitioned mixed-root request. */
        roots?: string[];
        /** The router produced a complete verdict after this tool's foreground budget elapsed. */
        budgetExceeded?: boolean;
        /** The foreground budget that elapsed before the complete verdict was surfaced. */
        budgetMs?: number;
        /** Router-reported elapsed time for the completed test process, when available. */
        runElapsedMs?: number;
        failuresReturned?: number;
        failuresOmitted?: number;
        truncationNote?: string;
      })
  | {
      ok: false;
      runId: string;
      root: string;
      /** Every checkout selected for a partitioned mixed-root request. */
      roots?: string[];
      error:
        | 'invalid_root'
        | 'ambiguous_workspace_path'
        | 'mutation_probe_active'
        | 'mutation_probe_state_unknown'
        | 'aborted'
        | 'timeout'
        | 'route_error'
        | 'not_measured'
        | 'no_report'
        | 'name_filter_no_match'
        | 'all_tests_skipped';
      hint?: string;
      path?: string;
      matches?: string[];
      timeoutMs?: number;
      skipped?: number;
      files?: number;
      routerOutput?: string;
      detachedRunId?: string;
      /** Whether the detached run's durable snapshot landed before we advertised its id. */
      detachedDurable?: boolean;
      /**
       * Bounded results from checkout groups that completed before another group
       * timed out or refused. The timeout/refusal is still the overall verdict;
       * these results keep already-measured failures from disappearing.
       */
      completedGroups?: PartialCompletedTestGroup[];
      completedGroupsOmitted?: number;
      status?: 'not-measured';
      reason?: RouterNotMeasuredReason;
      requested?: number;
      executed?: number;
      matched?: number;
      measuredFiles?: 0;
    };

export type PartialCompletedTestGroup = {
  /** Checkout that owned this group's test files. */
  root: string;
  /** Exact files sent to that checkout's runner. */
  files: string[];
  filesOmitted?: number;
  /** Whether this group completed with a normal test verdict. */
  ok: boolean;
  /** Bounded distilled result for this group. */
  result: DistilledTestRun & {
    failuresReturned?: number;
    failuresOmitted?: number;
    truncationNote?: string;
  };
};

const PARTIAL_COMPLETED_GROUP_LIMIT = 4;
const PARTIAL_COMPLETED_FILE_LIMIT = 16;
const PARTIAL_COMPLETED_FAILURE_LIMIT = 5;
const PARTIAL_COMPLETED_RESULT_BYTES = 1_800;

type CompletedTestGroup = {
  group: TestFileCheckoutGroup;
  result: Extract<TestFilesCoreResult, { error?: undefined }>;
};

/**
 * Keep the useful part of groups that finished before a mixed-root error. This
 * is deliberately separate from the final merged result: the caller must see
 * which checkout produced each partial verdict, and a timed-out group must not
 * be represented as if it completed.
 */
function summarizePartialCompletedGroups(completed: readonly CompletedTestGroup[]): {
  completedGroups?: PartialCompletedTestGroup[];
  completedGroupsOmitted?: number;
} {
  if (completed.length === 0) return {};

  const retained = completed.slice(0, PARTIAL_COMPLETED_GROUP_LIMIT).map(({ group, result }) => {
    const failures = result.failures.slice(0, PARTIAL_COMPLETED_FAILURE_LIMIT);
    const compactResult: DistilledTestRun = {
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      files: result.files,
      failures,
      failuresTruncated: result.failuresTruncated || failures.length < result.failures.length,
      durationMs: result.durationMs,
      // A partial surface is diagnostic, not the authoritative full per-file
      // attribution. Keep a small bounded prefix so a large group cannot make
      // the timeout response unbounded.
      byFile: Object.fromEntries(Object.entries(result.byFile).slice(0, PARTIAL_COMPLETED_FILE_LIMIT)),
    };
    return {
      root: group.root,
      files: group.files.slice(0, PARTIAL_COMPLETED_FILE_LIMIT),
      ...(group.files.length > PARTIAL_COMPLETED_FILE_LIMIT
        ? { filesOmitted: group.files.length - PARTIAL_COMPLETED_FILE_LIMIT }
        : {}),
      ok: result.ok,
      result: boundTestRunPayload({}, compactResult, { maxBytes: PARTIAL_COMPLETED_RESULT_BYTES }),
    };
  });

  return {
    completedGroups: retained,
    ...(completed.length > retained.length ? { completedGroupsOmitted: completed.length - retained.length } : {}),
  };
}

/** Characters whose presence makes a string mean something different as a regex than as itself. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * `testNamePattern` reaches vitest as `--testNamePattern=<verbatim>`, which is a REGEX, while
 * this tool's own description tells the caller to paste a previous result's `failures[].test`
 * — a LITERAL. A literal carrying regex metacharacters does not match itself, so the exact,
 * current name of a test selects zero tests. Measured 2026-09-11: 25,606 of 86,056 unique test
 * names in operator-core carry such a character, 19,915 of them parentheses.
 *
 * The refusal itself is load-bearing and stays (EI-19425177453558152: a zero-match run measured
 * nothing yet exited 0). What was wrong was the DIAGNOSIS — "a typo or a stale name" is a
 * confident misreading when the name is exact, and "re-run without testNamePattern" prescribes
 * the whole-file rerun R-8 exists to avoid. Recovery should cost one precise call.
 *
 * Certainty is tiered, because only one tier is provable from the pattern alone: a pattern that
 * is not a valid regex CANNOT have been meant as one, so the literal reading is a fact; a valid
 * regex carrying metacharacters may be a deliberate selector, so the escaped form is offered
 * conditionally rather than asserted. Where there is no metacharacter to blame, a zero match
 * really does mean a wrong name — inventing an escaping story there would be the same
 * confident-wrong-diagnosis defect pointing the other way, so the original guidance stands.
 */
export function nameFilterNoMatchRefusal(opts: {
  pattern: string;
  skipped: number;
  files: number;
  runId: string;
  root: string;
}): {
  ok: false;
  runId: string;
  root: string;
  error: 'name_filter_no_match';
  skipped: number;
  files: number;
  hint: string;
  literalPattern?: string;
  patternIsValidRegex: boolean;
} {
  const { pattern, skipped, files, runId, root } = opts;
  const escaped = pattern.replace(REGEX_METACHARACTERS, '\\$&');
  let patternIsValidRegex = true;
  try {
    new RegExp(pattern);
  } catch {
    patternIsValidRegex = false;
  }
  const base =
    `testNamePattern ${JSON.stringify(pattern)} matched ZERO tests, so NOTHING was ` +
    `verified — this is NOT a pass (${skipped} test(s) were collected and skipped). The pattern ` +
    "matches a test's FULL name — every enclosing `describe` joined to the `it` text — as a " +
    'REGEX, not as literal text.';
  const common = {
    ok: false as const,
    runId,
    root,
    error: 'name_filter_no_match' as const,
    skipped,
    files,
    patternIsValidRegex,
  };
  if (escaped === pattern) {
    return {
      ...common,
      hint:
        `${base} It contains no regex metacharacter, so a fragment of either matches and a typo ` +
        'or a stale name matches nothing. Re-run without testNamePattern to see the real test names.',
    };
  }
  return {
    ...common,
    literalPattern: escaped,
    hint:
      `${base} ${
        patternIsValidRegex
          ? 'It contains regex metacharacters, so if you pasted a literal test name it cannot match itself.'
          : 'It is not even a valid regex, so it was certainly pasted as a literal test name.'
      } To select that exact name, re-run with this escaped pattern — one precise call, ` +
      `no need to re-run the whole file: ${escaped}`,
  };
}

/**
 * An external Vitest invocation can leave a syntactically valid but empty JSON
 * report behind when the process exits before it produces a verdict. Distilling
 * that report yields an all-zero `DistilledTestRun`; returning it as the normal
 * result shape makes `ok:false` look like an ordinary red run while omitting the
 * only useful fact: no test file was measured. Treat an empty report as the same
 * conservative refusal used when no report exists. Check each group before
 * merging so a mixed-root run cannot hide one empty group behind another group's
 * real results.
 */
export function emptyDistilledRunRefusal(opts: {
  runs: readonly DistilledTestRun[];
  runId: string;
  root: string;
  routerOutput: string;
}): Extract<TestFilesCoreResult, { error: string }> | null {
  if (!opts.runs.some((run) => run.files === 0)) return null;
  return {
    ok: false,
    runId: opts.runId,
    root: opts.root,
    error: 'no_report',
    hint:
      'Vitest exited without reporting any test files, so no test verdict was measured. ' +
      'Re-run the exact files after fixing the runner or checkout failure; do not read this as a pass or a test failure.',
    routerOutput: opts.routerOutput.slice(-2000),
  };
}

/**
 * A foreground timeout must return its detached recovery handle without waiting on
 * optional execution-ledger readback. The timeout path has no completed foreground
 * verdict to bind, and an unbounded test_runs query can consume the remaining MCP
 * transport margin under database contention (EI-22687291136362768).
 */
export function shouldResolveHarnessTestRunIds(result: Pick<TestFilesCoreResult, 'ok' | 'error'>): boolean {
  return !(result.ok === false && result.error === 'timeout');
}

/** Preserve the detached run handle in every recovery response, including fail-soft bundles. */
export function testEvidenceRecoveryRunId(
  originRunId: string,
  result: { error?: string; detachedRunId?: string },
): string {
  return result.error === 'timeout' && result.detachedRunId ? result.detachedRunId : originRunId;
}

/**
 * Resolve optional harness test-run IDs without letting a slow ledger query erase the
 * already-computed test verdict. The ID lookup is useful for evidence binding, but it is
 * not the test result itself; a database/pool stall must therefore become an explicit
 * unknown readback rather than an MCP request timeout or a confident empty ID list.
 */
export const TEST_RUN_ID_READBACK_TIMEOUT_MS = 5_000;

export interface TestRunIdReadback {
  ids: number[] | null;
  /** Exact ledger IDs keyed by the public `byFile[path]` path. */
  idsByFile: Record<string, number> | null;
  degraded: boolean;
  reason?: BoundedTimeoutResult<number[]>['reason'];
  elapsedMs: number;
}

/** Match scoped ledger rows to public byFile keys using measured root/path, never row order. */
export function mapHarnessTestRunIdsByFile(
  byFile: DistilledTestRun['byFile'],
  rows: readonly HarnessTestRunEvidence[],
  opts: { root: string; roots?: readonly string[]; workspaceId: string; harnessSlug: string; runGroupId: string },
): Record<string, number> {
  const ambientRoot = resolve(opts.root);
  const rootCount = new Set((opts.roots ?? [ambientRoot]).map((root) => resolve(root))).size;
  const candidates = new Map<string, number[]>();

  for (const row of rows) {
    if (row.workspace_id !== opts.workspaceId || row.harness_slug !== opts.harnessSlug
      || row.run_group_id !== opts.runGroupId) continue;

    const details = parseTestRunExecutionDetails(row.execution_details);
    let publicPath = row.file_path;
    if (details) {
      if (details.filePath !== row.file_path || details.workspaceId !== opts.workspaceId
        || details.harnessSlug !== opts.harnessSlug || details.runGroupId !== opts.runGroupId) continue;
      const rowRoot = resolve(details.root);
      publicPath = rowRoot === ambientRoot ? details.filePath : resolve(rowRoot, details.filePath);
    } else if (rootCount > 1) {
      // A legacy row has no root identity. Duplicate relative paths across checkouts are ambiguous.
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(byFile, publicPath)) continue;
    const pathIds = candidates.get(publicPath) ?? [];
    pathIds.push(row.id);
    candidates.set(publicPath, pathIds);
  }

  return Object.fromEntries(
    [...candidates.entries()]
      .filter(([, ids]) => ids.length === 1)
      .map(([filePath, ids]) => [filePath, ids[0]!]),
  );
}

export async function readHarnessTestRunIdsBounded(
  query: HarnessTestRunIdQuery,
  opts: {
    findIds?: (query: HarnessTestRunIdQuery) => Promise<number[]>;
    findEvidence?: typeof readHarnessTestRunEvidence;
    timeoutMs?: number;
    root?: string;
    roots?: readonly string[];
    byFile?: DistilledTestRun['byFile'];
  } = {},
): Promise<TestRunIdReadback> {
  if (opts.findIds) {
    const bounded = await withBoundedTimeout(
      () => opts.findIds!(query),
      {
        fallback: null,
        timeoutMs: opts.timeoutMs ?? TEST_RUN_ID_READBACK_TIMEOUT_MS,
        label: 'testing:run harness test-run ID readback',
      },
    );
    return {
      ids: bounded.value,
      idsByFile: null,
      degraded: bounded.degraded,
      ...(bounded.reason === undefined ? {} : { reason: bounded.reason }),
      elapsedMs: bounded.elapsedMs,
    };
  }

  const bounded = await withBoundedTimeout(
    () => (opts.findEvidence ?? readHarnessTestRunEvidence)(query),
    {
      fallback: null,
      timeoutMs: opts.timeoutMs ?? TEST_RUN_ID_READBACK_TIMEOUT_MS,
      label: 'testing:run harness test-run ID readback',
    },
  );
  const rows = bounded.value;
  return {
    ids: rows === null ? null : rows.map((row) => row.id).sort((a, b) => a - b),
    idsByFile: rows === null || opts.root === undefined || opts.byFile === undefined
      ? null
      : mapHarnessTestRunIdsByFile(opts.byFile, rows, { ...query, root: opts.root, roots: opts.roots }),
    degraded: bounded.degraded || rows === null,
    ...(bounded.reason === undefined ? {} : { reason: bounded.reason }),
    elapsedMs: bounded.elapsedMs,
  };
}

/**
 * EI-21909191824649521: a run that COLLECTED tests and executed NONE of them produced no
 * evidence — yet vitest exits 0, and the two fields a reader treats as the verdict (`ok:true`
 * and `failed:0`) both read as success while `skipped:N` sits below them, outranked.
 *
 * That is the SAME epistemic event as the two refusals on either side of it — a path matching
 * zero files (`route_error`) and a `testNamePattern` matching zero tests
 * (`name_filter_no_match`) — and it was the one case left passing. The exposed consumer is an
 * acceptance grader following a rubric drill that names an env-gated `*-live` suite: it gets
 * `ok:true` and credits a criterion on which zero assertions ever ran.
 *
 * Deliberately NARROW to the zero-executed case. A PARTIALLY skipped run produced real
 * evidence and keeps its current shape; and `skipped > 0` is required so this can never
 * swallow a genuinely empty router result, which `route_error` / `no_report` already own.
 */
function zeroExecutedRefusal(
  run: { passed: number; failed: number; skipped: number; files: number },
  ctx: { runId: string; root: string },
): TestFilesCoreResult | null {
  if (run.passed + run.failed > 0 || run.skipped <= 0) return null;
  return {
    ok: false,
    runId: ctx.runId,
    root: ctx.root,
    error: 'all_tests_skipped',
    skipped: run.skipped,
    files: run.files,
    hint:
      `all ${run.skipped} collected test(s) were SKIPPED and NONE executed, so NOTHING was ` +
      'verified — this is NOT a pass, and `failed: 0` here is not evidence. The file is ' +
      "typically env-gated (`describe.skipIf` / `it.skip`): set the suite's env var to actually " +
      'run it, or record the check as NOT EXECUTED.',
  };
}

/** Read every JSON report written by one router invocation, preserving group order. */
async function readRunReportTexts(dir: string): Promise<string[]> {
  try {
    const names = (await readdir(dir))
      .filter((name) => name.endsWith('.json') && name !== TEST_FAILURE_DETAILS_FILENAME)
      .sort();
    return (await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8').catch(() => null)))).filter(
      (text): text is string => text !== null,
    );
  } catch {
    return [];
  }
}

/** Read the optional assertion-detail sidecar without making it a run prerequisite. */
async function readFailureDetails(path: string, root: string): Promise<ReturnType<typeof parseFailureDetailsSidecar>> {
  try {
    return parseFailureDetailsSidecar(await readFile(path, 'utf8'), root);
  } catch {
    return [];
  }
}

/**
 * A foreground budget can expire after the router has already finished the
 * tests and emitted its terminal marker, while the child process is still
 * closing or flushing its report. Prefer that completed evidence over a false
 * timeout, but recover only when the marker and the structured report agree.
 */
async function recoverCompletedRunAfterBudget(opts: {
  output: string;
  dir: string;
  root: string;
  runId: string;
  files: string[];
  timeoutMs: number;
  maxFailures?: number;
}): Promise<TestFilesCoreResult | null> {
  const terminal = parseRouterTerminalCompletion(opts.output);
  if (!terminal) return null;
  if (terminal.requested !== opts.files.length) return null;

  const reportTexts = await readRunReportTexts(opts.dir);
  let run: DistilledTestRun | null = null;
  if (reportTexts.length > 0) {
    const failureDetails = await readFailureDetails(join(opts.dir, TEST_FAILURE_DETAILS_FILENAME), opts.root);
    run = mergeDistilledRuns(
      withNodeTestGroupRuns(
        reportTexts.map((text) => distillVitestRun(text, opts.root, { maxFailures: opts.maxFailures, failureDetails })),
        opts.output,
        opts.files,
        opts.maxFailures === undefined ? {} : { maxFailures: opts.maxFailures },
      ),
      { maxFailures: opts.maxFailures },
    );
  } else {
    run = parseRouterTestResult(opts.output, opts.files, {
      ...(opts.maxFailures === undefined ? {} : { maxFailures: opts.maxFailures }),
    });
  }

  // The marker's executed count is the router's file count. If no report (or
  // parser summary) can corroborate that count, retain the conservative timeout.
  if (!run || run.files !== terminal.executed || run.passed + run.failed <= 0) return null;
  const reportFailed = run.failed > 0;
  if ((terminal.status === 'passed' && reportFailed) || (terminal.status === 'failed' && !reportFailed)) return null;

  return boundTestRunPayload(
    {
      ok: terminal.status === 'passed',
      runId: opts.runId,
      root: opts.root,
      budgetExceeded: true,
      budgetMs: opts.timeoutMs,
      ...(terminal.runElapsedMs === undefined ? {} : { runElapsedMs: terminal.runElapsedMs }),
    },
    run,
  ) as TestFilesCoreResult;
}

interface RouterOutcome extends TestProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  output: string;
  actualDemand?: ResourceDemand;
}

const ROUTER_OUTPUT_TAIL_CHARS = 8_192;
const ROUTER_PRIORITY_DIAGNOSTIC_CHARS = 1_600;

/**
 * Machine lines that explain why a routed run was refused or establish its
 * terminal verdict. The child writes stdout and stderr through independent
 * pipes, so their delivery order is not a causal order; a later healthy
 * group's progress can otherwise evict an earlier failing group's terminal
 * marker from the raw tail (EI-23084691057182393).
 */
const ROUTER_PRIORITY_DIAGNOSTIC_RE =
  /^\s*(?:TEST_FILE_(?:ROUTE_ERROR|NOT_MEASURED|WATCHDOG|FREEZE_QUALIFIER|MID_INSTALL_SUSPECTED|TRANSFORM_FAILURE|COLLECTION_ATTRIBUTION|GROUP_RESULT|NAME_FILTER_NO_MATCH|ALL_SKIPPED|REQUIRE_RAN|RESULT)\b|(?:Error|Caused by):\s|(?:✗\s+BROKEN|✓\s+ok|unmatched)\b)/u;

export interface BoundedRouterOutputCapture {
  append(channel: 'stdout' | 'stderr', value: Buffer | string): void;
  finish(): string;
}

/**
 * Retain the ordinary bounded tail plus a tiny priority reservoir of causal
 * router diagnostics. The reservoir is appended only when one of its lines
 * fell out of the tail, which leaves normal short/successful output unchanged
 * while ensuring every downstream `slice(-2000)` still sees the refusal that
 * explains a `route_error`.
 */
export function createBoundedRouterOutputCapture(
  opts: {
    tailChars?: number;
    diagnosticChars?: number;
  } = {},
): BoundedRouterOutputCapture {
  const tailChars = Math.max(256, Math.floor(opts.tailChars ?? ROUTER_OUTPUT_TAIL_CHARS));
  const diagnosticChars = Math.max(
    128,
    Math.min(tailChars - 96, Math.floor(opts.diagnosticChars ?? ROUTER_PRIORITY_DIAGNOSTIC_CHARS)),
  );
  const remainders: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const diagnosticLines: string[] = [];
  const seenDiagnostics = new Set<string>();
  let tail = '';
  let finished: string | null = null;

  const retainLine = (line: string) => {
    const normalized = line.trimEnd();
    if (!ROUTER_PRIORITY_DIAGNOSTIC_RE.test(normalized) || seenDiagnostics.has(normalized)) return;
    seenDiagnostics.add(normalized);
    diagnosticLines.push(normalized.slice(0, 1_200));
  };

  return {
    append(channel, value) {
      if (finished !== null) return;
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
      tail = (tail + text).slice(-tailChars);
      const parts = (remainders[channel] + text).split(/\r?\n/);
      remainders[channel] = parts.pop() ?? '';
      for (const line of parts) retainLine(line);
    },
    finish() {
      if (finished !== null) return finished;
      for (const channel of ['stdout', 'stderr'] as const) {
        if (remainders[channel] !== '') retainLine(remainders[channel]);
        remainders[channel] = '';
      }
      const missing = diagnosticLines.filter((line) => !tail.includes(line));
      if (missing.length === 0) {
        finished = tail;
        return finished;
      }
      const joined = missing.join('\n');
      const bounded =
        joined.length <= diagnosticChars
          ? joined
          : `${joined.slice(0, Math.floor((diagnosticChars - 32) / 2))}\n` +
            `[diagnostics clipped]\n${joined.slice(-Math.ceil((diagnosticChars - 32) / 2))}`;
      finished = `${tail}\nTESTING_RUN_PRIORITY_DIAGNOSTICS retained-before-tail-truncation\n${bounded}`.slice(
        -tailChars,
      );
      return finished;
    },
  };
}

export interface TestProcessDeadlineContext {
  /** Signal used by the child process; caller cancellation remains visible after admission. */
  signal: AbortSignal;
  /** Signal used by durable admission; it is only aborted while admission is pending. */
  admissionSignal: AbortSignal;
  /** Mark the durable admission as complete and return the budget left for the child process. */
  markAdmissionComplete(): number;
  /** Read the remaining whole-operation budget without changing its phase. */
  remainingTimeoutMs(): number;
}

type ManagedTestSpawn = Pick<ManagedSpawnResult, 'child' | 'taskId' | 'scopeUnit' | 'confined'>;

export interface ManagedTestProcess {
  child: ChildProcess;
  taskId: string;
  scopeUnit: string | null;
  scopeCgroupPath: string | null;
  outputPath: string;
  confined: boolean;
  /** Idempotent whole-tree termination. Confined runs address their exact scope;
   *  fail-soft/unconfined runs retain the legacy negative-PGID cleanup. */
  terminate(): void;
}

export interface ManagedTestProcessDeps {
  managedSpawnFn?: (
    command: string,
    args: readonly string[],
    spec: Parameters<typeof managedSpawn>[2],
    opts?: Parameters<typeof managedSpawn>[3],
  ) => Promise<ManagedTestSpawn>;
  killScopeUnitFn?: (scopeUnit: string, opts?: Parameters<typeof killScopeUnit>[1]) => Promise<ScopeControlOutcome>;
  killProcessGroupFn?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Launch one foreground router outside the operator service's cgroup.
 *
 * `detached:true` alone creates a process group but leaves the whole group in
 * `papercusp-staging-api.service`; a sanctioned staging restart therefore kills
 * it. `managedSpawn` moves the payload into a named sibling transient scope and
 * keeps the existing piped stdio. The scope also owns a systemd deadline, so a
 * parent restart cannot erase the only timeout and leave a test tree immortal.
 */
export async function launchManagedTestProcess(
  opts: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    runGroup: string;
    workspaceId: string;
    outputPath: string;
  },
  deps: ManagedTestProcessDeps = {},
): Promise<ManagedTestProcess> {
  const spawnManaged = deps.managedSpawnFn ?? managedSpawn;
  const killOwnedScope = deps.killScopeUnitFn ?? killScopeUnit;
  const killProcessGroup = deps.killProcessGroupFn ?? ((pid, signal) => process.kill(-pid, signal));
  const outputFd = openSync(opts.outputPath, 'w', 0o600);
  let launched: ManagedTestSpawn;
  try {
    launched = await spawnManaged(
      opts.command,
      opts.args,
      {
        class: 'test-run',
        title: `testing:run foreground ${opts.runGroup}`,
        argv: [opts.command, ...opts.args],
        cwd: opts.cwd,
        harnessSlug: opts.env.PAPERCUSP_TEST_RUN_HARNESS ?? null,
        launchedBy: `testing:run:${opts.runGroup}`,
        // The in-process timer owns the ordinary verdict. This slightly wider
        // kernel deadline is the restart-safe backstop and still bounds the task
        // when the operator (and therefore its timer) disappears mid-run.
        runtimeMaxSec: Math.max(1, Math.ceil((opts.timeoutMs + FOREGROUND_TERMINATION_GRACE_MS) / 1_000)),
        detail: { runGroup: opts.runGroup, foreground: true },
      },
      {
        workspaceId: opts.workspaceId,
        spawnOptions: {
          cwd: opts.cwd,
          env: opts.env,
          // A pipe belongs to this operator process; its death closes the read
          // end and can EPIPE the surviving payload. An inherited file fd keeps
          // diagnostics writable across the restart and is read on normal close.
          stdio: ['ignore', outputFd, outputFd],
          // Preserve the unconfined fallback's whole-process-group identity.
          // Under confinement the scope is the stronger whole-tree handle.
          detached: true,
        },
      },
    );
  } finally {
    closeSync(outputFd);
  }
  const scopeCgroupPath =
    launched.confined && launched.scopeUnit
      ? scopeCgroupRelPath(deriveUserManagerRoot(readProcessCgroupPath(process.pid)), 'test-run', launched.scopeUnit)
      : null;

  let terminationStarted = false;
  const terminateProcessGroup = (): void => {
    const pid = launched.child.pid;
    if (!pid) return;
    const signal = (next: NodeJS.Signals): void => {
      try {
        killProcessGroup(pid, next);
      } catch {
        // Group already gone, or negative-PGID signalling is unsupported. At
        // least signal the router handle so cleanup never silently no-ops.
        try {
          launched.child.kill(next);
        } catch {
          /* already gone */
        }
      }
    };
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), FOREGROUND_TERMINATION_GRACE_MS).unref();
  };

  return {
    ...launched,
    scopeCgroupPath,
    outputPath: opts.outputPath,
    terminate(): void {
      if (terminationStarted) return;
      terminationStarted = true;
      if (!launched.confined || !launched.scopeUnit) {
        terminateProcessGroup();
        return;
      }
      // The `ChildProcess` is the systemd-run client, while the payload lives
      // in the sibling scope. Address the scope itself; signalling only the
      // client can orphan the still-running router and Vitest descendants.
      void killOwnedScope(launched.scopeUnit, {
        signal: 'SIGTERM',
        escalateAfterMs: FOREGROUND_TERMINATION_GRACE_MS,
      }).then(
        (outcome) => {
          if (!outcome.ok && outcome.error !== 'already_gone') {
            void killOwnedScope(launched.scopeUnit!, { signal: 'SIGKILL' }).catch(() => undefined);
          }
        },
        () => {
          void killOwnedScope(launched.scopeUnit!, { signal: 'SIGKILL' }).catch(() => undefined);
        },
      );
    },
  };
}

export function preserveConfinedTestOnHostShutdown(
  shuttingDown: boolean,
  running: Pick<ManagedTestProcess, 'confined'> | null,
): boolean {
  return shuttingDown && running?.confined === true;
}

export interface ConfinedTestHostShutdownOutcome extends TestProcessOutcome {
  readonly code: null;
  readonly signal: null;
  readonly timedOut: false;
  readonly aborted: true;
  readonly hostShutdownDetached: true;
}

/**
 * Release the dying operator's request without terminating a confined test.
 *
 * Merely ignoring the request abort keeps the old server awaiting the child.
 * A coordinated restart then waits for the server's stop timeout, while the
 * child's shorter RuntimeMaxSec fires first; the child can never finish after
 * the old host exits. Settling the request here transfers lifetime ownership
 * to the sibling systemd scope and lets the old host terminate immediately.
 */
export function settleConfinedTestOnHostShutdown(
  shuttingDown: boolean,
  running: Pick<ManagedTestProcess, 'confined'> | null,
  settle: (outcome: ConfinedTestHostShutdownOutcome) => void,
): boolean {
  if (!preserveConfinedTestOnHostShutdown(shuttingDown, running)) return false;
  settle({
    code: null,
    signal: null,
    timedOut: false,
    aborted: true,
    hostShutdownDetached: true,
    output: 'operator host shutdown released its request; the confined test continues in its sibling scope',
  });
  return true;
}

/** Aggregate actual residency from the task's whole cgroup, not merely from
 * the systemd-run client pid. Falls back to the legacy process-tree reader on
 * hosts where managed confinement is unavailable. */
export async function readManagedTestProcessResourceSnapshot(
  running: Pick<ManagedTestProcess, 'child' | 'scopeCgroupPath'>,
  deps: {
    fs?: CgroupFs;
    readFileDescriptors?: (pid: number) => Promise<number | null>;
  } = {},
): Promise<TestProcessResourceSnapshot> {
  if (!running.scopeCgroupPath) {
    return running.child.pid
      ? readTestProcessResourceSnapshot(running.child.pid)
      : { cpuMicros: null, rssBytes: null, fileDescriptors: null };
  }
  const fs = deps.fs ?? nodeCgroupFs;
  const readFileDescriptors = deps.readFileDescriptors ?? procFileDescriptors;
  const root = absCgroupDir(running.scopeCgroupPath);
  const cgroup = sampleCgroup(root, fs);
  const pids = new Set<number>();
  for (const node of walkCgroupTree(root, fs)) {
    for (const pid of node.pids) pids.add(pid);
  }
  const descriptors = await Promise.all([...pids].map(readFileDescriptors));
  const measuredDescriptors = descriptors.filter((count): count is number => count !== null);
  return {
    cpuMicros: cgroup.cpuUsec,
    rssBytes: cgroup.peakMemoryBytes ?? cgroup.memoryBytes,
    fileDescriptors:
      measuredDescriptors.length > 0 ? measuredDescriptors.reduce((total, count) => total + count, 0) : null,
  };
}

/**
 * Bound the admission phase of a governed test process.
 *
 * `runGovernedOperation` deliberately waits for durable admission before invoking its
 * callback. A test-run timeout that starts inside that callback therefore leaves a queued
 * admission unbounded and can outlive the MCP transport. Keep the timer around that wait,
 * forward caller cancellation through an internal controller, and let the callback spend
 * only the remainder of the same deadline on the child process.
 *
 * The operation promise remains observed after the timeout wins. That matters because a
 * slow Governor.admit may eventually settle and must not become an unhandled rejection;
 * its signal is already aborted, so `withGovernedExecution` cancels any late receipt.
 */
export function runWithTestProcessDeadline<T>(opts: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  run: (context: TestProcessDeadlineContext) => Promise<T>;
  onAdmissionTimeout: (timeoutMs: number) => T;
  onAbort: () => T;
}): Promise<T> {
  const timeoutMs = Math.max(0, Math.floor(opts.timeoutMs));
  const deadlineAtMs = Date.now() + timeoutMs;
  const admissionController = new AbortController();
  const childController = new AbortController();
  let phase: 'admission' | 'running' | 'timed-out' | 'aborted' = 'admission';
  let timer: NodeJS.Timeout | null = null;
  let parentAbort: (() => void) | null = null;

  const remainingTimeoutMs = (): number => Math.max(0, deadlineAtMs - Date.now());
  const markAdmissionComplete = (): number => {
    if (phase === 'admission') {
      phase = 'running';
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
    return remainingTimeoutMs();
  };

  let timeoutPromise!: Promise<T>;
  let abortPromise!: Promise<T>;
  timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      if (phase !== 'admission') return;
      phase = 'timed-out';
      const reason = new Error(`test-process admission exceeded its ${timeoutMs}ms budget`);
      admissionController.abort(reason);
      childController.abort(reason);
      resolve(opts.onAdmissionTimeout(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  abortPromise = new Promise<T>((resolve) => {
    parentAbort = () => {
      const reason = opts.parentSignal?.reason ?? new Error('test-process caller aborted');
      childController.abort(reason);
      if (phase !== 'admission') return;
      admissionController.abort(reason);
      phase = 'aborted';
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(opts.onAbort());
    };
    if (opts.parentSignal?.aborted) parentAbort();
    else opts.parentSignal?.addEventListener('abort', parentAbort, { once: true });
  });

  const operation = Promise.resolve().then(() =>
    opts.run({
      signal: childController.signal,
      admissionSignal: admissionController.signal,
      markAdmissionComplete,
      remainingTimeoutMs,
    }),
  );
  // Observe late completion/rejection after either bounded fallback wins. In particular,
  // a Governor.admit that was blocked in the queue must still run its signal cancellation
  // path when it eventually returns.
  void operation.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([operation, timeoutPromise, abortPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
    if (parentAbort) opts.parentSignal?.removeEventListener('abort', parentAbort);
  });
}

/** Spawn a bounded test process, capturing its diagnostics. */
function runTestProcess(
  command: string,
  commandArgs: string[],
  args: string[],
  cwd: string,
  checkoutRoot: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  const runGroup = env.PAPERCUSP_TEST_RUN_GROUP ?? 'unattributed';
  const plannedDemand = buildTestProcessDemand({ fileCount });
  return runWithTestProcessDeadline<RouterOutcome>({
    timeoutMs,
    parentSignal: signal,
    onAdmissionTimeout: (budgetMs) => ({
      code: null,
      signal: null,
      timedOut: true,
      aborted: false,
      output: `governed test-process admission exceeded its ${budgetMs}ms whole-operation budget before the child started`,
    }),
    onAbort: () => ({
      code: null,
      signal: null,
      timedOut: false,
      aborted: true,
      output: 'caller aborted while waiting for governed test-process admission',
    }),
    run: ({ signal: childSignal, admissionSignal, markAdmissionComplete, remainingTimeoutMs }) =>
      runGovernedOperation(
        {
          workspaceId: activeWorkspaceId(),
          namespace: 'testing-run-process',
          owner: `testing:run:${runGroup}`,
          admissionClass: 'process',
          demand: plannedDemand,
          payloadRef: `testing:run:${runGroup}`,
          parent: admissionContextFromEnvironment(env.PAPERCUSP_ADMISSION_CONTEXT),
          leaseTtlMs: governedExecutionLeaseTtlForTimeout(timeoutMs),
          signal: admissionSignal,
          metadata: { command, timeoutMs, fileCount, processKind: 'test-run' },
          settle: (outcome) => classifyTestProcessOutcome(outcome),
        },
        async (admissionContext) => {
          const childTimeoutMs = markAdmissionComplete();
          if (childTimeoutMs <= 0) {
            return {
              code: null,
              signal: null,
              timedOut: true,
              aborted: false,
              output: 'governed test-process admission consumed the whole-operation budget before the child started',
            };
          }
          if (childSignal.aborted) {
            return {
              code: null,
              signal: null,
              timedOut: false,
              aborted: true,
              output: 'caller aborted before the governed test process started',
            };
          }
          return new Promise((resolve) => {
            const outputCapture = createBoundedRouterOutputCapture();
            const routerOutputPath = join(
              ensurePapercuspTmpdir() ?? tmpdir(),
              `papercusp-testing-run-router-${runGroup}-${randomUUID()}.log`,
            );
            let outputBytes = 0;
            let timedOut = false;
            let aborted = false;
            let spawnError: string | undefined;
            let settled = false;
            let outputLoaded = false;
            const loadOutput = (): void => {
              if (outputLoaded) return;
              outputLoaded = true;
              try {
                const bytes = readFileSync(routerOutputPath);
                outputBytes = bytes.byteLength;
                outputCapture.append('stdout', bytes);
              } catch {
                /* spawn may have failed before creating output */
              }
              void rm(routerOutputPath, { force: true });
            };
            // EI-19324351741370770: `scripts/test-files.mjs` launches the REAL vitest run via
            // `spawnSync('npx', ['vitest', 'run', ...])` — synchronously, and WITHOUT its own
            // `detached: true` — so that vitest process inherits THIS process's process group
            // rather than becoming reparented on its own. Killing only `child` (the router) by
            // its own pid terminates the router but leaves vitest running as an ORPHAN: Unix
            // never cascade-kills a process's children just because the parent died. That
            // orphan then keeps executing (and holding forks) for the suite's real duration,
            // invisible to the caller, who was told `error:'timeout'` and reasonably assumes
            // nothing is still running. Following the tool's own "re-run it detached" hint then
            // launches a SECOND concurrent run of the same suite.
            //
            // Fix: spawn the router `detached: true` so it becomes the leader of a NEW process
            // group (pgid === its own pid); vitest, spawned without its own `detached`, inherits
            // THAT group. On timeout, signal the NEGATIVE pid — killing the whole process group,
            // router and every child/grandchild it spawned — instead of just the router itself.
            let sampler = createTestProcessDemandSampler(plannedDemand);
            let timer: NodeJS.Timeout | null = null;
            let onAbort: (() => void) | null = null;
            const finish = (outcome: Omit<RouterOutcome, 'actualDemand'>) => {
              if (settled) return;
              settled = true;
              // A host-shutdown handoff returns before the child finishes. Keep
              // both file-backed sinks available to the surviving child. A rare
              // handoff may leave one bounded directory in the namespaced
              // system temp root; that is safer than deleting a live reporter's
              // output path and converting a completed run into no evidence.
              if (!outcome.hostShutdownDetached) loadOutput();
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              if (onAbort) childSignal.removeEventListener('abort', onAbort);
              void sampler.stop({ diskBytes: outputBytes }).then(
                (actualDemand) => resolve({ ...outcome, actualDemand }),
                () => resolve({ ...outcome, actualDemand: plannedDemand }),
              );
            };
            const launchTimeoutMs = Math.max(1, Math.min(childTimeoutMs, remainingTimeoutMs()));
            let running: ManagedTestProcess | null = null;
            const settleBeforeLaunchHandoff = (): void => {
              finish({
                code: null,
                signal: null,
                timedOut,
                aborted,
                output: timedOut
                  ? `managed test-process launch exceeded its ${launchTimeoutMs}ms budget before a child handle was available`
                  : 'caller aborted while managed test-process launch was still pending',
              });
            };
            onAbort = () => {
              if (settled) return;
              if (settleConfinedTestOnHostShutdown(isShuttingDown(), running, finish)) {
                aborted = true;
                return;
              }
              aborted = true;
              if (running) running.terminate();
              else settleBeforeLaunchHandoff();
            };
            if (childSignal.aborted) onAbort();
            else childSignal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => {
              timedOut = true;
              if (running) running.terminate();
              else settleBeforeLaunchHandoff();
            }, launchTimeoutMs);
            void launchManagedTestProcess({
              // The wrapper serializes admission with in-tree probe publication
              // and keeps the original-byte bind over the entire child tree.
              // It runs even when no probe was visible at preflight: a probe
              // can start between that read and managedSpawn's handoff.
              command: join(REPO_ROOT, 'scripts', 'testing-run-probe-overlay.sh'),
              args: [checkoutRoot, '--', command, ...commandArgs, ...args],
              cwd,
              env: { ...env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(admissionContext) },
              timeoutMs: launchTimeoutMs,
              runGroup,
              workspaceId: env.PAPERCUSP_WORKSPACE_ID ?? activeWorkspaceId(),
              outputPath: routerOutputPath,
            }).then(
              (launched) => {
                running = launched;
                if (settled) {
                  // A bounded caller may have returned while managedSpawn's
                  // probe/ledger admission was still pending. Observe the late
                  // handoff and terminate it immediately; never leak work that
                  // arrived after its caller's deadline.
                  launched.terminate();
                  return;
                }
                const child = launched.child;
                sampler = createTestProcessDemandSampler(plannedDemand, () =>
                  readManagedTestProcessResourceSnapshot(launched),
                );
                sampler.attach(child.pid);
                // The deadline starts before managedSpawn's async probe/ledger
                // admission. If it elapsed (or the caller aborted) while that
                // boundary was resolving, terminate immediately on handoff.
                if (timedOut || aborted || childSignal.aborted) launched.terminate();
                // Cap retained diagnostics — the router's own output is a fallback for the
                // error paths, never the success path's payload.
                const append = (channel: 'stdout' | 'stderr') => (b: Buffer) => {
                  outputBytes += b.byteLength;
                  outputCapture.append(channel, b);
                };
                child.on('error', (e) => {
                  spawnError = e.message;
                  outputCapture.append('stderr', `\n[spawn-error] ${e.message}\n`);
                  finish({
                    code: null,
                    signal: null,
                    timedOut,
                    aborted,
                    spawnError,
                    output: outputCapture.finish(),
                  });
                });
                child.on(
                  'close',
                  (code, closeSignal) => (
                    loadOutput(),
                    finish({
                      code,
                      signal: closeSignal ?? null,
                      timedOut,
                      aborted,
                      output: outputCapture.finish(),
                    })
                  ),
                );
              },
              (error) => {
                spawnError = error instanceof Error ? error.message : String(error);
                outputCapture.append('stderr', `\n[spawn-error] ${spawnError}\n`);
                finish({
                  code: null,
                  signal: null,
                  timedOut,
                  aborted: aborted || childSignal.aborted,
                  spawnError,
                  output: outputCapture.finish(),
                });
              },
            );
          });
        },
      ),
  });
}

/** Spawn the Papercusp router, preserving its owning-workspace guarantees. */
function runRouter(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  return runTestProcess(
    process.execPath,
    [join(cwd, 'scripts', 'test-files.mjs')],
    args,
    cwd,
    cwd,
    env,
    timeoutMs,
    signal,
    fileCount,
  );
}

/** Spawn a generic external Vitest checkout through its local npm installation. */
function runDirectVitest(
  args: string[],
  cwd: string,
  checkoutRoot: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  return runTestProcess(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--no-install', 'vitest'],
    args,
    cwd,
    checkoutRoot,
    env,
    timeoutMs,
    signal,
    fileCount,
  );
}

export interface DirectVitestRouteGroup {
  /** The declared npm workspace that owns these files (or the checkout root). */
  cwd: string;
  /** Layer-specific config, relative to cwd. Omitted to let Vitest/Vite discover the workspace default. */
  config?: string;
  /** Exact file filters, relative to cwd. */
  files: string[];
}

/**
 * Parse the router's terminal report when the selected runner does not emit a
 * Vitest JSON report. `scripts/test-files.mjs` uses this path for registered
 * `node:test` files (for example `papercusp-desktop/test/*.test.js`): it emits
 * the stamped `TEST_FILE_RESULT` marker plus Node's numeric summary, but
 * `--reporter=json --outputFile` is not meaningful to Node's test runner.
 *
 * Keep this parser strict. A marker without a non-zero test summary is not
 * enough to establish that tests actually ran, so the caller retains its
 * existing `no_report` refusal in that case.
 */
export function parseRouterTestResult(
  output: string,
  files: readonly string[] = [],
  opts: { maxFailures?: number } = {},
): DistilledTestRun | null {
  const markerRe =
    /^TEST_FILE_RESULT\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+status=(passed|failed)\b[^\r\n]*$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) return null;

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  const status = marker[4];
  if (
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(executed) ||
    !Number.isSafeInteger(matched) ||
    requested < 1 ||
    executed < 1 ||
    matched !== requested ||
    executed !== matched
  ) {
    return null;
  }

  return distillNodeTestSummary(output, files, executed, status === 'failed', opts);
}

/**
 * Distill Node's numeric test summary (`ℹ tests N` / `ℹ pass N` / `ℹ fail N`)
 * from one router output segment. Returns null when no non-zero summary is
 * present — a missing summary is never evidence that tests ran.
 */
function distillNodeTestSummary(
  output: string,
  files: readonly string[],
  executed: number,
  routerReportedFailure: boolean,
  opts: { maxFailures?: number } = {},
): DistilledTestRun | null {
  const summaryValue = (label: string): number | null => {
    const re = new RegExp(`^\\s*(?:ℹ|#)?\\s*${label}\\s+(\\d+)\\s*$`, 'gm');
    let value: number | null = null;
    for (const match of output.matchAll(re)) value = Number(match[1]);
    return value !== null && Number.isSafeInteger(value) ? value : null;
  };
  const tests = summaryValue('tests');
  const passed = summaryValue('pass');
  const reportedFailed = summaryValue('fail');
  if (tests === null || passed === null || reportedFailed === null || tests < 1) return null;

  const skipped = (summaryValue('skipped') ?? 0) + (summaryValue('todo') ?? 0) + (summaryValue('cancelled') ?? 0);
  const durationMatch = /^(?:\s*)(?:ℹ|#)?\s*duration_ms\s+([0-9]+(?:\.[0-9]+)?)\s*$/gm;
  let durationMs: number | null = null;
  for (const match of output.matchAll(durationMatch)) durationMs = Math.max(0, Math.round(Number(match[1])));

  const failed = Math.max(reportedFailed, routerReportedFailure ? 1 : 0);
  const maxFailures = Math.max(1, Math.floor(opts.maxFailures ?? 20));
  const failureFile = files.length === 1 ? files[0]! : '(node:test failure)';
  const failureNames = [...output.matchAll(/^\s*not ok(?:\s+\d+)?\s+-\s+([^\r\n]+)$/gm)].map((m) => m[1]!.trim());
  const failures = failureNames.slice(0, maxFailures).map((test) => ({
    file: failureFile,
    test: test || '(unnamed node:test failure)',
    message: 'node:test reported a failure; structured Vitest failure details are unavailable for this runner.',
  }));
  if (failed > 0 && failures.length === 0) {
    failures.push({
      file: failureFile,
      test: '(node:test failure details unavailable)',
      message: `node:test reported ${failed} failed test(s); structured failure details were not emitted.`,
    });
  }

  const byFile =
    files.length === 1 && executed === 1 ? { [files[0]!]: { passed, failed, skipped, collectionFailed: false } } : {};
  return {
    passed,
    failed,
    skipped,
    files: executed,
    failures,
    failuresTruncated: failureNames.length > maxFailures,
    durationMs,
    byFile,
  };
}

/** Map a router `requested <path>` line back to the caller's exact `files[]` entry. */
function matchRequestedFile(requested: string, files: string[]): string | null {
  const norm = requested.replace(/\\/g, '/').replace(/^\.\//, '');
  const exact = files.find((f) => f.replace(/\\/g, '/').replace(/^\.\//, '') === norm);
  if (exact) return exact;
  const suffix = files.filter((f) => {
    const nf = f.replace(/\\/g, '/').replace(/^\.\//, '');
    return nf.endsWith(`/${norm}`) || norm.endsWith(`/${nf}`);
  });
  return suffix.length === 1 ? suffix[0]! : null;
}

/**
 * WI-10004243: a MIXED batch (Vitest files + registered node:test files) writes
 * Vitest JSON reports for the Vitest groups only, so the node:test files used to
 * vanish from `byFile` — and scorecards:emit then refused the criterion as
 * "never reported on". The router prints each node:test group as
 * `ROUTE cwd=<dir> runner=node:test` + `  requested <file>` lines followed by
 * Node's own numeric summary; distill each group from ITS segment only.
 *
 * Attribution is exact only for a single-file group (Node prints one aggregate
 * summary per `node --test` process). A multi-file group is returned as an
 * unattributed run (counts, no byFile entries) so totals stay honest and the
 * caller can see which requested files still lack a per-file verdict.
 */
export function parseNodeTestGroupRuns(
  output: string,
  files: string[],
  opts: { maxFailures?: number } = {},
): DistilledTestRun[] {
  const lines = output.split(/\r?\n/);
  const runs: DistilledTestRun[] = [];
  for (let i = 0; i < lines.length; i++) {
    const route = /^ROUTE cwd=(\S+) runner=node:test\s*$/.exec(lines[i]!);
    if (!route) continue;
    const cwdLabel = route[1]!;
    const requested: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = /^\s+requested\s+(\S.*?)\s*$/.exec(lines[j]!);
      if (!m) break;
      requested.push(m[1]!);
    }
    let end = j;
    while (end < lines.length && !/^(?:ROUTE cwd=|TEST_FILE_RESULT\b)/.test(lines[end]!)) end++;
    if (requested.length === 0) continue;
    const mapped = requested.map((r) => matchRequestedFile(r, files));
    const escapedCwd = cwdLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groupFailed = new RegExp(
      `^TEST_FILE_GROUP_RESULT cwd=${escapedCwd} runner=node:test\\b[^\\r\\n]*status=failed`,
      'm',
    ).test(output);
    const attributable = mapped.length === 1 && mapped[0] !== null;
    const run = distillNodeTestSummary(
      lines.slice(j, end).join('\n'),
      attributable ? [mapped[0]!] : mapped.filter((f): f is string => f !== null),
      requested.length,
      groupFailed,
      opts,
    );
    if (!run) continue;
    runs.push(attributable ? run : { ...run, byFile: {} });
    i = end - 1;
  }
  return runs;
}

/**
 * Fold node:test group runs into a Vitest-reported batch for any requested file
 * the Vitest reports did not cover. Files already present in a Vitest report are
 * never double-counted.
 */
function withNodeTestGroupRuns(
  vitestRuns: DistilledTestRun[],
  output: string,
  files: string[],
  opts: { maxFailures?: number } = {},
): DistilledTestRun[] {
  const covered = new Set(vitestRuns.flatMap((r) => Object.keys(r.byFile)));
  const nodeRuns = parseNodeTestGroupRuns(output, files, opts).filter((r) => {
    const keys = Object.keys(r.byFile);
    return keys.length === 0 ? true : keys.every((k) => !covered.has(k));
  });
  return nodeRuns.length === 0 ? vitestRuns : [...vitestRuns, ...nodeRuns];
}

/**
 * Parse the router's terminal progress + verdict pair. This is intentionally
 * separate from parseRouterTestResult: Vitest writes its structured report to
 * the private report file, so its stdout has no `tests`/`pass` summary for that
 * parser to consume. The pair is still enough to prove that the router reached
 * a terminal, zero-exit state after this tool's foreground budget elapsed.
 */
export interface RouterTerminalCompletion {
  requested: number;
  executed: number;
  matched: number;
  status: 'passed' | 'failed';
  runElapsedMs?: number;
}

export function parseRouterTerminalCompletion(output: string): RouterTerminalCompletion | null {
  const markerRe =
    /^TEST_FILE_RESULT\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+status=(passed|failed)\b[^\r\n]*$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) return null;

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  if (
    ![requested, executed, matched].every(Number.isSafeInteger) ||
    requested < 1 ||
    executed < 1 ||
    matched !== requested ||
    executed !== matched
  ) {
    return null;
  }

  let finishedLine: string | null = null;
  for (const match of output.matchAll(/^TEST_FILE_PROGRESS[^\r\n]*$/gm)) {
    const line = match[0];
    if (/\bstate=finished\b/.test(line) && /\bexitStatus=0\b/.test(line) && /\bsignal=none\b/.test(line)) {
      finishedLine = line;
    }
  }
  if (!finishedLine) return null;

  const elapsedMatch = finishedLine.match(/\belapsedMs=(\d+)\b/);
  const runElapsedMs = elapsedMatch ? Number(elapsedMatch[1]) : undefined;
  if (runElapsedMs !== undefined && (!Number.isSafeInteger(runElapsedMs) || runElapsedMs < 0)) return null;

  return {
    requested,
    executed,
    matched,
    status: marker[4] as RouterTerminalCompletion['status'],
    ...(runElapsedMs === undefined ? {} : { runElapsedMs }),
  };
}

/**
 * Parse the router's typed NOT-MEASURED terminal marker.
 *
 * A governed admission refusal and a router watchdog exit with the same
 * reserved code as an ordinary route refusal, so the markers are the only
 * safe discriminators at this layer. A watchdog may leave SOME files measured;
 * never label that partial result measuredFiles=0 or a test failure.
 */
export function parseRouterNotMeasuredMarker(output: string): RouterNotMeasuredMarker | null {
  const markerRe =
    /^TEST_FILE_NOT_MEASURED\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+measuredFiles=(\d+)\s+status=(not-measured)\s+reason=(admission-starved|undetermined)(?:\s+—.*)?$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) {
    // WI-10003090: scorecard checks previously surfaced a four-file router
    // watchdog as generic route_error, hiding the exact missing-proof reason.
    // Require both the watchdog's own line and its terminal aggregate marker;
    // one test's arbitrary output cannot manufacture this typed refusal.
    if (!/^TEST_FILE_WATCHDOG\b[^\r\n]*\bstatus=timed-out\b/m.test(output)) return null;
    const watchdogRe =
      /^TEST_FILE_NOT_MEASURED\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+status=not-measured\s+— a watchdog reaped at least one run before\b[^\r\n]*$/gm;
    let watchdog: RegExpExecArray | null = null;
    for (const match of output.matchAll(watchdogRe)) watchdog = match;
    if (!watchdog) return null;
    const requested = Number(watchdog[1]);
    const executed = Number(watchdog[2]);
    const matched = Number(watchdog[3]);
    if (![requested, executed, matched].every(Number.isSafeInteger) || requested < 1
      || matched < 1 || matched > requested || executed < 0 || executed > matched) return null;
    return { requested, executed, matched, status: 'not-measured', reason: 'router-watchdog' };
  }

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  const measuredFiles = Number(marker[4]);
  if (
    ![requested, executed, matched, measuredFiles].every(Number.isSafeInteger) ||
    requested < 1 ||
    executed < 0 ||
    matched < 0 ||
    matched > requested ||
    executed > matched ||
    measuredFiles !== 0
  ) {
    return null;
  }
  return {
    requested,
    executed,
    matched,
    measuredFiles: 0,
    status: 'not-measured',
    reason: marker[6] as RouterNotMeasuredReason,
  };
}

const VITEST_LAYER_CONFIGS = {
  integration: [
    'vitest.integration.config.ts',
    'vitest.integration.config.mts',
    'vitest.integration.config.cts',
    'vitest.integration.config.js',
    'vitest.integration.config.mjs',
    'vitest.integration.config.cjs',
  ],
  browser: [
    'vitest.browser.config.ts',
    'vitest.browser.config.mts',
    'vitest.browser.config.cts',
    'vitest.browser.config.js',
    'vitest.browser.config.mjs',
    'vitest.browser.config.cjs',
  ],
} as const;

function directVitestLayerConfig(file: string, workspaceRoot: string, checkoutRoot: string): string | undefined {
  const layer = /\.browser\.test\.[cm]?[jt]sx?$/i.test(file)
    ? 'browser'
    : /\.integration\.test\.[cm]?[jt]sx?$/i.test(file)
      ? 'integration'
      : null;
  if (layer === null) return undefined;

  let dir = workspaceRoot;
  while (isInsideRoot(checkoutRoot, dir)) {
    for (const name of VITEST_LAYER_CONFIGS[layer]) {
      if (existsSync(join(dir, name))) return relative(workspaceRoot, join(dir, name)).split(sep).join('/');
    }
    if (resolve(dir) === resolve(checkoutRoot)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Route a generic external Vitest checkout at the same OWNERSHIP grain as npm workspaces.
 *
 * Papercusp checkouts use scripts/test-files.mjs. Managed Hive repositories often do not,
 * so the old fallback ran every requested file from the repository root. In a project-style
 * Vitest config that eagerly loads every child config, one explicit layered filename then
 * poisons unrelated unit configs before the owning workspace can run it (EI-21414388102126733).
 * Running from the nearest declared workspace preserves its Vite environment and confines
 * config discovery; an available integration/browser config is selected explicitly.
 */
export function groupDirectVitestRoutes(
  files: string[],
  root: string,
  workspaceDirs: string[] = declaredWorkspaceDirs(root),
): DirectVitestRouteGroup[] {
  const groups = new Map<string, DirectVitestRouteGroup>();
  const workspaceRoots = workspaceDirs.map((dir) => resolve(root, dir)).sort((a, b) => b.length - a.length);

  for (const file of files) {
    const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
    const cwd = workspaceRoots.find((candidate) => isInsideRoot(candidate, absolute)) ?? root;
    const requested = relative(cwd, absolute).split(sep).join('/');
    const config = directVitestLayerConfig(requested, cwd, root);
    const key = `${cwd}\0${config ?? ''}`;
    const group = groups.get(key) ?? { cwd, ...(config ? { config } : {}), files: [] };
    group.files.push(requested);
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * The whole run, callable OUTSIDE the MCP handler (P-011 / D-006: scorecards:emit runs
 * a criterion's structured tests-check through this exact path, so a grading-time run
 * and a testing:run judge files identically — one router, one distillation, one set of
 * refusals). The handler below is now a thin wrapper: ctx root resolution + the
 * foreground transport clamp stay THERE (they are transport concerns, not run
 * concerns); everything else lives here.
 */
export async function runTestFilesCore(opts: {
  files: string[];
  root: string;
  timeoutMs?: number;
  maxFailures?: number;
  testNamePattern?: string;
  signal?: AbortSignal;
  /** Request scope to stamp on the reporter's durable test-run rows. */
  workspaceId?: string;
  harnessSlug?: string;
  /** Work-item a detached recovery run is attributed to (expensive-verification-loops P-001). */
  workItemId?: string;
  runId?: string;
  /** Recursive mixed-root groups defer detached recovery to their outer operation. */
  allowDetachedRecovery?: boolean;
}): Promise<TestFilesCoreResult> {
  // Normalize once before selecting the checkout.  A workspace-relative sibling
  // spelling (for example `portal/tests/foo.test.ts`) becomes an absolute path in
  // normalizeTestFilePaths; selecting from that result lets the router switch to
  // the sibling checkout's own Vitest config instead of trying to run the path from
  // the ambient Papercusp tree.
  const requestedPaths = normalizeTestFilePaths(opts.files, opts.root);
  const runId = opts.runId ?? randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (requestedPaths.ok) {
    const groups = groupTestFilesByCheckout(requestedPaths.files, opts.root);
    if (groups.length > 1) {
      const roots = groups.map((group) => group.root);
      const deadline = Date.now() + timeoutMs;
      const completed: CompletedTestGroup[] = [];
      const errors: Array<Extract<TestFilesCoreResult, { error: string }>> = [];
      for (const group of groups) {
        const result = await runTestFilesCore({
          ...opts,
          files: group.files,
          root: group.root,
          runId,
          timeoutMs: Math.max(1000, deadline - Date.now()),
          allowDetachedRecovery: false,
        });
        if (result.error !== undefined) errors.push(result);
        else completed.push({ group, result });
      }
      const timeout = errors.find((result) => result.error === 'timeout');
      if (timeout) {
        const detachedStart = await startRunDurable(
          buildDetachedMixedTestRunRequest({
            groups,
            ...(opts.testNamePattern !== undefined ? { testNamePattern: opts.testNamePattern } : {}),
            ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
            ...(opts.harnessSlug !== undefined ? { harnessSlug: opts.harnessSlug } : {}),
            ...(opts.workItemId !== undefined ? { workItemId: opts.workItemId } : {}),
            timeoutMs,
          }),
        );
        return {
          ...timeout,
          runId,
          root: resolve(opts.root),
          roots,
          timeoutMs,
          detachedRunId: detachedStart.snapshot.runId,
          detachedDurable: detachedStart.durable,
          routerOutput: errors.map((result) => result.routerOutput ?? result.hint ?? result.error).join('\n'),
          ...summarizePartialCompletedGroups(completed),
        };
      }
      if (errors.length > 0) {
        return { ...errors[0]!, runId, roots, ...summarizePartialCompletedGroups(completed) };
      }
      const merged = mergeDistilledRuns(
        completed.map(({ group, result }) => rebaseDistilledRunToAmbient(result, group.root, opts.root)),
        { maxFailures: opts.maxFailures },
      );
      return boundTestRunPayload(
        { ok: completed.every(({ result }) => result.ok), runId, root: resolve(opts.root), roots },
        merged,
      ) as TestFilesCoreResult;
    }
  }

  const root = checkoutRootForTestFiles(requestedPaths.ok ? requestedPaths.files : opts.files, opts.root);

  // An in-tree mutation probe holds its subject's file lock for the dirty
  // window. Path-level lock overlap is not enough, because a test can import
  // that source indirectly; the preflight admits only test files whose import
  // closure provably cannot observe it. The evidence handler runs the same
  // preflight before registering anything; this repeat covers every other
  // caller and a probe that started in between.
  const mutationProbe = await mutationProbeRefusal(root, requestedPaths.ok ? requestedPaths.files : opts.files);
  if (mutationProbe) return { ok: false, runId, root, ...mutationProbe };

  // WI-7189 / EI-19383071792758676: a wrong-tree resolution used to be SILENT —
  // a file that happens to exist (with stale content) at the resolved root ran
  // and returned a confident, plausible, WRONG green. `root` is echoed on EVERY
  // return path so a wrong-tree run is visible instead of silent. One loud
  // pre-flight refusal catches what the router's own check can't: a root that
  // isn't a papercusp checkout AT ALL (missing the router script itself) or a
  // known npm-workspace Vitest checkout.
  const hasRouter = existsSync(join(root, 'scripts', 'test-files.mjs'));
  if (!hasRouter && !isVitestCheckoutRoot(root)) {
    return {
      ok: false,
      runId,
      root,
      error: 'invalid_root',
      hint:
        `resolved workspace root '${root}' has no scripts/test-files.mjs or runnable Vitest workspace — ` +
        `it is not a supported checkout (or is a stale/partial one). This usually means the calling session is scoped to ` +
        `the wrong harness/tree (e.g. a legacy standalone clone) rather than the canonical staging ` +
        `checkout. Verify with 'pwd'/'git remote -v' in the tree you intend, and re-check how this ` +
        `session's harness/project is registered.`,
    };
  }
  const pathResolution = normalizeTestFilePaths(requestedPaths.ok ? requestedPaths.files : opts.files, root);
  if (!pathResolution.ok) {
    return {
      ok: false,
      runId,
      root,
      error: 'ambiguous_workspace_path',
      path: pathResolution.path,
      matches: pathResolution.matches,
      hint:
        `workspace-relative test path ${JSON.stringify(pathResolution.path)} exists in multiple declared ` +
        `workspaces (${pathResolution.matches.join(', ')}). Re-run with a repo-root-relative or absolute path.`,
    };
  }
  const ingestLedgerInProcess =
    Boolean(opts.workspaceId && opts.harnessSlug) && shouldIngestVitestLedgerInProcess(root);
  const ledgerWorktreeBefore = ingestLedgerInProcess ? captureWorktreeSnapshot(root) : null;

  // EI-21051590601555185: this tool runs inside the long-lived operator process, so it does not
  // pass through scripts/test-files.mjs before creating its private report directory. Apply the
  // same headroom-aware, papercusp-owned TMPDIR policy here; otherwise an exhausted/shared /tmp
  // fails at this mkdtemp call before the router can report a structured result.
  ensurePapercuspTmpdir();
  const dir = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-'));
  const reportPath = join(dir, 'report.json');
  const failureDetailsPath = join(dir, TEST_FAILURE_DETAILS_FILENAME);
  let preserveRunArtifacts = false;
  try {
    const vitestArgs = ['--reporter=json', `--outputFile=${reportPath}`];
    // Vitest treats an explicit --reporter as a replacement for the reporters declared by
    // the workspace config. Keep the admin ledger reporter in the same invocation, otherwise
    // testing:run returns correct counts but silently records no harness_shared.test_runs rows.
    const adminReporterPath = resolveAdminTestRunsReporterPath(root);
    if (adminReporterPath) vitestArgs.push(`--reporter=${adminReporterPath}`);
    // WI-39830: the JOINED form, never `['-t', pattern]`. Split across two argv entries,
    // vitest's CAC parser reads any `-`-prefixed pattern as a new OPTION instead of as `-t`'s
    // value and dies with an opaque CACError — which makes every test in this repo whose name
    // starts with `--` (lint-tsc.test.ts, mutation-probe-script.test.ts, …) unrunnable by name.
    // The router normalizes this too, so the two agree; emitting it correctly here keeps the
    // tool's own contract from depending on a repair one layer down.
    if (opts.testNamePattern) vitestArgs.push(`--testNamePattern=${opts.testNamePattern}`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCUSP_TEST_RUN_GROUP: runId,
      PAPERCUSP_TEST_ATTRIBUTION: '1',
      PAPERCUSP_TEST_FAILURE_DETAILS_PATH: failureDetailsPath,
      ...(opts.harnessSlug && opts.harnessSlug !== '*' ? { PAPERCUSP_TEST_RUN_HARNESS: opts.harnessSlug } : {}),
      ...(opts.workspaceId && opts.workspaceId !== '*' ? { PAPERCUSP_WORKSPACE_ID: opts.workspaceId } : {}),
    };
    // WI-10003090: the router owns a second, inner Vitest watchdog. Its default
    // is 600s for a short file list, even when this caller has a longer budget
    // (scorecard checks have 13m). Derive the child deadline from THIS run's
    // remaining budget so a progressing batch is not reaped by an unrelated
    // default. Leave at most 30s, or 10% for short runs, for the router to
    // report a typed timeout before the outer deadline closes its transport.
    // The router's documented maximum is 120m; this env applies only to the
    // nested invocation, while direct test:file keeps its own CLI default.
    const routerHeadroomMs = Math.min(30_000, Math.floor(timeoutMs / 10));
    childEnv.PAPERCUSP_TEST_FILE_TIMEOUT_MS = String(
      Math.max(1, Math.min(120 * 60_000, timeoutMs - routerHeadroomMs)),
    );
    // `testing:run` can itself be invoked from the repository's pc-heavy
    // wrapper. That wrapper exports a one-shot readiness/finalization marker
    // for its direct child; forwarding those exact paths into this nested
    // router makes it try to publish into the already-owned marker and fail
    // with EEXIST. The nested run owns no outer barrier, so scrub the paths
    // before spawning its router (the sidecar and test-run group remain local
    // to this invocation).
    delete childEnv.PC_HEAVY_PREEMPT_READY_FILE;
    delete childEnv.PC_HEAVY_PSI_FINALIZATION_FILE;
    let directReportPaths: string[] | null = null;
    let outcome: RouterOutcome;
    if (hasRouter) {
      outcome = await runRouter(
        [...pathResolution.files, '--', ...vitestArgs],
        root,
        // The reporter inside the child reads this and stamps run_group_id, so
        // the run's per-file rows are findable afterwards. We write no rows here.
        //
        // P-004: arm coverage attribution for the same child. Stamped unconditionally even
        // though a unit fork cannot use it — the fork disarms itself off the no-real-pg rail
        // (see attribution/context.ts), which is a decision only the fork can make correctly,
        // because one `files` array routinely spans both layers.
        childEnv,
        timeoutMs,
        opts.signal,
        pathResolution.files.length,
      );
    } else {
      const groups = groupDirectVitestRoutes(pathResolution.files, root);
      directReportPaths = groups.map((_, index) => (index === 0 ? reportPath : join(dir, `report.${index}.json`)));
      const deadline = Date.now() + timeoutMs;
      const outcomes: RouterOutcome[] = [];
      for (const [index, group] of groups.entries()) {
        if (opts.signal?.aborted) {
          outcomes.push({
            code: null,
            signal: null,
            timedOut: false,
            aborted: true,
            output: 'caller aborted before direct Vitest group start',
          });
          break;
        }
        const remaining = Math.max(1000, deadline - Date.now());
        const groupArgs = [
          'run',
          ...(group.config ? ['--config', group.config] : []),
          ...vitestArgs.map((arg) =>
            arg.startsWith('--outputFile=') ? `--outputFile=${directReportPaths?.[index] ?? reportPath}` : arg,
          ),
          ...group.files,
        ];
        const groupOutcome = await runDirectVitest(
          groupArgs,
          group.cwd,
          root,
          childEnv,
          remaining,
          opts.signal,
          group.files.length,
        );
        outcomes.push(groupOutcome);
        if (groupOutcome.timedOut || groupOutcome.aborted) break;
      }
      outcome = {
        code: outcomes.some((entry) => entry.code === null) ? null : outcomes.some((entry) => entry.code !== 0) ? 1 : 0,
        signal: outcomes.find((entry) => entry.signal)?.signal ?? null,
        timedOut: outcomes.some((entry) => entry.timedOut),
        aborted: outcomes.some((entry) => entry.aborted),
        output: outcomes
          .map((entry) => entry.output)
          .join('\n')
          .slice(-8192),
      };
    }

    preserveRunArtifacts = outcome.hostShutdownDetached === true;

    if (outcome.aborted) {
      return {
        ok: false,
        runId,
        root,
        error: 'aborted',
        hint: outcome.hostShutdownDetached
          ? `the operator host is shutting down; request ${runId} was released while its confined router continues under systemd ownership. Read its eventual exact test ledger row with testing:runs { runGroup: '${runId}', source: 'local', latestPerFile: false }`
          : 'the caller canceled this foreground test run; its router/Vitest process group was terminated',
        routerOutput: outcome.output.slice(-2000),
      };
    }
    if (outcome.timedOut) {
      const completed = await recoverCompletedRunAfterBudget({
        output: outcome.output,
        dir,
        root,
        runId,
        files: pathResolution.files,
        timeoutMs,
        ...(opts.maxFailures === undefined ? {} : { maxFailures: opts.maxFailures }),
      });
      if (completed) return completed;

      // The foreground process group has already been terminated by
      // runTestProcess. Start a NEW, independently pollable store run for the
      // same router request rather than asking the caller to reconstruct it via
      // a second orchestration surface. `startRun` owns a distinct run id and
      // creates a detached process group of its own. External generic Vitest
      // checkouts have no scripts/test-files.mjs route, so they retain the
      // existing explicit recovery hint until that route can be represented as
      // one store run.
      const detachedStart =
        hasRouter && opts.allowDetachedRecovery !== false
          ? await startRunDurable(
              buildDetachedTestRunRequest({
                root,
                files: pathResolution.files,
                ...(opts.testNamePattern !== undefined ? { testNamePattern: opts.testNamePattern } : {}),
                ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
                ...(opts.harnessSlug !== undefined ? { harnessSlug: opts.harnessSlug } : {}),
                ...(opts.workItemId !== undefined ? { workItemId: opts.workItemId } : {}),
                timeoutMs,
              }),
            )
          : undefined;
      const detachedSnapshot = detachedStart?.snapshot;
      const detachedDurable = detachedStart?.durable === true;
      const detachedRunId = detachedSnapshot?.runId;
      return {
        ok: false,
        runId,
        root,
        error: 'timeout',
        timeoutMs,
        hint:
          `hit the ${(timeoutMs / 1000).toFixed(0)}s budget. ` +
          detachedRecoveryHint({ runId: detachedRunId, durable: detachedDurable }) +
          detachedTestTimeoutHint(opts.files),
        routerOutput: outcome.output.slice(-2000),
        ...(detachedRunId ? { detachedRunId, detachedDurable } : {}),
      };
    }
    // A typed router refusal is still exit 2, but its strict marker distinguishes
    // governed admission starvation from an ordinary route/launch error. Parse
    // only the reserved exit code so a test's arbitrary output cannot manufacture
    // a not-measured result on a successful run.
    if (outcome.code === ROUTER_EXIT_ROUTE_ERROR) {
      const notMeasured = parseRouterNotMeasuredMarker(outcome.output);
      if (notMeasured) {
        return {
          ok: false,
          runId,
          root,
          error: 'not_measured',
          ...notMeasured,
          routerOutput: outcome.output.slice(-2000),
        };
      }
    }
    // Name-filter and all-skipped refusals intentionally retain their report so
    // the typed branches below can explain the vacuous run. Every other exit-2
    // result has no trustworthy report and remains the existing route_error.
    const hasReportBackedRefusal = /^(?:TEST_FILE_NAME_FILTER_NO_MATCH|TEST_FILE_ALL_SKIPPED)\b/m.test(outcome.output);
    if ((outcome.code === ROUTER_EXIT_ROUTE_ERROR && !hasReportBackedRefusal) || outcome.code === null) {
      return { ok: false, runId, root, error: 'route_error', routerOutput: outcome.output.slice(-2000) };
    }

    // EI-18822211427354845: the router runs ONE `vitest run` per owning workspace
    // config, so a request spanning several workspaces writes SEVERAL reports —
    // `report.json`, `report.0.json`, `report.1.json`, … Reading only `reportPath`
    // distilled whichever group happened to write last and reported it as the whole
    // run: a two-workspace request with a RED first group returned `failed:0,
    // failures:[]`. `dir` is a private mkdtemp this function owns, so every *.json in
    // it belongs to THIS run and can be merged without any output parsing.
    if (directReportPaths?.some((path) => !existsSync(path))) {
      return {
        ok: false,
        runId,
        root,
        error: 'no_report',
        routerOutput: outcome.output.slice(-2000),
      };
    }

    let reportTexts: string[];
    try {
      const names = (await readdir(dir))
        .filter((n) => n.endsWith('.json') && n !== TEST_FAILURE_DETAILS_FILENAME)
        .sort();
      reportTexts = (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8').catch(() => null)))).filter(
        (t): t is string => t !== null,
      );
    } catch {
      reportTexts = [];
    }
    if (reportTexts.length === 0) {
      // Registered node:test files run through scripts/test-files.mjs and do
      // not produce Vitest's JSON report. Their terminal TEST_FILE_RESULT
      // plus Node's numeric summary is still a complete, structured verdict;
      // use it before treating the missing JSON file as a false-green refusal.
      const routerResult = parseRouterTestResult(outcome.output, pathResolution.files, {
        ...(opts.maxFailures !== undefined ? { maxFailures: opts.maxFailures } : {}),
      });
      if (routerResult) {
        const executedNothing = zeroExecutedRefusal(routerResult, { runId, root });
        if (executedNothing) return executedNothing;
        return boundTestRunPayload(
          { ok: routerResult.failed === 0 && outcome.code === 0, runId, root },
          routerResult,
        ) as TestFilesCoreResult;
      }
      // Exit 1 with no report is the REFUSED false-green (the router bailed
      // before running anything) — the one case where "no results" is the
      // answer, and must never read as a pass.
      return { ok: false, runId, root, error: 'no_report', routerOutput: outcome.output.slice(-2000) };
    }

    let failureDetails = [] as ReturnType<typeof parseFailureDetailsSidecar>;
    try {
      failureDetails = parseFailureDetailsSidecar(await readFile(failureDetailsPath, 'utf8'), root);
    } catch {
      // The sidecar is optional and fail-soft; JSON reports remain authoritative.
    }

    const distilledRuns = withNodeTestGroupRuns(
      reportTexts.map((text) => distillVitestRun(text, root, { maxFailures: opts.maxFailures, failureDetails })),
      outcome.output,
      pathResolution.files,
      opts.maxFailures !== undefined ? { maxFailures: opts.maxFailures } : {},
    );
    const emptyReport = emptyDistilledRunRefusal({
      runs: distilledRuns,
      runId,
      root,
      routerOutput: outcome.output,
    });
    if (emptyReport) return emptyReport;
    const run = mergeDistilledRuns(distilledRuns, { maxFailures: opts.maxFailures });

    // External Vitest checkouts have no Papercusp reporter to write the
    // workspace-scoped execution ledger. Reuse the Tests-tab ingestion
    // primitives over the exact JSON reports we already distilled; the write
    // happens in the operator process, where the database handle is known, and
    // only when no child reporter exists so a managed checkout cannot double-
    // record the same run group.
    if (ingestLedgerInProcess && ledgerWorktreeBefore && opts.workspaceId && opts.harnessSlug) {
      const ledgerWorktreeAfter = captureWorktreeSnapshot(root);
      const rows = reportTexts.flatMap((text) => parseVitestJsonForHarnessRows(text, root));
      await persistHarnessTestRuns({
        harnessSlug: opts.harnessSlug,
        workspaceId: opts.workspaceId,
        rows,
        runGroupId: runId,
        source: 'local',
        commit: ledgerWorktreeAfter.commit,
        worktreeDirty: computeWorktreeDirty(ledgerWorktreeBefore, ledgerWorktreeAfter),
        root,
        testNamePattern: opts.testNamePattern ?? null,
      });
    }

    // EI-19425177453558152: a `testNamePattern` matching ZERO tests measured NOTHING, yet every
    // test is merely SKIPPED and vitest exits 0 — so this used to return a green.
    //
    // The router carries its own refusal for this, but it reads vitest's `Tests` summary row
    // from stdout and THIS path always passes `--reporter=json`, so no such row exists and the
    // router's check correctly fails open. That is why the check is repeated here rather than
    // delegated: at this layer the distilled report gives an EXACT executed count, which is a
    // strictly better signal than any output parse. (Measured: with only the router's check,
    // this path still returned ok:true.)
    //
    // `skipped` is deliberately not required to be > 0 — the point is that nothing RAN.
    if (opts.testNamePattern && run.passed + run.failed === 0) {
      return nameFilterNoMatchRefusal({
        pattern: opts.testNamePattern,
        skipped: run.skipped,
        files: run.files,
        runId,
        root,
      });
    }
    // The same vacuous-run class as the refusal above, arrived at WITHOUT a name filter:
    // every collected test was skipped (an env-gated suite whose variable is unset), so this
    // run executed nothing. See zeroExecutedRefusal.
    const executedNothing = zeroExecutedRefusal(run, { runId, root });
    if (executedNothing) return executedNothing;

    // D-062: bound the payload in BYTES, not entries. `maxFailures` caps the
    // LIST COUNT and so cannot bound bytes at all — one long assertion diff
    // outweighs fifty terse failures. Counts stay complete and a cut is stated
    // explicitly, so `failures.length` is never readable as "how many failed".
    return boundTestRunPayload({ ok: run.failed === 0 && outcome.code === 0, runId, root }, run) as TestFilesCoreResult;
  } finally {
    if (!preserveRunArtifacts) {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  }
}

export default defineTool({
  name: 'testing:run',
  description:
    'Run exact Vitest files through the Papercusp router or a discovered external npm-workspace Vitest checkout and return distilled counts plus bounded failures. Files may be repo-root-relative, absolute, or relative to exactly one declared npm workspace; ambiguous workspace-relative paths refuse before execution. `root` reports the checkout actually tested. Zero/partial matches and invalid checkouts refuse instead of passing vacuously. `failed` is the true total; when `failuresTruncated` is set, read `failuresOmitted`. A Papercusp-router timeout starts a pollable detached recovery, returns `detachedRunId`, and tells you to call `testing:run-status { runId }` for its snapshot. Stamps PAPERCUSP_TEST_RUN_GROUP for ledger correlation.',
  guidance: {
    when: 'You edited code and want to know whether specific test files pass, and which tests failed and why. The default way to run named test files.',
    notWhen:
      'Running everything your edits affected (use `npm run test:affected` — not covered here), a non-Vitest suite (cargo/playwright), or when you genuinely need raw reporter output.',
    chaining:
      'testing:run → use `byFile[path].runId` to bind a file to its exact row. The legacy `testRunIds[]` is ordered by ID, not by `files[]`; never zip them. A red here is real (the router refuses false-greens); testing:flakiness { } tells you whether a failing file is a known flake.',
  },
  capability: 'testing:run',
  // Running tests starts a governed process and writes evidence rows. The
  // capability suffix `run` otherwise infers `read`, which makes the MCP
  // transport skip idempotency replay and re-execute a timed-out call.
  effect: 'write',
  requirePrincipal: false,
  // EI-18803497769946984: the handler shells out to Vitest and blocks for the whole
  // run without ever reading `ctx.tx`. Holding the ambient workspace transaction
  // across that wait trips idle_in_transaction_session_timeout (60s), surfacing as a
  // bare `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // Acceptance judges must independently reproduce rubric checks before emitting a
  // verdict. The dedicated capability grant stays inert for every other tool.
  agentRoles: [...AGENT_ROLES, 'judge'],
  args: z.object({
    recheckReason: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .optional()
      .describe(
        'Why a repeat test is needed despite unchanged source/test fingerprints, for example an environment repair; keeps the repetition advisory from treating this as an unexplained rerun.',
      ),
    evidence: testEvidenceSchema
      .optional()
      .describe(
        'Declare exact work-item/spec/test/correction mappings once; persisted before execution and returned as ledger-backed evidence for independent review. evidenceRef uses the original attempt ID and stays stable across timeout recovery; join testing:runs through rows[].testRunId or rows[].ledgerRunGroupId, which may name a detached group.',
      ),
    recoverEvidence: recoverTestEvidenceSchema
      .optional()
      .describe(
        'Use the exact recovery args from an evidenceBundle to recover saved mappings and ledger outcomes; starts no new test process.',
      ),
    remeasureEvidence: remeasureTestEvidenceSchema
      .optional()
      .describe(
        "Re-run ONLY this work-item's test proofs whose measured source/test files moved, from their saved recipes; a replaced stale row is retracted only after its fresh run passes. Use instead of files/evidence.",
      ),
    files: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Test file paths (repo-root-relative, absolute, or relative to exactly one declared npm workspace). Each is routed to its owning workspace + Vitest config; ambiguous workspace-relative paths and paths matching zero tests fail the call rather than passing vacuously.',
      ),
    changedPaths: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe(
        'SOURCE paths you edited (not test files) — returns the `npm run test:affected` PLAN and runs NOTHING (`mode:"plan"`, no pass/fail counts). ~0.4s, no admission ticket, where the real sweep can queue for minutes and be SIGTERMed having measured zero files. Gives the affected workspaces, each exact runnable task command, and the attached guards, so you can pick: run specific test files via `files`, run one `taskCommands[].command` verbatim, or accept the queue. Mutually exclusive with `files`.',
      ),
    testNamePattern: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Run only tests whose full name matches — a REGEX (Vitest `-t`), never literal text. To re-run ONE failing test from a previous result's `failures[].test`, regex-escape it first: a name containing `(`, `+` or `[` does not match itself. A pattern matching ZERO tests is REFUSED (`name_filter_no_match`) and hands back the escaped form to retry, never reported as a pass — vitest merely skips them all and exits 0.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Hard budget for the whole run. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so a slow suite returns an actionable timeout instead of an opaque transport error. For a longer suite, follow the timeout response's detached recovery; integration files use the npm run test:file router.`,
      ),
    maxFailures: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        `Cap the returned failures list (default 20). Counts stay complete; \`failuresTruncated\` flags the cut. Note this caps the LIST COUNT, not bytes — the result is separately bounded to ${TESTING_RUN_MAX_PAYLOAD_BYTES} B, which is what actually limits a run with huge assertion diffs.`,
      ),
    harness: harnessArg.describe(
      'Concrete harness whose workspace-scoped test ledger rows should be stamped and returned as bindable testRunIds. Omit for an unscoped run.',
    ),
  }),
  async handler(args, ctx) {
    if (args.recoverEvidence) {
      if (args.files || args.changedPaths || args.evidence || args.remeasureEvidence)
        return { data: { ok: false, error: 'mutually_exclusive_selectors' } };
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug || !ctx.workspaceId || ctx.workspaceId === '*')
        return { data: { ok: false, error: 'evidence_requires_concrete_scope' } };
      try {
        const evidenceBundle = await recoverTestEvidence(args.recoverEvidence, {
          root: resolveAgentWorkspaceRoot(ctx),
          harnessSlug,
          workspaceId: ctx.workspaceId,
          actorId: resolveAgentIdentity(ctx).ownerId,
        });
        return { data: { ok: true, mode: 'evidence-recovery', evidenceBundle } };
      } catch (error) {
        return { data: { ok: false, error: 'evidence_recovery_failed', message: String(error) } };
      }
    }
    // P-018 / P-011: a re-measure derives BOTH the files and the evidence mapping from the
    // work-item's persisted stale bindings, then runs through the ordinary evidence path
    // below — so it inherits every guard that path already has instead of forking one.
    let remeasure: Awaited<ReturnType<typeof buildTestEvidenceRemeasure>> | undefined;
    if (args.remeasureEvidence) {
      if (args.files || args.changedPaths || args.evidence)
        return { data: { ok: false, error: 'mutually_exclusive_selectors' } };
      const remeasureHarness = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!remeasureHarness || !ctx.workspaceId || ctx.workspaceId === '*')
        return { data: { ok: false, error: 'evidence_requires_concrete_scope' } };
      try {
        remeasure = await buildTestEvidenceRemeasure(args.remeasureEvidence, { harnessSlug: remeasureHarness });
      } catch (error) {
        return { data: { ok: false, error: 'evidence_remeasure_plan_failed', message: String(error) } };
      }
      if (!remeasure.request) {
        // Nothing curable is stale: start no process. `skipped` says why per binding —
        // `current` is the good answer; `clause-moved` / `not-remeasurable` need a human;
        // `no-recipe` / `probe-required` name stale proofs this pass cannot re-run itself.
        return {
          data: {
            ok: true,
            mode: 'evidence-remeasure',
            ran: false,
            summary: remeasure.summary,
            skipped: remeasure.plan.skipped.slice(0, 20),
          },
        };
      }
    }
    const evidenceRequest = args.evidence ?? remeasure?.request ?? undefined;
    const selectedFiles = args.files ?? remeasure?.files;
    // Exactly one selector. Both branches REFUSE rather than defaulting, because every
    // default here is a silent wrong answer: picking `files` when both were sent would
    // ignore a radius the caller asked to see, and treating neither as "run everything"
    // is the zero/partial-match false-green this whole tool exists to refuse.
    const wantsPlan = args.changedPaths !== undefined;
    if (wantsPlan && selectedFiles !== undefined) {
      return {
        data: {
          ok: false,
          error: 'mutually_exclusive_selectors',
          detail:
            'Pass `files` (run exact test files) OR `changedPaths` (derive the test:affected plan; runs nothing), never both.',
        },
      };
    }
    if (!wantsPlan && selectedFiles === undefined) {
      return {
        data: {
          ok: false,
          error: 'no_selector',
          detail:
            'Pass `files` with the exact test files to run, or `changedPaths` with the SOURCE files you edited to see what verifying them would run.',
        },
      };
    }
    if (args.changedPaths !== undefined) {
      if (args.evidence) return { data: { ok: false, error: 'evidence_requires_executed_files' } };
      // The plan path deliberately does NOT go through selectTestFileRoot: that resolver
      // answers "which checkout owns these TEST files", and changedPaths are source files
      // that need not have a test file anywhere. The agent's own workspace root is the
      // tree it is editing, which is the tree whose radius it is asking about.
      const plan = await deriveAffectedPlan({
        changedPaths: args.changedPaths,
        root: resolveAgentWorkspaceRoot(ctx),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return { data: plan };
    }
    const files = selectedFiles as string[];
    // EI-1754, again: this tool must judge the tree the AGENT is editing, not the
    // one the operator happens to run from. `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout
    // (papercup-release, pinned to green `main`) — so a superuser's testing:run
    // routed every path into the RELEASE tree. Two failure modes, and the silent
    // one is the dangerous one: a test file present in BOTH trees ran against the
    // stale release copy and came back GREEN for an edit it never saw; a
    // staging-only NEW test file came back `route_error: does not exist`.
    // `resolveCapabilityBaseDir` is the same projectDir → PAPERCUSP_INTEGRATION_ROOT
    // → cwd resolver every capability tool (read/write/edit/bash/inspect) already
    // uses, so this tool now reads the same tree those tools write.
    const rootSelection = selectTestFileRoot(files, resolveAgentWorkspaceRoot(ctx));
    // EI-18776865728050036 — same clamp as build:typecheck, for the same reason: this tool is
    // dispatched FOREGROUND over an MCP transport that hard-caps a call at ~55s (EI-6073), so a
    // suite slower than that had the call killed before the core's `error:'timeout'` branch could
    // return, surfacing as an opaque `CONNECTION_CLOSED`. Clamping makes this handler win the
    // race and hand back an actionable next step. The clamp is a TRANSPORT concern, so it lives
    // here and not in runTestFilesCore (whose other callers budget for themselves).
    const requestedTimeoutMs = args.timeoutMs;
    const timeoutMs = clampForegroundTimeoutMs(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Operator/superuser sessions commonly carry the '*' harness sentinel. Let
    // the caller name the concrete harness on this call so the child reporter
    // receives the same scope that plans:bind-spec-evidence validates.
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    const runId = randomUUID();
    const evidenceScope =
      evidenceRequest && harnessSlug && ctx.workspaceId && ctx.workspaceId !== '*'
        ? {
            root: rootSelection.root,
            harnessSlug,
            workspaceId: ctx.workspaceId,
            actorId: resolveAgentIdentity(ctx).ownerId,
          }
        : null;
    if (evidenceRequest && !evidenceScope) return { data: { ok: false, error: 'evidence_requires_concrete_scope' } };
    // expensive-verification-loops P-001: a run that outlives the foreground clamp
    // continues detached, and that detached run is the expensive attempt the loop
    // detector counts per work-item. An evidence request names its item explicitly;
    // otherwise use the caller's unambiguous held claim — the same rule capability:bash
    // applies, so one agent's runs link identically through either door.
    const attemptWorkItemId =
      evidenceRequest?.workItemId ??
      (await resolveBashTaskProvenance(ctx as unknown as ResolveIdentityCtx, harnessSlug ?? null)).workItemId ??
      undefined;
    // P-002 (WI-10004175): the loop gate capability:bash and release:cut apply. Its budget is
    // the REQUESTED one, not the foreground clamp, because the detached run keeps going past
    // the clamp; a run asked for <= SLOW_ATTEMPT_MIN_MS stays free for an audit's quick checks.
    // Checked before evidence preparation so a refusal registers no pending rows.
    const loopRefusal = await loopLaunchRefusal({
      workspaceId: ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : null,
      workItemId: attemptWorkItemId,
      background: false,
      timeoutMs: requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (loopRefusal) return { data: { ...loopRefusal, runId, root: rootSelection.root } };
    let prepared: Awaited<ReturnType<typeof prepareTestEvidence>> | undefined;
    if (evidenceRequest) {
      const selected = normalizeTestFilePaths(files, rootSelection.root);
      // EI-24100872054224181: refuse BEFORE registering pending rows. The core repeats
      // this preflight; a refusal there after preparation is retracted below.
      const mutationProbe = await mutationProbeRefusal(rootSelection.root, selected.ok ? selected.files : files);
      if (mutationProbe) return { data: { ok: false, runId, root: rootSelection.root, ...mutationProbe } };
      try {
        if (!selected.ok) throw new Error('evidence_test_selection_unresolved');
        prepared = await prepareTestEvidence(evidenceRequest, runId, selected.files, evidenceScope!);
      } catch (error) {
        return { data: { ok: false, error: 'evidence_preparation_failed', message: String(error) } };
      }
    }
    const result = await runTestFilesCore({
      files,
      runId,
      root: rootSelection.root,
      timeoutMs,
      signal: ctx.signal,
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
      ...(harnessSlug ? { harnessSlug } : {}),
      ...(attemptWorkItemId ? { workItemId: attemptWorkItemId } : {}),
      ...(args.maxFailures !== undefined ? { maxFailures: args.maxFailures } : {}),
      ...(args.testNamePattern !== undefined ? { testNamePattern: args.testNamePattern } : {}),
    });
    const testRunIdsReadback =
      shouldResolveHarnessTestRunIds(result) && ctx.workspaceId && ctx.workspaceId !== '*' && harnessSlug
        ? await readHarnessTestRunIdsBounded({
            workspaceId: ctx.workspaceId,
            harnessSlug,
            runGroupId: result.runId,
          }, result.error === undefined
            ? { root: result.root, roots: result.roots, byFile: result.byFile }
            : {})
        : null;
    // Evidence needs to distinguish tests intentionally excluded by an explicit
    // name selector from tests that were actually skipped by the suite. Keep the
    // marker internal to the evidence path so the public run payload remains the
    // stable distilled result shape.
    const evidenceResult =
      result.error === undefined && args.testNamePattern !== undefined
        ? { ...result, testNamePattern: args.testNamePattern }
        : result;
    const evidenceRunId = testEvidenceRecoveryRunId(runId, result);
    const surfacedResult = {
      ...result,
      ...(testRunIdsReadback?.ids === null ? {} : { testRunIds: testRunIdsReadback?.ids }),
      ...(result.error === undefined && testRunIdsReadback?.idsByFile !== null
        && testRunIdsReadback?.idsByFile !== undefined
        ? {
            byFile: Object.fromEntries(Object.entries(result.byFile).map(([filePath, counts]) => {
              const runId = testRunIdsReadback?.idsByFile?.[filePath];
              return [filePath, runId === undefined ? counts : { ...counts, runId }];
            })),
          }
        : {}),
      ...(testRunIdsReadback?.degraded
        ? {
            testRunIdsReadback: {
              status: 'unknown' as const,
              retryable: true,
              reason: testRunIdsReadback.reason ?? 'error',
              timeoutMs: TEST_RUN_ID_READBACK_TIMEOUT_MS,
              elapsedMs: testRunIdsReadback.elapsedMs,
              message:
                'The test verdict completed, but its optional harness test-run ID readback did not complete; ' +
                'testRunIds are omitted rather than reported as an empty list. Re-read testing:runs by runGroup if binding is required.',
            },
          }
        : {}),
      rootSource: rootSelection.source,
      ...(prepared
        ? {
            evidenceBundle: result.error === 'timeout'
              ? deferredTestEvidenceRecoveryBundle(evidenceRequest!, runId, evidenceRunId, evidenceScope!.harnessSlug)
              : result.error !== undefined && PRE_LAUNCH_REFUSALS.has(result.error)
                ? await retractRefusedTestEvidence(prepared, runId, evidenceScope!, result.error).catch((error) => ({
                    status: 'retirement-incomplete' as const, reason: result.error, message: String(error),
                  }))
              : await finishTestEvidence(
                  prepared,
                  runId,
                  evidenceRunId,
                  evidenceScope!,
                  evidenceResult,
                ).catch((error) => ({
                  status: 'incomplete',
                  acceptance: 'requires-review',
                  message: String(error),
                  recovery: {
                    tool: 'testing:run',
                    args: {
                      harness: harnessSlug,
                      recoverEvidence: {
                        workItemId: evidenceRequest!.workItemId,
                        planSlug: evidenceRequest!.planSlug,
                        originRunId: runId,
                        runId: evidenceRunId,
                      },
                    },
                  },
                })),
          }
        : {}),
    };
    // Retire a replaced stale predecessor only once its fresh run has a known outcome; a
    // detached/timed-out run is recovered later through the ordinary recovery path.
    const remeasureReport =
      remeasure && prepared && evidenceScope
        ? {
            summary: remeasure.summary,
            selected: remeasure.plan.selected
              .map(({ binding: _binding, supersedes: _supersedes, ...entry }) => entry)
              .slice(0, 20),
            skipped: remeasure.plan.skipped.slice(0, 20),
            retired:
              result.error === undefined
                ? await retireRemeasuredPredecessors(remeasure.plan.selected, prepared, runId, evidenceScope).catch(
                    (error) => [{ error: String(error) }],
                  )
                : [],
          }
        : undefined;
    const finalResult = remeasureReport ? { ...surfacedResult, remeasure: remeasureReport } : surfacedResult;
    if (result.ok === false && result.error === 'timeout') {
      return {
        data: {
          ...finalResult,
          hint:
            `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). ` +
            testingRunTimeoutClampDisclosure(requestedTimeoutMs, timeoutMs) +
            // EI-24207525450988644: an evidence run recovers in ONE call — recoverEvidence
            // waits for the detached run itself — so steer away from a run-status loop.
            (prepared && result.detachedRunId
              ? 'To bind this evidence, call evidenceBundle.recovery (testing:run { recoverEvidence }) now: it waits up to ' +
                `${Math.round(RECOVERY_WAIT_DEFAULT_MS / 1000)}s for the detached run and binds in the same call; skip testing:run-status polling. `
              : detachedRecoveryHint({
                  runId: result.detachedRunId,
                  durable: result.detachedDurable === true,
                })) +
            detachedTestTimeoutHint(files),
        },
      };
    }
    return { data: finalResult };
  },
});
