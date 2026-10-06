/**
 * harness/git-sync/standing-pr-merge-deps — the real git, suite and state
 * dependencies for `stepStandingPrMerge` (P-021 / P-024, plan D-008).
 *
 * Everything runs against the UPSTREAM repo's local checkout (`repoDir`, remote
 * `origin` by default) — the repo the standing PR targets:
 *   - buildMergeResult: fetch the base branch and `refs/pull/<n>/head`, then
 *     `git merge-tree --write-tree` + `git commit-tree` build the exact merge commit
 *     (parent 1 = target tip, parent 2 = PR head) without a worktree and without
 *     moving any branch. merge-tree exit 1 = conflict -> null. The commit is pinned
 *     under `refs/papercusp/standing-merge/<n>` so gc cannot drop it before it is
 *     tested and pushed.
 *   - startTests: runs the suite on that sha in the background and records
 *     pass/fail. A suite that could not RUN (spawn failure, timeout) clears the
 *     record instead of failing it, so the next poll rebuilds and re-tests.
 *   - advanceTarget: pushes exactly the tested sha to the base branch with a
 *     `--force-with-lease` pinned to the tip it was built on. The merge commit's
 *     first parent IS that tip, so the push is a fast-forward; a target that moved
 *     is refused by the lease instead of being overwritten.
 *   - loadLastTest / saveTest: the record lives on the pr-host routine metadata
 *     under `standing_pr_merge_tests` — reusing the poll daemon's existing
 *     per-install state (`PollStore.readMeta/patchMeta`) instead of a new table.
 *     A `running` record with no live run in this process (an operator restart
 *     killed it) reads as absent, so it is rebuilt and re-tested, never waited on
 *     forever.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pinModuleState } from '@papercusp/module-singleton';
import type { MergeTestRecord } from './decide-merge-gate';
import type { AdvanceTargetResult, StandingPrMergeDeps } from './standing-pr-merge';

let execFilePMemo: typeof execFile.__promisify__ | null = null;
const execFileP = ((...args: unknown[]) =>
  Reflect.apply((execFilePMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

export const STANDING_PR_MERGE_TESTS_META_KEY = 'standing_pr_merge_tests';
export const STANDING_PR_MERGE_REF_PREFIX = 'refs/papercusp/standing-merge';

/** The slice of the pr-host `PollStore` this module needs. */
export interface StandingPrMergeMetaStore {
  readMeta(installSlug: string): Promise<object>;
  patchMeta(installSlug: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * Make sure the record can be written for this pot. A store keyed to a row that may
   * not exist creates it here (the poll store's pr-poll routine, WI-10006418).
   */
  ensureRecordRow?(installSlug: string, workspaceId: string): Promise<void>;
}

/** Run the suite on `sha`. true = passed, false = ran and failed; throws when it could not run. */
export type RunSuite = (args: { repoDir: string; sha: string }) => Promise<boolean>;

export interface DefaultStandingPrMergeDepsArgs {
  /** Local checkout of the upstream repo the standing PR targets. */
  repoDir: string;
  installSlug: string;
  prNumber: number;
  store: StandingPrMergeMetaStore;
  runSuite: RunSuite;
  /** Git remote name for the upstream repo. Default `origin`. */
  remoteName?: string;
  /** Background-run failures that could not be recorded. */
  onError?: (err: unknown) => void;
}

const runs = pinModuleState('@papercusp/operator-core.standing-pr-merge.runs', () => ({
  active: new Set<string>(),
}));

function runKey(installSlug: string, prNumber: number, mergeSha: string): string {
  return `${installSlug}#${prNumber}@${mergeSha}`;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function errText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  return stderr || (typeof e?.message === 'string' ? e.message : String(err));
}

function isMergeTestRecord(v: unknown): v is MergeTestRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.mergeSha === 'string' &&
    typeof r.prHeadSha === 'string' &&
    typeof r.targetTipSha === 'string' &&
    (r.result === 'running' || r.result === 'pass' || r.result === 'fail')
  );
}

export function createDefaultStandingPrMergeDeps(args: DefaultStandingPrMergeDepsArgs): StandingPrMergeDeps {
  const { repoDir, installSlug, prNumber, store, runSuite, onError } = args;
  const remote = args.remoteName ?? 'origin';

  async function readAll(): Promise<Record<string, unknown>> {
    const meta = (await store.readMeta(installSlug)) as Record<string, unknown>;
    const all = meta?.[STANDING_PR_MERGE_TESTS_META_KEY];
    return all && typeof all === 'object' ? { ...(all as Record<string, unknown>) } : {};
  }

  async function writeRecord(n: number, rec: MergeTestRecord | null): Promise<void> {
    const all = await readAll();
    if (rec) all[String(n)] = rec;
    else delete all[String(n)];
    await store.patchMeta(installSlug, { [STANDING_PR_MERGE_TESTS_META_KEY]: all });
    // This record is what lets a merge go ahead, so a write the store dropped without an
    // error must fail here. Otherwise every merge re-tests forever (WI-10006418).
    const saved = (await readAll())[String(n)];
    const kept = rec
      ? isMergeTestRecord(saved) && saved.mergeSha === rec.mergeSha && saved.result === rec.result
      : saved === undefined;
    if (!kept) {
      throw new Error(`The merge-test record for PR #${n} on ${installSlug} was not saved, so the merge cannot go ahead.`);
    }
  }

  async function readTargetTip(baseBranch: string): Promise<string> {
    const out = await git(repoDir, ['ls-remote', remote, `refs/heads/${baseBranch}`]);
    const sha = out.split(/\s+/)[0];
    if (!sha) throw new Error(`${remote} has no branch ${baseBranch}`);
    return sha;
  }

  async function hasCommit(sha: string): Promise<boolean> {
    try {
      await git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    readTargetTip,

    async loadLastTest(n) {
      const rec = (await readAll())[String(n)];
      if (!isMergeTestRecord(rec)) return null;
      if (rec.result === 'running' && !runs.active.has(runKey(installSlug, n, rec.mergeSha))) return null;
      return rec;
    },

    async saveTest(n, rec) {
      await writeRecord(n, rec);
    },

    async buildMergeResult(prHeadSha, targetTipSha) {
      if (!(await hasCommit(prHeadSha)) || !(await hasCommit(targetTipSha))) {
        await git(repoDir, ['fetch', '--quiet', remote, `refs/pull/${prNumber}/head`]);
        if (!(await hasCommit(targetTipSha))) await git(repoDir, ['fetch', '--quiet', remote]);
      }
      let tree: string;
      try {
        tree = (await git(repoDir, ['merge-tree', '--write-tree', targetTipSha, prHeadSha])).split('\n')[0];
      } catch (err) {
        if ((err as { code?: unknown }).code === 1) return null; // conflict
        throw err;
      }
      const mergeSha = await git(repoDir, [
        '-c', 'user.name=Papercusp',
        '-c', 'user.email=papercusp@localhost',
        'commit-tree', tree,
        '-p', targetTipSha,
        '-p', prHeadSha,
        '-m', `Merge standing PR #${prNumber} (exact merge, tested before landing)`,
      ]);
      await git(repoDir, ['update-ref', `${STANDING_PR_MERGE_REF_PREFIX}/${prNumber}`, mergeSha]);
      return mergeSha;
    },

    async startTests(n, rec) {
      const key = runKey(installSlug, n, rec.mergeSha);
      runs.active.add(key);
      void (async () => {
        try {
          let passed: boolean;
          try {
            passed = await runSuite({ repoDir, sha: rec.mergeSha });
          } catch (err) {
            onError?.(err);
            await writeRecord(n, null); // could not run: rebuild + retest next poll
            return;
          }
          await writeRecord(n, { ...rec, result: passed ? 'pass' : 'fail' });
        } catch (err) {
          onError?.(err);
        } finally {
          runs.active.delete(key);
        }
      })();
    },

    async advanceTarget({ baseBranch, sha, expectedTip }): Promise<AdvanceTargetResult> {
      try {
        await git(repoDir, [
          'push', '--quiet', remote,
          `${sha}:refs/heads/${baseBranch}`,
          `--force-with-lease=refs/heads/${baseBranch}:${expectedTip}`,
        ]);
        return { ok: true };
      } catch (err) {
        let tipAtPush = '';
        try {
          tipAtPush = await readTargetTip(baseBranch);
        } catch {
          // leave empty: confirmMergeAdvance treats an unreadable tip as moved
        }
        return { ok: false, tipAtPush, error: errText(err) };
      }
    },
  };
}

/** Whether a background run for this PR's merge sha is live in this process (tests / diagnostics). */
export function isStandingPrMergeRunActive(installSlug: string, prNumber: number, mergeSha: string): boolean {
  return runs.active.has(runKey(installSlug, prNumber, mergeSha));
}

/**
 * The dependency install a fresh merge worktree needs before the pot's suite runs
 * (WI-10006355). `npm ci` only with a lockfile — it refuses to run without one —
 * `npm install` for declared dependencies without a lockfile, and nothing when the
 * package declares none. Pure, so the rule is testable without a repository.
 */
export function pickNodeInstallCommand(input: {
  hasPackageJson: boolean;
  hasLockfile: boolean;
  dependencyCount: number;
}): string | null {
  if (!input.hasPackageJson) return null;
  if (input.hasLockfile) return 'npm ci';
  if (input.dependencyCount > 0) return 'npm install --no-audit --no-fund';
  return null;
}

/** Read {@link pickNodeInstallCommand}'s inputs from a checkout. */
export async function nodeInstallCommandFor(dir: string): Promise<string | null> {
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    pkg = null;
  }
  const count = (key: string) => {
    const v = pkg?.[key];
    return v && typeof v === 'object' ? Object.keys(v).length : 0;
  };
  return pickNodeInstallCommand({
    hasPackageJson: pkg !== null,
    hasLockfile: existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json')),
    dependencyCount: count('dependencies') + count('devDependencies') + count('optionalDependencies'),
  });
}

/**
 * The default suite runner: a throwaway detached worktree of `repoDir` at `sha`
 * (submodules initialised when present), the dependency install that worktree needs
 * ({@link nodeInstallCommandFor}), then `bash -c <command>` inside it; the worktree
 * is removed afterwards. Exit 0 = pass, any other exit = fail; a spawn failure or a
 * timeout throws (could not run). `command` is the pot's suite alone (e.g.
 * `npm test`) — the install is not part of it.
 */
export function makeWorktreeSuiteRunner(command: string, opts: { timeoutMs?: number } = {}): RunSuite {
  const timeout = opts.timeoutMs ?? 2 * 60 * 60 * 1000;
  return async ({ repoDir, sha }) => {
    const dir = await mkdtemp(join(tmpdir(), 'standing-pr-merge-'));
    try {
      await git(repoDir, ['worktree', 'add', '--detach', '--quiet', dir, sha]);
      if (existsSync(join(dir, '.gitmodules'))) {
        await git(dir, ['submodule', 'update', '--init', '--recursive', '--quiet']);
      }
      // Decided from the merge result itself, so a lockfile the PR adds or removes counts.
      const install = await nodeInstallCommandFor(dir);
      const script = install ? `${install} && ${command}` : command;
      try {
        await execFileP('bash', ['-c', script], { cwd: dir, timeout, maxBuffer: 64 * 1024 * 1024 });
        return true;
      } catch (err) {
        const e = err as { code?: unknown; killed?: boolean };
        if (typeof e.code === 'number' && !e.killed) return false;
        throw err;
      }
    } finally {
      await git(repoDir, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
