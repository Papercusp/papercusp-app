// scripts/lib/not-checked.mjs
//
// WI-37806 (2026-08-10): the shared "this run VERIFIED NOTHING" verdict, extracted from
// scripts/check-required-field-strands.mjs so the strand-guard family stops re-deriving it
// one copy at a time.
//
// WHY THIS IS SHARED RATHER THAN COPIED A FOURTH TIME
//   Three guards in this family answer the same question — "did anything actually get
//   compared?" — because all three infer their subject from `git diff <base>`, and on this
//   tree git-sync commits the whole working tree every few minutes. So minutes after an
//   edit, working-tree == HEAD, the diff is empty, and the guard is least reliable exactly
//   when it is most needed.
//
//   check-required-field-strands.mjs learned that the hard way over FOUR successive
//   filings (EI-19377892307939503, EI-19396116936287206, EI-20095543794921181,
//   EI-20097325488507587), each repairing one surface and leaving the next live. The two
//   guards ported from it (check-optional-seam-strands, check-vimock-export-strands)
//   inherited its PROSE — a correct, well-written "⚠ NOT CHECKED … This is NOT a clean
//   bill" — but not its EXIT STATUS, so each printed that text and then exited 0. Measured:
//   optional-seam printed NOT CHECKED and exited 0 while its already-fixed parent exited 2.
//
//   That is the whole argument for this file. The prose is what a human reads and the exit
//   status is what `&& echo PASS`, `grep -c`, and a CI step read; a copy-port carries the
//   first and quietly drops the second, and nothing fails when it does. One definition,
//   imported, cannot be half-ported.
//
// THE CONTRACT: absent evidence must not read as evidence of absence — the same principle
// behind `unitsUnknown`, `ownerVisible`, and testing:run's zero-match refusal elsewhere in
// this repo.

/**
 * The exit status for "this run VERIFIED NOTHING".
 *
 * Distinct from both 0 (checked, found nothing) and 1 (checked, found something), because
 * those are the only two answers a caller can otherwise receive and NEITHER is true when
 * the run examined nothing. Callers that only branch on `!== 0` still treat it as a
 * failure, which is the safe direction; callers that care can distinguish it.
 */
export const EXIT_NOT_CHECKED = 2;

/**
 * "This run compared nothing, so it proved nothing."
 *
 * The SINGLE predicate a guard should use for BOTH its headline and its exit status. Those
 * were computed separately in check-required-field-strands and drifted exactly as you would
 * expect: the status said EXIT_NOT_CHECKED for an all-identical declared run while the text
 * still opened with a ✓, burying the invalidation several lines down as what read like a
 * caveat on a pass. A reader acts on the headline; a script acts on the status; each was
 * independently defensible and together they said opposite things.
 *
 * Two ways a run proves nothing:
 *   - nothing differed from `base` at all, so ZERO files were examined;
 *   - every DECLARED file turned out byte-identical to `base` — the per-file form of the
 *     same root cause (`--files=` fixes WHICH files, not WHETHER the diff was real).
 *
 * A PARTIAL declared run — some files identical, others genuinely diffed — is deliberately
 * NOT "proved nothing": it verified what it could, and the guard's own text names the rest.
 * Tightening that would fail runs that did real work, so it should be a deliberate choice
 * rather than a side effect of this predicate.
 *
 * @param {{ examinedFiles?: string[], identicalFiles?: string[], declared?: boolean }} [opts]
 * @returns {boolean}
 */
export function provedNothing({ examinedFiles = [], identicalFiles = [], declared = false } = {}) {
  if (examinedFiles.length === 0) return true;
  // identicalFiles is only ever populated in declared mode (auto-diff mode derives its
  // candidates FROM the diff, so a listed file cannot be identical to base) — the
  // `declared` term keeps that an explicit precondition rather than an inherited one.
  return declared && identicalFiles.length >= examinedFiles.length;
}

/**
 * The exit status for a run that produced no findings: 0 only when something was genuinely
 * compared, EXIT_NOT_CHECKED otherwise. Pure, so the distinction is unit-testable rather
 * than reachable only through an end-to-end run.
 *
 * @param {{ examinedFiles?: string[], identicalFiles?: string[], declared?: boolean }} [opts]
 * @returns {0 | 2}
 */
export function exitForNoFindings(opts = {}) {
  return provedNothing(opts) ? EXIT_NOT_CHECKED : 0;
}
