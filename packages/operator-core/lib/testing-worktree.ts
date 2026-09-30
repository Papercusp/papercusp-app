/**
 * Shared worktree provenance helpers for test runners.
 *
 * Keep this module's dependency graph small: Playwright loads its reporters
 * through a CommonJS transform, so reporters must not import the full
 * testing-run-store (which also owns task-manager/systemd spawn code).
 */

import { execFileSync } from 'node:child_process';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';

export interface WorktreeGitSnapshot {
  /** `git rev-parse HEAD`, or null if it couldn't be read. */
  commit: string | null;
  /** `git status --porcelain --untracked-files=all` output, or null if unreadable.
   *  Empty string means clean; non-empty means the shared worktree carries
   *  uncommitted changes at this snapshot. */
  porcelain: string | null;
}

export function computeWorktreeDirty(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): boolean {
  if (!before.commit || !after.commit) return true;
  if (before.commit !== after.commit) return true;
  if (before.porcelain === null || after.porcelain === null) return true;
  if (before.porcelain.trim().length > 0) return true;
  if (after.porcelain.trim().length > 0) return true;
  return false;
}

/**
 * Capture the shared worktree's commit and full porcelain status fail-soft.
 *
 * This is intentionally synchronous for the pre-run call: callers must finish
 * the before snapshot before spawning a child, otherwise a fast child could
 * complete before its "before" probe does. A missing/failed probe is returned
 * as null and therefore marks the run dirty via computeWorktreeDirty.
 */
export function captureWorktreeSnapshot(cwd?: string): WorktreeGitSnapshot {
  let root = cwd;
  if (!root) {
    try {
      root = resolveAgentWorkspaceRoot({});
    } catch {
      return { commit: null, porcelain: null };
    }
  }

  const readGit = (args: string[]): string | null => {
    try {
      const output = execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (output == null) return null;
      return output.trim();
    } catch {
      return null;
    }
  };

  return {
    commit: readGit(['rev-parse', 'HEAD']) || null,
    porcelain: readGit(['status', '--porcelain', '--untracked-files=all']),
  };
}
