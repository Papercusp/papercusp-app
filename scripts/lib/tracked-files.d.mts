/** Submodule paths declared in .gitmodules, superproject-relative, sorted. */
export function declaredSubmodules(cwd?: string): any;
/**
 * Every tracked file in the superproject AND in each checked-out submodule, as
 * superproject-relative paths.
 *
 * Returns `{ files, declared, scanned, unscanned }` rather than a bare array
 * precisely so a caller cannot forget the coverage question — see the contract
 * note above.
 */
export function listTrackedFiles(cwd?: string): {
    declared: any;
    scanned: any[];
    unscanned: any[];
    unscannedPresent: any[];
    unscannedAbsent: any[];
    files: any;
};
/**
 * Every tracked AND UNTRACKED-but-not-ignored file, superproject + each
 * submodule git can descend into, as superproject-relative paths.
 *
 * ── WHY THIS CANNOT JUST BE `listTrackedFiles` (WI-6730) ────────────────────
 * The identity guards (check-no-owner-name-tags, check-no-box-identity,
 * check-no-identity-literals) deliberately pass `--others --exclude-standard`,
 * because a brand-NEW file is invisible to a plain `git ls-files` until it is
 * `git add`-ed — and that is precisely the moment a fresh identity leak is most
 * likely to be sitting in the tree. Losing that would be a real regression, not
 * a stylistic one.
 *
 * But git REFUSES to combine those flags with recursion:
 *
 *     $ git ls-files --recurse-submodules --others
 *     fatal: ls-files --recurse-submodules unsupported mode
 *
 * So these guards could not adopt `listTrackedFiles()` without trading their
 * untracked coverage for submodule coverage — one blind spot for another. This
 * function buys both: the superproject keeps the untracked-inclusive flags, and
 * each submodule is enumerated with the SAME flags in its own working tree, with
 * results prefixed back to superproject-relative paths.
 *
 * A submodule git cannot descend into (no `.git` — the archive-extracted release
 * checkouts described under `describeUnscanned`) simply contributes nothing and
 * falls out as `unscanned`, exactly like the recursing path. Coverage is computed
 * from the emitted paths, never from an exit code, so the two agree.
 */
export function listFilesIncludingUntracked(cwd?: string): {
    declared: any;
    scanned: any[];
    unscanned: any[];
    unscannedPresent: any[];
    unscannedAbsent: any[];
    files: any;
};
/**
 * Coverage partition for an ALREADY-COMPUTED file list — the seam that lets a
 * guard keep its own enumeration and still report honest coverage (WI-6776).
 *
 * Several guards cannot simply call `listTrackedFiles()`: check-no-nul-in-source
 * and check-no-control-bytes need `-z` (NUL-delimited) output because a guard
 * about byte-level corruption must not itself assume filenames are newline-free,
 * and check-env-feature-gates uses `git grep --recurse-submodules`. Forcing them
 * onto one enumerator would trade a real property for uniformity. What they
 * actually need to share is the COVERAGE CONTRACT, not the `git` invocation — so
 * that is what this exports.
 *
 * Returns `{ declared, scanned, unscanned }` where the partition is exact:
 * a declared submodule is `scanned` iff some emitted file sits under it.
 */
export function coverageOf(files: any, cwd?: string): {
    declared: any;
    scanned: any[];
    unscanned: any[];
    unscannedPresent: any[];
    unscannedAbsent: any[];
};
/**
 * One-line coverage suffix for a guard's success message, so a ✓ always states
 * what it did NOT look at. Returns '' when every declared submodule was scanned.
 *
 * Accepts either the bare `unscanned` array or a whole `listTrackedFiles()`
 * result (preferred — it already knows `declared`, so no re-read of .gitmodules).
 *
 * ── WHY THIS REPORTS A CAUSE, NOT JUST A LIST (WI-6776) ─────────────────────
 * The first version said "NOT scanned — not initialized", which is the right
 * FACT with the wrong DIAGNOSIS, and the wrong diagnosis is expensive: it sends
 * a reader to `git submodule update --init` chasing a fault that does not exist.
 * That wasted-diagnostic-time cost is what EI-19301033966613245 was filed about.
 *
 * THE SHAPES THIS REPO ACTUALLY HAS (all measured 2026-08-02, and note that the
 * relevant `.git` is the SUBMODULE's — every one of these trees is itself a
 * linked worktree, so the superproject `.git` is a file in all of them):
 *
 *   papercusp (staging)      38/39 enumerated. The one gap, libs/zero-harness,
 *                            is retired and deliberately not checked out.
 *   papercusp-release,       0/39 enumerated, yet 38 hold content ON DISK.
 *   papercup-release         Submodule SOURCE is `git archive`-extracted by
 *                            setup-release-checkout.sh (deliberate — many pins
 *                            are never pushed to origin), and an archive
 *                            extraction cannot produce a `.git`, so
 *                            --recurse-submodules has nothing to descend into.
 *                            Stable across repeated measurement.
 *   papercusp-checkpoint     ⚠ VARIES. The GREEN GATE's own tree read 0/39 at
 *                            02:05Z and 38/39 at 02:21Z, after a 02:17Z rebuild
 *                            registered its submodules.
 *
 * That last row is the reason this function exists rather than a one-off fix.
 * The gate's tree is not reliably either shape, so NO caller may assume one —
 * and a guard's own output is the only surviving record of which shape it in
 * fact ran against. Do not "simplify" this by hard-coding an expectation, and
 * do not assert `.git` presence as a precondition: it is legitimately absent in
 * the release checkouts, where a precondition demanding it would fail forever.
 *
 * The suffix therefore names the shape it actually found:
 *
 *   present-on-disk-but-not-enumerable → archive-extracted / worktree (BY DESIGN)
 *   absent-from-disk                   → genuinely not initialized
 *
 * Reporting the RATIO is the load-bearing part: `0/39` cannot be misread as
 * clean, whereas a bare ✓ over an empty scan reads exactly like a pass.
 */
export function describeUnscanned(unscannedOrScan: any, cwd?: string): string;
