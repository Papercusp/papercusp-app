/**
 * ensureUserBranchAndWorktree — Phase 5b P-033.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 * v5 §0.4 — on join, create the long-lived `user/<github_user_id>`
 * branch + worktree under `<harness-root>/.papercusp/user-trees/<id>/`.
 *
 * Idempotent: re-running on an already-provisioned user is a no-op.
 * Pure: git operations are injected via `runGit` so tests can drive
 * the decision tree without spawning real `git`.
 *
 * Decision tree (matches v5 §0.4 + repeated-join safety):
 *
 *   1. If the local branch ref already exists AND the worktree dir
 *      already exists → no-op return { branchCreated:false, worktreeCreated:false }.
 *   2. If the branch ref exists but the worktree does NOT → just add
 *      the worktree pointing at the existing branch.
 *   3. If neither exists → create the branch from origin/main (or HEAD
 *      if no upstream) AND add the worktree in one git invocation
 *      (`git worktree add -b user/<id> <path> origin/main`).
 *   4. If the worktree exists but the branch ref does NOT → repair: a
 *      worktree without its branch is a bug from a partial run; we
 *      delete the worktree dir + recreate from scratch.
 *
 * All git calls use `--quiet` where supported. The function bubbles up
 * any unrecoverable git error rather than swallowing it.
 */

import {
  userBranchRef,
  userTreeAbsPath,
} from './user-tree-types';

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunGit = (args: string[]) => Promise<RunGitResult>;

export interface EnsureUserBranchOpts {
  harnessRoot: string;
  githubUserId: number;
  /** Optional override for the upstream branch we fork from. Default 'origin/main'. */
  upstreamRef?: string;
  /** Git runner. Tests inject a fake; runtime callers pass an execFile wrapper. */
  runGit: RunGit;
  /** Stat-like predicate for the worktree dir. Tests inject; runtime passes existsSync. */
  pathExists: (absPath: string) => boolean;
  /** Recursive rmdir for the repair path. Tests inject; runtime passes rmSync. */
  rmDirSync?: (absPath: string) => void;
}

export interface EnsureUserBranchResult {
  branchRef: string;
  worktreeAbsPath: string;
  branchCreated: boolean;
  worktreeCreated: boolean;
  repaired: boolean;
}

function validate(opts: EnsureUserBranchOpts): void {
  if (!opts.harnessRoot) throw new Error('ensureUserBranchAndWorktree: harnessRoot required');
  if (!Number.isInteger(opts.githubUserId) || opts.githubUserId <= 0) {
    throw new Error('ensureUserBranchAndWorktree: githubUserId must be positive integer');
  }
  if (typeof opts.runGit !== 'function') throw new Error('runGit required');
  if (typeof opts.pathExists !== 'function') throw new Error('pathExists required');
}

async function branchExists(
  runGit: RunGit,
  harnessRoot: string,
  branchRef: string,
): Promise<boolean> {
  const r = await runGit([
    '-C',
    harnessRoot,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branchRef}`,
  ]);
  return r.exitCode === 0;
}

async function createBranchAndWorktree(
  runGit: RunGit,
  harnessRoot: string,
  branchRef: string,
  worktreePath: string,
  upstreamRef: string,
): Promise<void> {
  // Single invocation: -b creates the branch from <upstream>, adds the worktree.
  // If <upstream> doesn't resolve (e.g. brand-new harness pre-push), retry
  // against HEAD so a join during early setup still succeeds.
  const first = await runGit([
    '-C',
    harnessRoot,
    'worktree',
    'add',
    '-b',
    branchRef,
    worktreePath,
    upstreamRef,
  ]);
  if (first.exitCode === 0) return;
  const upstreamMissing = /unknown revision|not a valid object name|invalid reference/i.test(
    first.stderr,
  );
  if (!upstreamMissing) {
    throw new Error(
      `git worktree add -b ${branchRef} ${worktreePath} ${upstreamRef} failed: ${first.stderr.trim()}`,
    );
  }
  const retry = await runGit([
    '-C',
    harnessRoot,
    'worktree',
    'add',
    '-b',
    branchRef,
    worktreePath,
    'HEAD',
  ]);
  if (retry.exitCode !== 0) {
    throw new Error(
      `git worktree add -b ${branchRef} ${worktreePath} HEAD failed: ${retry.stderr.trim()}`,
    );
  }
}

async function addWorktreeOnly(
  runGit: RunGit,
  harnessRoot: string,
  branchRef: string,
  worktreePath: string,
): Promise<void> {
  const r = await runGit([
    '-C',
    harnessRoot,
    'worktree',
    'add',
    worktreePath,
    branchRef,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`git worktree add ${worktreePath} ${branchRef} failed: ${r.stderr.trim()}`);
  }
}

export async function ensureUserBranchAndWorktree(
  opts: EnsureUserBranchOpts,
): Promise<EnsureUserBranchResult> {
  validate(opts);
  const branchRef = userBranchRef(opts.githubUserId);
  const worktreePath = userTreeAbsPath({
    harnessRoot: opts.harnessRoot,
    githubUserId: opts.githubUserId,
  });
  const upstreamRef = opts.upstreamRef ?? 'origin/main';

  const hasBranch = await branchExists(opts.runGit, opts.harnessRoot, branchRef);
  const hasWorktree = opts.pathExists(worktreePath);

  if (hasBranch && hasWorktree) {
    return { branchRef, worktreeAbsPath: worktreePath, branchCreated: false, worktreeCreated: false, repaired: false };
  }
  if (hasBranch && !hasWorktree) {
    await addWorktreeOnly(opts.runGit, opts.harnessRoot, branchRef, worktreePath);
    return { branchRef, worktreeAbsPath: worktreePath, branchCreated: false, worktreeCreated: true, repaired: false };
  }
  if (!hasBranch && hasWorktree) {
    // Repair path: orphaned worktree dir with no backing branch ref.
    if (!opts.rmDirSync) {
      throw new Error('rmDirSync required to repair orphaned worktree at ' + worktreePath);
    }
    opts.rmDirSync(worktreePath);
    await createBranchAndWorktree(opts.runGit, opts.harnessRoot, branchRef, worktreePath, upstreamRef);
    return { branchRef, worktreeAbsPath: worktreePath, branchCreated: true, worktreeCreated: true, repaired: true };
  }
  // !hasBranch && !hasWorktree
  await createBranchAndWorktree(opts.runGit, opts.harnessRoot, branchRef, worktreePath, upstreamRef);
  return { branchRef, worktreeAbsPath: worktreePath, branchCreated: true, worktreeCreated: true, repaired: false };
}
