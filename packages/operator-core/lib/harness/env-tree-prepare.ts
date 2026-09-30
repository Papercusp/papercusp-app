/**
 * env-tree-prepare — resolve the on-disk tree each env operator runs from
 * (dogfood-silent-canonical-hive-join P-017, owner directive D-006). This is the real
 * implementation of the launcher's `prepareTree` seam (env-operator-launcher.ts), turning
 * "every env runs the same checkout on a different port" into D-006's actual model: each
 * env = a local git tree/branch served by its own operator.
 *
 *   dev     — the user's WORKING TREE: the cloned papercup checkout as-is (no worktree).
 *   prod    — the `main`/release tree.
 *   staging — the `staging` integration tree.
 *
 * To make prod/staging exist ALONGSIDE the working tree without disturbing it, each
 * non-working env gets its own git WORKTREE checked out to its branch, under
 * ~/.papercusp/env-trees/<id> — OUTSIDE the repo, so the git-sync auto-commit routine
 * never sees it (a stray in-repo worktree would otherwise get swept into the commit).
 *
 * Defensive + idempotent, by design:
 *  - REUSES an already-registered worktree (a re-provision / reboot doesn't re-add).
 *  - best-effort `git fetch` of the branch FIRST — a shallow, single-branch dogfood clone
 *    (bootstrap-papercusp-hive uses --depth 1) may not have the branch locally yet; the
 *    fetch is non-fatal (the branch may already be present, or offline).
 *  - returns `null` on ANY failure, so the launcher skips that env gracefully (the switcher
 *    keeps self-hiding it) rather than aborting provisioning.
 *
 * Everything shells out through ONE injected `runGit` seam, so the command construction +
 * idempotency + fallbacks are unit-tested with zero real git.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';
import type { EnvOperatorPlanEntry } from './env-operator-launcher';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PrepareEnvTreeDeps {
  /** Run a git command in `cwd`. Default: execFile('git', args, { cwd }). Never throws
   *  (a non-zero exit comes back as code≠0, not a rejection). */
  runGit?: (args: string[], cwd: string) => Promise<GitResult>;
  /** Base dir worktrees live under (default ~/.papercusp/env-trees). */
  worktreeBaseDir?: () => string;
  /** Path existence check (tests inject). Default fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Log sink (default console.log). */
  log?: (message: string) => void;
}

/** The env id that IS the working tree (served from the cloned checkout in place). */
export const WORKING_TREE_ENV_ID = 'dev';

function defaultRunGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
          resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
        },
      );
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: (e as Error)?.message ?? 'spawn failed' });
    }
  });
}

/** Is `worktreePath` already a registered worktree of `sourceRoot`? Parses
 *  `git worktree list --porcelain` (each entry starts `worktree <abs-path>`). */
async function worktreeExists(
  runGit: PrepareEnvTreeDeps['runGit'] & object,
  sourceRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const res = await runGit(['worktree', 'list', '--porcelain'], sourceRoot);
  if (res.code !== 0) return false;
  return res.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.slice('worktree '.length).trim() === worktreePath);
}

/**
 * Resolve (creating if needed) the tree for one env operator. Returns the absolute path to
 * run the operator from, or `null` if the tree couldn't be prepared (→ launcher skips it).
 */
export async function prepareEnvWorktree(
  entry: EnvOperatorPlanEntry,
  sourceRoot: string,
  deps: PrepareEnvTreeDeps = {},
): Promise<string | null> {
  const runGit = deps.runGit ?? defaultRunGit;
  const exists = deps.exists ?? existsSync;
  const baseDir = (deps.worktreeBaseDir ?? (() => papercuspPath('env-trees')))();
  const log = deps.log ?? ((m: string) => console.log(m));

  // The working-tree env runs the checkout in place — no worktree. So does a
  // `run:'vite'` env (`local`, WI-3285): the Vite SPA serves the same working tree
  // the dev operator runs; a separate worktree would just double the checkout.
  if (entry.id === WORKING_TREE_ENV_ID || entry.run === 'vite') return sourceRoot;

  if (!exists(sourceRoot)) return null;

  const worktreePath = join(baseDir, entry.id);

  // Idempotent: a prior provision already created this worktree → reuse it.
  if (await worktreeExists(runGit, sourceRoot, worktreePath)) {
    log(`[env-tree] reusing worktree for ${entry.id} at ${worktreePath}`);
    return worktreePath;
  }

  // Best-effort: a shallow single-branch dogfood clone may lack the branch locally.
  // Fetch it (depth 1 — we only need the tip to check it out); ignore failure.
  const fetched = await runGit(['fetch', '--depth', '1', 'origin', entry.branch], sourceRoot);
  if (fetched.code !== 0) {
    log(`[env-tree] fetch origin/${entry.branch} for ${entry.id} did not succeed (continuing): ${fetched.stderr.trim().slice(0, 120)}`);
  }

  // Create the worktree on the branch. Prefer the freshly-fetched remote tip
  // (origin/<branch>); `-B` (re)points a local branch named <branch> at it so a second
  // env on the same branch never collides on the branch name.
  const add = await runGit(
    ['worktree', 'add', '--force', '-B', entry.branch, worktreePath, `origin/${entry.branch}`],
    sourceRoot,
  );
  if (add.code === 0) {
    log(`[env-tree] created worktree for ${entry.id} (${entry.branch}) at ${worktreePath}`);
    return worktreePath;
  }

  // Fallback: no origin/<branch> (e.g. a purely local branch) — try the bare branch ref.
  const addLocal = await runGit(
    ['worktree', 'add', '--force', worktreePath, entry.branch],
    sourceRoot,
  );
  if (addLocal.code === 0) {
    log(`[env-tree] created worktree for ${entry.id} (local ${entry.branch}) at ${worktreePath}`);
    return worktreePath;
  }

  log(
    `[env-tree] could not prepare a worktree for ${entry.id} (${entry.branch}) — skipping: ${addLocal.stderr.trim().slice(0, 160)}`,
  );
  return null;
}
