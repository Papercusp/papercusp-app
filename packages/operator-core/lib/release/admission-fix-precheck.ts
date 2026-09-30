/**
 * P-006 / R6 (green-gate-zero-wait-convergence-2026-09-08, D-002): the ADMISSION FIX PRE-CHECK.
 *
 * Before the repair-queue admit door PUBLISHES an admission onto the frozen lineage, it runs the
 * frozen signature's `test-file` entries plus any admitted test files at the BUILT (still
 * unpublished) admission commit, and refuses:
 *
 *   - `admission-imports-red`   — an admitted test file OUTSIDE the signature fails at the built
 *                                 commit: the admission would import a new red into the lineage.
 *   - `admission-does-not-fix`  — the signature consists ONLY of `test-file` entries and NONE of
 *                                 them pass at the built commit: the admission fixes nothing it
 *                                 claims to. When the signature carries other kinds (lint-leg,
 *                                 workspace-task, post-suite-leg, seed) a test run cannot prove
 *                                 "fixes nothing", so only imports-red applies.
 *
 * Unmeasured files (route error, matched=0, runner crash) NEVER count as passing.
 *
 * The pre-check uses its own checkout beside the gate's checkpoint tree. A gate run that is
 * already active still reports `checkpoint-tree-busy` and the door ACCEPTS the admission with a
 * loud `precheck:{ran:false}` marker — the R-1 event-driven re-judge measures it. A gate run
 * starting later cannot re-pin the pre-check's checkout midway through its test files.
 *
 * Layering: `precheckPopulation` + `evaluateFixPrecheck` are PURE (unit-tested without a tree);
 * `FixPrecheckRunner` is the seam the door injects; `createCheckpointTreeFixPrecheckRunner` is
 * the real runner (setup-release-checkout into its dedicated checkout,
 * `scripts/test-files.mjs` per file), guarded by the gate's initial run-lock probe.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepairSignatureEntry, RepairSignatureKind } from './frozen-candidate-repair-queue';
import { isCheckpointRunLockHeldCheap } from '../release-checkpoint-launch';

export const ADMISSION_PRECHECK_REFUSALS = Object.freeze([
  'admission-does-not-fix',
  'admission-imports-red',
  'admission-precheck-unavailable',
] as const);
export type AdmissionPrecheckRefusalCode = (typeof ADMISSION_PRECHECK_REFUSALS)[number];

/** A repo-relative path the test router would run as a test file. */
export const TEST_FILE_RE = /\.(?:integration\.)?(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFilePath(p: string): boolean {
  return TEST_FILE_RE.test(p);
}

export type SignatureLike = Pick<RepairSignatureEntry, 'kind' | 'id'> & Partial<Pick<RepairSignatureEntry, 'workspace'>>;

export interface FixPrecheckPopulation {
  /** Signature `test-file` ids — the reds the admission claims to fix. */
  signatureTestFiles: string[];
  /** Admitted paths that are test files and NOT in the signature — a fresh red here is an import. */
  admittedTestFiles: string[];
  /** Signature kinds other than `test-file` present (each defeats the does-not-fix proof). */
  nonTestKinds: RepairSignatureKind[];
  /** True only when the signature is non-empty and consists solely of `test-file` entries. */
  canProveDoesNotFix: boolean;
  /** Union of both file sets, in run order (signature first). */
  files: string[];
}

function normalize(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function precheckPopulation(input: {
  signature: readonly SignatureLike[];
  admittedPaths: readonly string[];
}): FixPrecheckPopulation {
  const signatureTestFiles: string[] = [];
  const nonTestKinds = new Set<RepairSignatureKind>();
  for (const entry of input.signature) {
    if (entry.kind === 'test-file') {
      const id = normalize(entry.id);
      if (id && !signatureTestFiles.includes(id)) signatureTestFiles.push(id);
    } else {
      nonTestKinds.add(entry.kind);
    }
  }
  const admittedTestFiles: string[] = [];
  for (const raw of input.admittedPaths) {
    const p = normalize(raw);
    if (!p || !isTestFilePath(p)) continue;
    if (signatureTestFiles.includes(p) || admittedTestFiles.includes(p)) continue;
    admittedTestFiles.push(p);
  }
  return {
    signatureTestFiles,
    admittedTestFiles,
    nonTestKinds: [...nonTestKinds],
    canProveDoesNotFix: signatureTestFiles.length > 0 && nonTestKinds.size === 0,
    files: [...signatureTestFiles, ...admittedTestFiles],
  };
}

export type FixPrecheckFileStatus = 'pass' | 'fail' | 'unmeasured';

export interface FixPrecheckFileResult {
  path: string;
  status: FixPrecheckFileStatus;
  /** Why an `unmeasured` file could not be judged (route error, matched=0, timeout, crash). */
  detail?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export type FixPrecheckBusyReason = 'checkpoint-tree-busy';

export type FixPrecheckRunResult =
  | { ran: true; commit: string; results: FixPrecheckFileResult[]; setup?: { durationMs: number } }
  | { ran: false; reason: FixPrecheckBusyReason; detail: string; holder?: { pid?: number; elapsedSec: number | null } }
  | { ran: false; reason: 'runner-failed'; detail: string };

/** A durable liveness snapshot for the file currently being measured. */
export interface FixPrecheckProgress {
  /** Repo-relative file whose test process is about to run. */
  currentFile: string;
  /** Number of files that completed before `currentFile` started. */
  completedCount: number;
  /** Total files in this pre-check operation. */
  totalCount: number;
  /** Wall-clock time at which this snapshot was observed. */
  heartbeatAtMs: number;
}

/**
 * The progress callback is observability only: a failed persistence attempt must not turn a
 * measured test result into a runner failure. Implementations should nevertheless await their
 * CAS write so `op:get` sees the snapshot before the corresponding test process starts.
 */
export type FixPrecheckProgressCallback = (progress: FixPrecheckProgress) => Promise<void> | void;

/** The seam the admit door injects: measure `files` at `commit` (a real, unpublished object in the root's store). */
export type FixPrecheckRunner = (input: {
  commit: string;
  files: readonly string[];
  onProgress?: FixPrecheckProgressCallback;
}) => Promise<FixPrecheckRunResult>;

export type FixPrecheckVerdict =
  | {
      ok: true;
      ran: true;
      commit: string;
      population: FixPrecheckPopulation;
      results: FixPrecheckFileResult[];
      passing: string[];
      failing: string[];
      unmeasured: string[];
      /** Signature test files that pass at the built commit — what the admission provably fixes. */
      fixes: string[];
    }
  | { ok: true; ran: false; reason: 'nothing-to-run'; population: FixPrecheckPopulation }
  | {
      ok: true;
      ran: false;
      reason: FixPrecheckBusyReason;
      detail: string;
      population: FixPrecheckPopulation;
      holder?: { pid?: number; elapsedSec: number | null };
    }
  | {
      ok: false;
      ran: false;
      code: 'admission-precheck-unavailable';
      reason: 'runner-failed';
      detail: string;
      population: FixPrecheckPopulation;
    }
  | {
      ok: false;
      ran: true;
      commit: string;
      code: AdmissionPrecheckRefusalCode;
      detail: string;
      population: FixPrecheckPopulation;
      results: FixPrecheckFileResult[];
      passing: string[];
      failing: string[];
      unmeasured: string[];
      /** Admitted-outside-signature test files that fail (the imports-red set), always reported. */
      importedRed: string[];
      /** Whether BOTH refusals apply — `code` names the primary one. */
      alsoImportsRed: boolean;
    };

/**
 * Pure verdict. `admission-does-not-fix` is checked first (the admission's stated purpose), then
 * `admission-imports-red`; when both hold, `code` is does-not-fix and `alsoImportsRed:true`.
 */
export function evaluateFixPrecheck(population: FixPrecheckPopulation, run: FixPrecheckRunResult): FixPrecheckVerdict {
  if (population.files.length === 0) return { ok: true, ran: false, reason: 'nothing-to-run', population };
  if (!run.ran) {
    return run.reason === 'runner-failed'
      ? {
          ok: false,
          ran: false,
          code: 'admission-precheck-unavailable',
          reason: 'runner-failed',
          detail:
            `the admission pre-check runner failed before it could measure the built commit: ${run.detail}; ` +
            'nothing may be published without either a measured result, the checkpoint-tree-busy exception, or an explicit reasoned skipPrecheck opt-out',
          population,
        }
      : { ok: true, ran: false, reason: run.reason, detail: run.detail, population, ...(run.holder ? { holder: run.holder } : {}) };
  }
  const byPath = new Map(run.results.map((r) => [normalize(r.path), r] as const));
  const results: FixPrecheckFileResult[] = population.files.map(
    (p) => byPath.get(p) ?? { path: p, status: 'unmeasured', detail: 'the runner returned no result for this file' },
  );
  const passing = results.filter((r) => r.status === 'pass').map((r) => r.path);
  const failing = results.filter((r) => r.status === 'fail').map((r) => r.path);
  const unmeasured = results.filter((r) => r.status === 'unmeasured').map((r) => r.path);
  const fixes = population.signatureTestFiles.filter((p) => passing.includes(p));
  const importedRed = population.admittedTestFiles.filter((p) => failing.includes(p));
  const doesNotFix = population.canProveDoesNotFix && fixes.length === 0;
  const importsRed = importedRed.length > 0;
  const base = { ran: true as const, commit: run.commit, population, results, passing, failing, unmeasured };
  if (doesNotFix) {
    const unmeasuredNote = unmeasured.length
      ? ` (${unmeasured.length} unmeasured — an unmeasured file never counts as passing)`
      : '';
    return {
      ok: false,
      ...base,
      code: 'admission-does-not-fix',
      detail:
        `none of the ${population.signatureTestFiles.length} signature test file(s) pass at the built admission commit ` +
        `${run.commit.slice(0, 12)}${unmeasuredNote}; the admission fixes nothing the frozen queue is red about` +
        (importsRed ? `, and it also imports ${importedRed.length} new red test file(s): ${importedRed.join(', ')}` : ''),
      importedRed,
      alsoImportsRed: importsRed,
    };
  }
  if (importsRed) {
    return {
      ok: false,
      ...base,
      code: 'admission-imports-red',
      detail:
        `${importedRed.length} admitted test file(s) outside the frozen signature fail at the built admission commit ` +
        `${run.commit.slice(0, 12)}: ${importedRed.join(', ')} — the admission would import a new red onto the lineage`,
      importedRed,
      alsoImportsRed: false,
    };
  }
  return { ok: true, ...base, fixes };
}

// ─── the real runner ─────────────────────────────────────────────────────────────────────────

/** `git rev-parse --git-common-dir` for `root`, absolute; null when git cannot answer. */
export const defaultGitCommonDir = (root: string): string | null => {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
};

/**
 * The MAIN worktree of the repository `root` belongs to — the root whose `.git` is a directory.
 *
 * The admit door's `integrationRoot()` is whatever tree the serving host runs from, and on the
 * `:3170` staging host that is `…/papercusp-staging`, a LINKED worktree whose `.git` is a
 * gitdir FILE. Handing that root to the checkpoint-tree runner breaks all three of its legs at
 * once (measured 2026-09-11 on the d5c9f96b admission): `setup-release-checkout.sh` refuses it
 * (`-d "$INTEGRATION_ROOT/.git"`, exit 1 → `runner-failed` → the door fails OPEN and publishes
 * unmeasured), `checkpointRootMirror` of it names a `…-staging-checkpoint` tree that does not
 * exist, and the run-lock probe looks beside the wrong root so a live gate run reads as idle.
 * Every linked worktree shares the main worktree's object store, so the unpublished admission
 * commit is reachable from the canonical root by construction. A root git cannot classify is
 * returned unchanged (the runner then reports the failure loudly rather than guessing).
 */
export function resolveCanonicalIntegrationRoot(root: string, gitCommonDir: (root: string) => string | null = defaultGitCommonDir): string {
  const common = gitCommonDir(root);
  if (!common) return root;
  const abs = path.resolve(root, common);
  return path.basename(abs) === '.git' ? path.dirname(abs) : root;
}

export interface CheckpointTreeRunnerOptions {
  /** The canonical integration checkout (where the unpublished commit object lives). */
  integrationRoot: string;
  /** The gate's isolated checkout — setup-release-checkout materializes `commit` here. */
  checkpointRoot: string;
  /** Per-file wall-clock budget (default 10 min). */
  perFileTimeoutMs?: number;
  /** Setup budget (default 20 min — dependency materialization can take minutes). */
  setupTimeoutMs?: number;
  /** Injectable for tests: is a gate run holding the checkpoint tree right now? */
  runLockHeld?: (root: string) => { held: boolean; pid?: number; elapsedSec: number | null };
  /** Injectable for tests: run one child and capture its exit + output. */
  exec?: (argv: readonly string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;
  log?: (line: string) => void;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

export const defaultExec: NonNullable<CheckpointTreeRunnerOptions['exec']> = (argv, opts) =>
  new Promise<ExecResult>((resolve) => {
    const startedAt = Date.now();
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    let size = 0;
    const collect = (buf: Buffer) => {
      if (size > 256_000) return;
      const s = buf.toString('utf8');
      size += s.length;
      chunks.push(s);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, output: `${chunks.join('')}\n${err.message}`, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, output: chunks.join(''), durationMs: Date.now() - startedAt });
    });
  });

/**
 * Router exit codes that MEASURED NOTHING. The contract lives in
 * `scripts/lib/test-file-exit-codes.mjs` (only 0 = passed and 1 = failed are measured);
 * 2 = NOT MEASURED (route/launch/admission error, watchdog reap, every collected test
 * skipped) and 75 = EX_TEMPFAIL. The literals stay local so operator-core does not import
 * `scripts/`; `admission-fix-precheck.test.ts` pins them to the contract module.
 * WI-10003617: treating 2 as a failure refused an admission as `admission-imports-red`
 * for two admitted files whose every test was skipped in the precheck checkout.
 */
export const ROUTER_EXIT_NOT_MEASURED = 2;
export const ROUTER_EXIT_TEMPFAIL = 75;

/**
 * Classify one `scripts/test-files.mjs <file>` run. Route errors, zero matches and the router's
 * not-measured exits are UNMEASURED — never a pass, and never a failure: a run that measured
 * nothing cannot import a red.
 */
export function classifyTestFileRun(r: ExecResult): { status: FixPrecheckFileStatus; detail?: string } {
  if (r.timedOut) return { status: 'unmeasured', detail: `timed out after ${r.durationMs}ms` };
  if (/TEST_FILE_ROUTE_ERROR|matched=0\b|No test files found/.test(r.output)) {
    return { status: 'unmeasured', detail: 'the router matched zero test files (route error / matched=0)' };
  }
  if (r.exitCode === 0) return { status: 'pass' };
  if (r.exitCode === null) return { status: 'unmeasured', detail: `runner exited by signal ${r.signal ?? 'unknown'}` };
  if (r.exitCode === ROUTER_EXIT_NOT_MEASURED || r.exitCode === ROUTER_EXIT_TEMPFAIL) {
    const reason = /reason=([\w-]+)/.exec(r.output)?.[1];
    return {
      status: 'unmeasured',
      detail: `the router measured nothing (exit ${r.exitCode}${reason ? `, reason=${reason}` : ''})`,
    };
  }
  return { status: 'fail', detail: `exit ${r.exitCode}` };
}

export function createCheckpointTreeFixPrecheckRunner(opts: CheckpointTreeRunnerOptions): FixPrecheckRunner {
  const exec = opts.exec ?? defaultExec;
  const runLockHeld = opts.runLockHeld ?? ((root: string) => isCheckpointRunLockHeldCheap(root));
  const perFileTimeoutMs = opts.perFileTimeoutMs ?? 10 * 60_000;
  const setupTimeoutMs = opts.setupTimeoutMs ?? 20 * 60_000;
  const log = opts.log ?? (() => {});
  return async ({ commit, files, onProgress }) => {
    const held = runLockHeld(opts.integrationRoot);
    if (held.held) {
      return {
        ran: false,
        reason: 'checkpoint-tree-busy',
        detail:
          `a green-checkpoint run holds the checkpoint tree (pid ${held.pid ?? '?'}, ${held.elapsedSec ?? '?'}s in); ` +
          'the admission pre-check did not run — the gate re-judges the admission itself (R-1)',
        holder: { pid: held.pid, elapsedSec: held.elapsedSec },
      };
    }
    // The gate may acquire its run lock and re-pin checkpointRoot AFTER the one-time
    // probe above. Keep admission measurement in a different, queue-serialized worktree.
    // setup-release-checkout already creates/refreshes this checkout at the exact ref.
    const precheckRoot = `${path.resolve(opts.checkpointRoot)}-admission-precheck`;
    if (existsSync(precheckRoot)) {
      const integrationGitDir = defaultGitCommonDir(opts.integrationRoot);
      const precheckGitDir = defaultGitCommonDir(precheckRoot);
      if (!integrationGitDir || !precheckGitDir || path.resolve(integrationGitDir) !== path.resolve(precheckGitDir)) {
        return {
          ran: false,
          reason: 'runner-failed',
          detail: `dedicated admission checkout ${precheckRoot} exists but is not a worktree of ${opts.integrationRoot}; refusing to reset it`,
        };
      }
    }
    const setupScript = path.join(opts.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
    log(`[admission-precheck] materializing ${commit.slice(0, 12)} into ${precheckRoot}`);
    const setup = await exec(
      [
        'bash',
        setupScript,
        '--ref',
        commit,
        '--integration',
        opts.integrationRoot,
        '--release',
        precheckRoot,
        '--node-modules',
        'auto',
        '--node-modules-copy',
        'copy',
      ],
      { cwd: opts.integrationRoot, timeoutMs: setupTimeoutMs },
    );
    if (setup.exitCode !== 0) {
      return {
        ran: false,
        reason: 'runner-failed',
        detail: `setup-release-checkout exited ${setup.exitCode ?? setup.signal} for ${commit.slice(0, 12)}${setup.timedOut ? ' (timed out)' : ''}: ${setup.output.slice(-600)}`,
      };
    }
    const results: FixPrecheckFileResult[] = [];
    const reportProgress = async (progress: FixPrecheckProgress): Promise<void> => {
      if (!onProgress) return;
      try {
        await onProgress(progress);
      } catch (err) {
        // Progress is a liveness aid, never a substitute for the measured verdict. A transient
        // queue/DB write failure must not convert a real test result into runner-failed.
        log(
          `[admission-precheck] progress callback failed for ${progress.currentFile}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] as string;
      await reportProgress({
        currentFile: file,
        completedCount: index,
        totalCount: files.length,
        heartbeatAtMs: Date.now(),
      });
      log(`[admission-precheck] test-file ${file} @ ${commit.slice(0, 12)}`);
      const r = await exec(['node', 'scripts/test-files.mjs', file], {
        cwd: precheckRoot,
        timeoutMs: perFileTimeoutMs,
        env: { PAPERCUSP_ADMISSION_PRECHECK: '1', PAPERCUSP_TEST_RUN_GROUP: `admission-precheck:${commit.slice(0, 12)}` },
      });
      const c = classifyTestFileRun(r);
      results.push({ path: file, status: c.status, ...(c.detail ? { detail: c.detail } : {}), exitCode: r.exitCode, durationMs: r.durationMs });
    }
    return { ran: true, commit, results, setup: { durationMs: setup.durationMs } };
  };
}
