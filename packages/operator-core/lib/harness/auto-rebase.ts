/**
 * auto-rebase — auto-rebase-on-push for worker runs (Phase 7 P-041).
 *
 * Per v5 §16.3: before every agent push, fetch origin main and rebase
 * the current branch onto it. On clean rebase → pushes normally.
 * On conflict → stashes WIP to `wip/conflict-F-<id>-<ts>`, resets,
 * writes a harness_escalations row, and returns a typed conflict result.
 *
 * P-041a: clean rebase proceeds with push.
 * P-041b: conflict → escalation row + stash branch + typed result.
 * P-041c: feature status resets to `in_queue` + working_users cleared.
 * P-041d: conflict is visible in the harness_escalations row.
 *
 * Security: `git` is invoked via execFile (shell-less). The repoPath
 * is expected to be an absolute path already validated by the caller.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import {
  buildRebaseConflictEscalation,
  composeStashBranchRef,
} from './sync-with-main-types';

const execFileP = promisify(execFile);

export type RebaseOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'conflict';
      conflicted_files: string[];
      stash_ref: string;
      escalation_slug: string;
    }
  | { ok: false; reason: 'fetch_failed'; message: string }
  | { ok: false; reason: 'unknown'; message: string };

/**
 * Run `git fetch origin main && git rebase origin/main` in the given
 * repo directory. On success returns `{ ok: true }`. On conflict
 * writes an escalation row, pushes WIP to a stash branch, and returns
 * the conflict result so the caller can halt the push + surface to UI.
 *
 * @param opts.repoPath  Absolute path to the git worktree.
 * @param opts.featureId  Feature id (e.g. "F-042") — used for the stash branch name + escalation.
 * @param opts.harnessSlug  Harness slug — written to the escalation row.
 * @param opts.githubUserId  Numeric GitHub user id for the worker — used to reset feature status.
 */
export async function autoRebaseOnPush(opts: {
  repoPath: string;
  featureId: string;
  harnessSlug: string;
  githubUserId?: number;
}): Promise<RebaseOutcome> {
  const { repoPath, featureId, harnessSlug } = opts;
  const git = (...args: string[]) =>
    execFileP('git', args, { cwd: repoPath });

  // Step 1: fetch origin main.
  try {
    await git('fetch', 'origin', 'main');
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', message: String(e) };
  }

  // Step 2: attempt rebase.
  try {
    await git('rebase', 'origin/main');
    return { ok: true };
  } catch (e) {
    const errMsg = String(e);

    // Rebase failed — check if it's a conflict or something unexpected.
    const conflicted = await getConflictedFiles(repoPath);
    if (conflicted.length === 0 && !errMsg.includes('CONFLICT')) {
      // Not a merge conflict — some other git error.
      try { await git('rebase', '--abort'); } catch { /* best-effort */ }
      return { ok: false, reason: 'unknown', message: errMsg };
    }

    // Abort the rebase so the tree is clean for the stash push.
    try { await git('rebase', '--abort'); } catch { /* best-effort */ }

    const now = Date.now();
    const stashRef = composeStashBranchRef(featureId, now);

    // Defensive: `git rebase` can report a conflict in stderr while
    // `git diff --diff-filter=U` lists no unmerged paths (submodule
    // conflicts, or the `rebase --abort` above clearing the index before
    // we read it). buildRebaseConflictEscalation requires a non-empty
    // list, so fall back to an explicit sentinel rather than throwing out
    // of autoRebaseOnPush — the conflict still escalates + the feature
    // still resets, just labelled so a human knows the paths couldn't be
    // enumerated.
    const conflictedFiles =
      conflicted.length > 0
        ? conflicted
        : ['<unidentified: git reported a rebase conflict but listed no unmerged paths>'];

    // Step 3 (P-041b): push WIP to stash branch before resetting.
    try {
      await git('push', 'origin', `HEAD:refs/heads/${stashRef}`, '--force');
    } catch {
      // Non-fatal: escalation still lands even if the push fails.
    }

    // Step 4: write escalation row.
    const escalation = buildRebaseConflictEscalation({
      harness_slug: harnessSlug,
      feature_id: featureId,
      conflicted_files: conflictedFiles,
      now,
    });

    try {
      await writeEscalation(harnessSlug, escalation);
    } catch {
      // Non-fatal: the typed result still propagates even if PG is down.
    }

    // Step 5 (P-041c): reset feature status to in_queue + clear working_users.
    if (opts.githubUserId !== undefined) {
      try {
        await clearFeatureClaim(harnessSlug, featureId, opts.githubUserId);
      } catch {
        // Non-fatal.
      }
    }

    return {
      ok: false,
      reason: 'conflict',
      conflicted_files: conflictedFiles,
      stash_ref: stashRef,
      escalation_slug: harnessSlug,
    };
  }
}

/** List files that are in conflict after a failed rebase. */
async function getConflictedFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd: repoPath },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function writeEscalation(
  harnessSlug: string,
  escalation: ReturnType<typeof buildRebaseConflictEscalation>,
): Promise<void> {
  const { sql } = getOrgPg();
  const body = JSON.stringify(escalation);
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations
       (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [harnessSlug, 'staging', body, Date.now(), ''],
  );
}

async function clearFeatureClaim(
  harnessSlug: string,
  featureId: string,
  _githubUserId: number,
): Promise<void> {
  const { sql } = getOrgPg();
  const schemaName = `harness_${harnessSlug.replace(/-/g, '_')}`;
  await sql.unsafe(
    `UPDATE ${schemaName}.features
     SET status = 'in_queue', working_users = '[]'::jsonb
     WHERE feature_id = $1 AND status = 'working'`,
    [featureId],
  );
}
