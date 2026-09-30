/**
 * The git-sync WHOLESALE-DELETION guard (WI-39377).
 *
 * On 2026-08-15T23:39-23:40Z four SideStage submodules had their working trees
 * emptied (downstream of the `rm -rf /home` incident, WI-39345). git-sync's next
 * sweep committed the deletions as if they were intentional, producing trees of
 * ZERO files, and pushed them to GitHub. Twenty minutes later — the restored
 * `.gitignore` having gone with everything else — the following sweep committed
 * regenerated `dist/` and `node_modules/` output ON TOP, so the repos then looked
 * populated while containing no source at all. The visible symptom was a blank
 * SideStage page and `Failed to resolve import "@papercusp/dock-workbench"`, which
 * reads as a resolver/config problem; nothing anywhere reported data loss.
 *
 * WHY THE EXISTING GUARDS ALL MISS IT — this is the point of a separate module:
 *   - `content-guard.ts` explicitly SKIPS deletions (there is no text to detect on).
 *   - `deletion-import-guard.ts` asks "does a SURVIVING file still import the file
 *     being deleted?" That question structurally cannot fire on a total wipe: when
 *     everything is deleted there are no survivors, so it finds nothing and passes.
 *     It is at its blindest exactly when the damage is at its worst.
 *   - `findOversizedDirtyFiles` / the cumulative size cap bound how much is ADDED,
 *     never how much is REMOVED.
 * So the deletion SET needs a check on its own magnitude, which is what this is.
 *
 * REMEDY — the same D-001 quarantine-don't-stall shape as its siblings, not a new
 * mechanism: every deletion in a wipe is returned as a `ContentOffender`, so
 * `commitOneRepo` excludes those paths from `git add -A` via the existing
 * `:(exclude,literal)` pathspec. The files therefore stay committed and PRESENT in
 * git (the repo is never destroyed and never pushed away), while the working tree
 * stays dirty-deleted for a human or the content-fixer to resolve — restore the
 * files, or, if the wipe really was intentional, commit it by hand. Any unrelated
 * work in the same sweep still lands. The guard escalates through the same
 * contentErrors path its siblings use, so a wipe becomes LOUD instead of silent.
 *
 * FAILS OPEN throughout: any git error means "no opinion", never a blocked commit —
 * a guard bug must not wedge the shared tree.
 */
import type { RunGit } from './run-git-sync';
import type { ContentOffender } from './content-guard';
import { parseDeletedPaths } from './deletion-import-guard';

/**
 * Fraction of a repo's tracked files that must be deleted in one sweep before the
 * deletion set is treated as a wipe rather than as work.
 *
 * 0.8 rather than 1.0 on purpose: the SideStage wipes landed at exactly 100%
 * (11/11, 21/21, 46/46, 64/64), but a wipe that races a rebuild can leave a few
 * regenerated files behind and still be a catastrophe. Legitimate refactors do
 * delete a lot of files, which is why the remedy is quarantine-and-escalate rather
 * than a hard stop: a false positive costs one sweep and a loud log line, while a
 * false negative costs the repository.
 */
export const WHOLESALE_DELETION_RATIO = 0.8;

/**
 * Below this many tracked files the ratio is meaningless — deleting 1 of 1 file is
 * 100% and is completely ordinary. Keeps tiny//new repos out of the guard entirely.
 */
export const WHOLESALE_DELETION_MIN_TRACKED = 5;

/**
 * Files whose deletion means "this package stopped being a package". Losing one of
 * these is a catastrophe independent of the ratio: it is exactly what turned the
 * SideStage submodules into unresolvable imports, and what let the NEXT sweep commit
 * `dist/` + `node_modules/` as if they were the source (the `.gitignore` was gone).
 */
export const PACKAGE_DEFINING_FILES = ['package.json', '.gitignore'] as const;

export interface WholesaleDeletionGuardDeps {
  runGit: RunGit;
  repoPath: string;
  log?: (msg: string) => void;
  /** Override for tests. */
  ratio?: number;
  minTracked?: number;
}

export interface WholesaleDeletionVerdict {
  /** Whether this deletion set should be quarantined. */
  wipe: boolean;
  deletedCount: number;
  trackedCount: number;
  ratio: number;
  /** Package-defining files (package.json, .gitignore) among the deletions. */
  packageDefiningDeleted: string[];
  reason: string;
}

/**
 * Pure verdict — exported separately from the git-touching detector so the decision
 * is unit-testable without a repo, and so a caller can log the reasoning.
 */
export function judgeDeletionSet(
  deletedPaths: string[],
  trackedCount: number,
  { ratio = WHOLESALE_DELETION_RATIO, minTracked = WHOLESALE_DELETION_MIN_TRACKED } = {},
): WholesaleDeletionVerdict {
  const deletedCount = deletedPaths.length;
  const actual = trackedCount > 0 ? deletedCount / trackedCount : 0;
  const packageDefiningDeleted = PACKAGE_DEFINING_FILES.filter((f) =>
    deletedPaths.some((p) => p === f),
  );

  if (deletedCount === 0) {
    return { wipe: false, deletedCount, trackedCount, ratio: actual, packageDefiningDeleted, reason: 'no deletions' };
  }
  if (trackedCount < minTracked) {
    return {
      wipe: false,
      deletedCount,
      trackedCount,
      ratio: actual,
      packageDefiningDeleted,
      reason: `repo has only ${trackedCount} tracked file(s) (< ${minTracked}) — ratio is not meaningful`,
    };
  }
  // A repo-root package.json/.gitignore deletion is decisive on its own: that is the
  // signature that let the follow-up sweep commit build output as if it were source.
  if (packageDefiningDeleted.length > 0) {
    return {
      wipe: true,
      deletedCount,
      trackedCount,
      ratio: actual,
      packageDefiningDeleted,
      reason: `deletes package-defining file(s) ${packageDefiningDeleted.join(', ')} at the repo root`,
    };
  }
  if (actual >= ratio) {
    return {
      wipe: true,
      deletedCount,
      trackedCount,
      ratio: actual,
      packageDefiningDeleted,
      reason: `deletes ${deletedCount}/${trackedCount} tracked files (${Math.round(actual * 100)}% >= ${Math.round(ratio * 100)}%)`,
    };
  }
  return {
    wipe: false,
    deletedCount,
    trackedCount,
    ratio: actual,
    packageDefiningDeleted,
    reason: `deletes ${deletedCount}/${trackedCount} (${Math.round(actual * 100)}%) — below the ${Math.round(ratio * 100)}% wipe threshold`,
  };
}

/**
 * Max paths per `git check-ignore` invocation, so a repo with a huge deletion set
 * cannot blow ARG_MAX. Purely a batching bound; the answer is the same either way.
 */
const CHECK_IGNORE_CHUNK = 500;

/**
 * The subset of `paths` that this repo's ignore rules CURRENTLY cover.
 *
 * `--no-index` is load-bearing: without it `git check-ignore` reports a TRACKED path
 * as not-ignored, and every path we ask about here is tracked at HEAD by
 * construction. The question this guard needs answered is "does .gitignore cover
 * this path", not "has git already been made to track it anyway" — those differ for
 * exactly the population that matters (see the caller).
 *
 * FAILS OPEN (empty set), like every other leg of this guard: if we cannot tell what
 * is ignored we count everything, which is the pre-existing behaviour and errs
 * toward quarantining rather than toward committing a wipe.
 */
async function ignoredSubset(
  runGit: RunGit,
  repoPath: string,
  paths: string[],
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (let i = 0; i < paths.length; i += CHECK_IGNORE_CHUNK) {
    const chunk = paths.slice(i, i + CHECK_IGNORE_CHUNK);
    const res = await runGit(['check-ignore', '--no-index', '-z', '--', ...chunk], repoPath);
    // 0 = at least one path matched, 1 = none matched (NOT a failure). Anything
    // else is a real git error, and a partial answer is worse than none.
    if (res.code !== 0 && res.code !== 1) return new Set<string>();
    for (const p of res.stdout.split('\0')) if (p) ignored.add(p);
  }
  return ignored;
}

/**
 * Detector: returns one ContentOffender per deleted path when the deletion set looks
 * like a wipe, so `commitOneRepo` excludes every one of them from `git add -A`.
 * Returns [] (no opinion) otherwise, and on any git failure.
 */
export async function detectWholesaleDeletion(
  deps: WholesaleDeletionGuardDeps,
): Promise<ContentOffender[]> {
  const { runGit, repoPath, log, ratio, minTracked } = deps;

  const statusRes = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (statusRes.code !== 0) return []; // fail open, exactly like content-guard
  const deletedPaths = parseDeletedPaths(statusRes.stdout);
  if (deletedPaths.length === 0) return [];

  // Tracked count at HEAD — the denominator. `ls-files` reflects the INDEX, which a
  // partially-staged sweep can already have mutated; HEAD is the stable "what this
  // repo was before this tick" that the ratio is meant to be measured against.
  const treeRes = await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], repoPath);
  if (treeRes.code !== 0) return []; // unborn branch / no HEAD yet — no opinion
  const trackedAtHead = treeRes.stdout.split('\n').filter(Boolean);

  // WI-39889: discount paths .gitignore already covers, on BOTH sides of the ratio.
  //
  // Deleting a file the repo's own ignore rules exclude is never a source wipe — it
  // is an UNTRACKING REPAIR, the fix for a file that should not have been committed.
  // Counting those made the guard fire on its own inverse: the 2026-08-15 incident
  // (same one this module was written for) left `node_modules/` tracked in four
  // submodules, because the .gitignore was missing from the working tree for the
  // 39 minutes in which a sweep ran. An ordinary `npm run install:safe` months later
  // turned those into 1,526-file deletion sets — 96% of "tracked" files — and the
  // guard quarantined them every tick for 33 hours, stalling ALL commits in those
  // repos and stranding real source edits behind build junk.
  //
  // This CANNOT weaken the real case: in a genuine wipe the .gitignore is deleted
  // too (that is the documented signature), so nothing reads as ignored and the
  // ratio is unchanged. And a package-defining deletion stays decisive on its own —
  // it is judged against the FULL set below, so no ignore rule can silence it.
  const ignored = await ignoredSubset(runGit, repoPath, [...new Set([...deletedPaths, ...trackedAtHead])]);
  const effectiveDeleted = deletedPaths.filter((p) => !ignored.has(p));
  const trackedCount = trackedAtHead.filter((p) => !ignored.has(p)).length;

  const packageDefiningDeleted = PACKAGE_DEFINING_FILES.filter((f) => deletedPaths.includes(f));
  if (effectiveDeleted.length === 0 && packageDefiningDeleted.length === 0) {
    log?.(
      `[wholesale-deletion-guard] ${repoPath}: all ${deletedPaths.length} deletion(s) are paths ` +
        `.gitignore already covers — untracking repair, not a wipe. No opinion (WI-39889).`,
    );
    return [];
  }

  // Judged on the ignore-discounted sets, but with any package-defining deletion
  // folded back in so the catastrophe check is evaluated against the full truth.
  const verdict = judgeDeletionSet(
    [...new Set([...effectiveDeleted, ...packageDefiningDeleted])],
    trackedCount,
    { ratio, minTracked },
  );
  if (!verdict.wipe) return [];

  log?.(
    `[wholesale-deletion-guard] QUARANTINED a suspected wipe in ${repoPath}: ${verdict.reason}. ` +
      `Excluding all ${verdict.deletedCount} deletion(s) from this commit — the files stay in git. ` +
      `If the deletion is intentional, commit it by hand; otherwise restore the working tree (WI-39377).`,
  );

  return deletedPaths.map((file) => ({
    file,
    detectorKey: 'wholesale-deletion',
    error:
      `git-sync refused to commit this deletion: the sweep ${verdict.reason}, which is the ` +
      `catastrophic-wipe signature that destroyed four SideStage submodules on 2026-08-15 ` +
      `(WI-39377). The file is intentionally left committed in git and dirty-deleted in the ` +
      `working tree. Restore it, or complete the deletion with a manual commit.`,
    fixerRole: 'content-fixer',
  }));
}
