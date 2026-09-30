/**
 * Port 1 (P-005 / BRIEF 3): `cloneTaskRepo` + `extractDiff` — the diff-batch (M1) generation seam every
 * arm shares. A REAL `git clone` @ the pinned base commit (not a tarball) so the harness worker commits on
 * top and we recover the produced work with `git diff <base> <worktree>` — mirroring the gym substrate-clone
 * discipline (`gym/clone.ts`), but with benchmark concerns: GitHub repo resolution + grader test-file
 * exclusion (the arm must NOT slip the hidden tests into its patch — the grader supplies + applies them).
 *
 * I/O (git exec, mkdtemp, rm) is INJECTED so the ports are unit-testable with fakes before any live clone
 * runs (hive-eval live-ports pattern). The exported `cloneTaskRepo` / `extractDiff` bind the real I/O.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp as mkdtempCb, rm as rmCb } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BenchTask, CloneOpts, CloneTaskRepo, ExtractDiff, TaskCheckout } from './types';

const execFileP = promisify(execFileCb);
const mkdtempP = promisify(mkdtempCb);
const rmP = promisify(rmCb);

/** Run `git <args>` in `cwd`, return stdout. 64MB buffer — a big repo's diff can be large. */
export type GitExec = (args: string[], cwd?: string) => Promise<string>;

const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

export interface CloneDeps {
  /** Run a git command (default: real `git` via execFile, no shell). */
  git?: GitExec;
  /** Make a scratch dir under `parent` with the given prefix (default: real mkdtemp). */
  mkdtemp?: (prefix: string) => Promise<string>;
  /** Recursively remove a path (default: real rm -rf). */
  rm?: (path: string) => Promise<void>;
}

/** A pin is an immutable commit SHA (full or abbreviated), never a ref/branch/tag. */
export function isPinnedCommit(commit: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(commit);
}

/** True when `source` is a local filesystem path rather than a remote URL (→ `git clone --local`). */
function isLocalSource(source: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false; // scheme://…
  if (/^[^/]+@[^/]+:/.test(source)) return false; // scp-style user@host:path
  return true;
}

/**
 * Resolve the clone source for a task. `task.repo` is normally SWE-bench's `owner/name` → a GitHub HTTPS
 * URL; a full URL / local path is used verbatim; `graderMeta.repoUrl` (string) overrides everything.
 */
export function resolveRepoSource(task: BenchTask): string {
  const override = task.graderMeta?.['repoUrl'];
  if (typeof override === 'string' && override.length > 0) return override;
  const repo = task.repo;
  if (!repo) throw new Error(`cloneTaskRepo: task ${task.instanceId} has no repo (M1 requires repo+baseCommit)`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith('/') || /^[^/]+@[^/]+:/.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

/**
 * Test files the grader supplies + applies itself (so the arm's patch must exclude them). The task carries
 * them under `graderMeta.testFiles: string[]` (the blueprint/dataset loader, P-019, extracts these from the
 * SWE-bench `test_patch`). Absent → no exclusion (return the full diff).
 */
export function graderTestFiles(task: BenchTask): string[] {
  const tf = task.graderMeta?.['testFiles'];
  if (Array.isArray(tf)) return tf.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Port 1a: clone a task repo @ its base commit into a fresh scratch worktree. */
export function makeCloneTaskRepo(deps: CloneDeps = {}): CloneTaskRepo {
  const git = deps.git ?? defaultGitExec;
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempP(prefix));
  const rm = deps.rm ?? ((p: string) => rmP(p, { recursive: true, force: true }));

  return async (task: BenchTask, opts?: CloneOpts): Promise<TaskCheckout> => {
    const baseCommit = task.baseCommit;
    if (!baseCommit) throw new Error(`cloneTaskRepo: task ${task.instanceId} has no baseCommit (M1)`);
    if (!isPinnedCommit(baseCommit)) {
      throw new Error(`cloneTaskRepo: baseCommit must be a pinned hex SHA, got ${JSON.stringify(baseCommit)}`);
    }
    const source = resolveRepoSource(task);
    const workRoot = opts?.workRoot ?? tmpdir();
    const dir = await mkdtemp(join(workRoot, 'extbench-'));

    try {
      const cloneArgs = ['clone', '--quiet'];
      if (isLocalSource(source)) cloneArgs.push('--local');
      cloneArgs.push(source, dir);
      await git(cloneArgs);

      // Pin to the immutable base commit. A full clone fetches all branch tips, so a base commit in history
      // is reachable; if it is not (e.g. an unmerged ref), fetch the exact SHA then retry the detach.
      try {
        await git(['-C', dir, 'checkout', '--quiet', '--detach', baseCommit]);
      } catch {
        await git(['-C', dir, 'fetch', '--quiet', 'origin', baseCommit]);
        await git(['-C', dir, 'checkout', '--quiet', '--detach', baseCommit]);
      }
    } catch (err) {
      await rm(dir).catch(() => {});
      throw err;
    }

    return {
      dir,
      repo: task.repo ?? source,
      baseCommit,
      cleanup: () => rm(dir).catch(() => {}),
    };
  };
}

/**
 * Harness scaffolding paths the coding spine writes into the clone that are NEVER part of a benchmark
 * repo and must NOT leak into the predictions patch the grader applies. `createHarness`/the spine write
 * `.papercusp/{blueprint.yaml,debug,logs,memory,config.json}` (the per-harness git-canonical state +
 * debug notes + run log + agent memory) into the clone's worktree; a real run confirmed these landed in
 * the diff (the ansible pilot: `.papercusp/blueprint.yaml`, `.papercusp/debug/*.md`, `.papercusp/logs/run.log`,
 * `.papercusp/memory/*`). They are the HARNESS's private working state, not the arm's solution — including
 * them pollutes the patch (and risks a `git apply` failure against the clean grader image). Excluded here
 * so `extractDiff` returns ONLY the substantive base→worktree source delta (minus the grader's test files).
 */
const HARNESS_SCAFFOLD_EXCLUDES: readonly string[] = ['.papercusp/**'];

/**
 * Port 1b: extract the final unified diff from a checkout the arm has edited — `git diff` of the whole
 * worktree (incl. new files) against the base commit, EXCLUDING the grader's test files AND the harness's
 * own `.papercusp/` scaffolding. Returns "" when the arm produced no substantive change. Stages with
 * `add -A` first so untracked files are captured.
 */
export function makeExtractDiff(deps: CloneDeps = {}): ExtractDiff {
  const git = deps.git ?? defaultGitExec;

  return async (checkout: TaskCheckout, task: BenchTask): Promise<string> => {
    const { dir, baseCommit } = checkout;
    // Stage everything (incl. untracked) so `diff --cached <base>` is the full base→worktree delta.
    await git(['-C', dir, 'add', '-A']);

    // Always exclude the harness's own `.papercusp/` scratch state; additionally exclude the grader's
    // test files (the arm must not slip the hidden tests into its patch — the grader supplies them).
    const excludes = [...HARNESS_SCAFFOLD_EXCLUDES, ...graderTestFiles(task)];
    const args = ['-C', dir, '-c', 'core.fileMode=false', 'diff', '--cached', '--no-color', baseCommit];
    args.push('--', '.', ...excludes.map((p) => `:(exclude)${p}`));
    const diff = await git(args);
    return diff.trim().length > 0 ? diff : '';
  };
}

/** Real-I/O port instances (the live bindings). */
export const cloneTaskRepo: CloneTaskRepo = makeCloneTaskRepo();
export const extractDiff: ExtractDiff = makeExtractDiff();
