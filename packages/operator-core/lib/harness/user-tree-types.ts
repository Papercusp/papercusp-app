/**
 * user-tree-types — path + branch conventions for §0.4 user branch
 * + worktree per papercusp-dogfood-v5.
 *
 * Types-only and PURE. No fs, no git.
 *
 * Twenty-eighth module in the dogfood-arc types-only spine.
 *
 * Per v5 §0.4:
 *   - Long-lived branch `user/<github_user_id>` on GitHub remote.
 *   - Local worktree at
 *     `<harness-root>/.papercusp/user-trees/<github_user_id>/`
 *   - ONE physical worktree per harness.
 *
 * Single source of truth: every site that builds these paths
 * (clone path, worker push path, sync-with-main path, worktree
 * cleanup path) imports from here. The string-concat happens in
 * one place so a future rename (e.g. `.papercusp/user-trees/`) is
 * a one-edit + typecheck-driven fan-out.
 *
 * Reuses `contributorBranchRef` from contributor-file-types for
 * the branch-name builder (same `user/<id>` convention shared
 * across §0.2.7 Channel 2 + §0.4 worktree).
 */

import {
  contributorBranchRef,
} from '../identity/contributor-file-types';

/**
 * Relative path under `<harness-root>` where user-trees live.
 * Sub-directory of `.papercusp/` per §0.4.
 */
export const USER_TREES_ROOT_REL_PATH = '.papercusp/user-trees' as const;

/**
 * Build the absolute worktree path for a user. Same convention as
 * v5 §0.4 line 1: `<harness-root>/.papercusp/user-trees/<github_user_id>/`.
 *
 * The trailing slash is omitted (git takes the path without trailing
 * slash); UI rendering adds it back when displaying paths.
 */
export function userTreeAbsPath(args: { harnessRoot: string; githubUserId: number }): string {
  if (typeof args.harnessRoot !== 'string' || args.harnessRoot.length === 0) {
    throw new TypeError('harnessRoot required');
  }
  if (!Number.isInteger(args.githubUserId) || args.githubUserId <= 0) {
    throw new TypeError('githubUserId must be a positive integer');
  }
  const root = args.harnessRoot.endsWith('/') ? args.harnessRoot.slice(0, -1) : args.harnessRoot;
  return root + '/' + USER_TREES_ROOT_REL_PATH + '/' + args.githubUserId;
}

/**
 * Build the relative path (under the harness root) where the user's
 * worktree lives. Useful for things that need to display the path
 * without leaking the harness-root prefix (e.g. git ignore patterns,
 * docs).
 */
export function userTreeRelPath(githubUserId: number): string {
  if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
    throw new TypeError('githubUserId must be a positive integer');
  }
  return USER_TREES_ROOT_REL_PATH + '/' + githubUserId;
}

/**
 * Re-export the canonical branch-name builder. §0.4 + §0.2.7 share
 * the same `user/<id>` form; using one source prevents drift.
 */
export { contributorBranchRef as userBranchRef } from '../identity/contributor-file-types';

/**
 * Inverse: parse a user-tree relative path and return the
 * github_user_id. Returns null for any malformed input.
 */
export function parseUserTreeRelPath(relPath: string): number | null {
  if (typeof relPath !== 'string') return null;
  if (!relPath.startsWith(USER_TREES_ROOT_REL_PATH + '/')) return null;
  const rest = relPath.slice(USER_TREES_ROOT_REL_PATH.length + 1);
  if (rest.length === 0 || rest.includes('/')) return null;
  const id = Number(rest);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * Predicate: does this path look like a user-tree path? Useful for
 * cleanup tools that need to identify user-tree directories.
 */
export function isUserTreePath(path: string): boolean {
  return parseUserTreeRelPath(path) !== null;
}

/**
 * Build the gitignore line that excludes user-trees from
 * tracking. Worktrees should never be committed (they're working
 * directories, not source). The line is per-harness so it goes in
 * the harness's `.gitignore`, not the workspace's.
 */
// (no `as const` — a const assertion is illegal on a concatenation
// expression, TS1355; this was the one parse-broken file the old
// count-only baseline silently absorbed.)
export const USER_TREES_GITIGNORE_LINE = '/' + USER_TREES_ROOT_REL_PATH + '/';

/**
 * Discriminated result for "where can this user write?"
 *
 *   `user_tree`     — write into this user's worktree
 *   `not_provisioned` — user has no worktree on this harness yet
 *                       (caller can dispatch the bootstrap flow)
 */
export type WorktreeResolveResult =
  | { kind: 'user_tree'; abs_path: string }
  | { kind: 'not_provisioned'; would_be_abs_path: string };

/**
 * Compose a "where should this user's writes go?" result given the
 * harness root + the user's id + a predicate for "does this path
 * exist on disk." The predicate is injected so the runtime can
 * stub it for tests (and so this module stays pure).
 */
export function resolveWriteTarget(args: {
  harnessRoot: string;
  githubUserId: number;
  pathExists: (absPath: string) => boolean;
}): WorktreeResolveResult {
  const abs = userTreeAbsPath({
    harnessRoot: args.harnessRoot,
    githubUserId: args.githubUserId,
  });
  if (args.pathExists(abs)) {
    return { kind: 'user_tree', abs_path: abs };
  }
  return { kind: 'not_provisioned', would_be_abs_path: abs };
}

/**
 * v5 §0.4 invariant: "ONE physical worktree per harness." This is
 * a constant predicate the worktree-cleanup tool uses to refuse
 * to spawn a second physical worktree for the same (harness, user).
 *
 * `existing_worktrees_for_user` is a list of paths the runtime
 * has discovered (e.g. by walking `.papercusp/user-trees/`). If
 * the list contains more than one path, the invariant is broken
 * — the tool should refuse the new worktree + emit an escalation.
 */
export function isWorktreeInvariantBroken(
  existing_worktrees_for_user: ReadonlyArray<string>,
): boolean {
  return existing_worktrees_for_user.length > 1;
}

/**
 * Build the git-worktree command args for adding a user-tree.
 * Returns the command arg array (caller passes to execFile + git).
 *
 * Pure — for testing, lets us assert exact `git worktree add` args
 * without spawning git.
 *
 *   git worktree add -B user/<id> <abs_path> origin/main
 *
 * `-B` resets the branch if it exists; `origin/main` is the starting
 * commit. Caller is responsible for `git fetch origin main` first.
 */
export function gitWorktreeAddArgs(args: {
  harnessRoot: string;
  githubUserId: number;
}): string[] {
  const abs = userTreeAbsPath(args);
  const branch = contributorBranchRef(args.githubUserId);
  return ['worktree', 'add', '-B', branch, abs, 'origin/main'];
}
