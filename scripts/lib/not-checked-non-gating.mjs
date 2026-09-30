// scripts/lib/not-checked-non-gating.mjs
//
// WI-10000288 (2026-09-11): WHICH repo-wide invariant guards have declared, up front, that
// "I could not look" (EXIT_NOT_CHECKED) must not gate — in a form the OPERATOR process can
// read.
//
// WHY THIS FILE EXISTS AT ALL
//   `REPO_WIDE_INVARIANT_GUARDS` in scripts/affected-tests.mjs already carries a
//   `notCheckedIsNonGating: true` on each of these entries, and affected-tests.mjs honours it
//   on ITS path (see the `exitClass === 'not-checked'` branch there). But that registry is a
//   bare `const`, not an export, and affected-tests.mjs does real work at module scope — it
//   resolves ROOT, memoizes changed-path derivations, and builds the task list. Importing it
//   from a long-lived operator process to read one flag would execute all of that. So the
//   declaration could not cross the process boundary, and the ONE consumer that most needed
//   it — green-checkpoint's `runGateAtRef`, which re-runs a signature leg in a CLEAN
//   checkout, the exact condition that makes these guards examine nothing — judged every leg
//   with a bare `exitCode === 0 ? pass : FAIL`.
//
//   The consequence was not subtle. A guard that answered "I verified nothing" was recorded
//   as a FAILING leg, re-entered the repair signature every round, and could never be
//   repaired by any fix to the subject, because nothing about the subject was wrong. The
//   frozen candidate stayed red for over 119 hours with `main` 2000+ commits behind. The
//   comment on the affected-tests branch had predicted exactly this — that gating on
//   not-checked "red-pinned EVERY candidate unconditionally" — for the path it had already
//   fixed, while this path stayed broken.
//
// THIS IS A MIRROR, AND IT IS PINNED
//   Per the repo's derived-truth ladder, a second copy of a truth the code already owns is
//   only acceptable at the PIN rung: with a build-time divergence check. That check is
//   packages/operator-core/lib/__tests__/not-checked-non-gating-mirror.test.ts (a Vitest file,
//   per the repo's four canonical frameworks — same placement as the sibling pin for
//   scripts/lib/task-exit-class.mjs). It parses the registry in affected-tests.mjs and asserts
//   set equality with this file, in BOTH directions. Add a guard to the registry with the flag
//   and that test fails until this file is updated; remove one and it fails the other way. Do
//   not hand-edit this list without running it.
//
// SCOPE — deliberately narrow.
//   Only a guard whose REGISTRATION opts in is forgiven. Exit 2 is a perfectly ordinary
//   failure status for many tools, so blanket-forgiving it for every leg would silently
//   convert real failures into passes. scripts/lib/task-exit-class.mjs makes the same point
//   about the same flag: "a guard that is not declared non-gating and could not look must
//   still red the run".

/**
 * npm script names registered `notCheckedIsNonGating: true` in
 * `REPO_WIDE_INVARIANT_GUARDS` (scripts/affected-tests.mjs).
 *
 * Each infers its subject from a working-tree diff, which is EMPTY in the gate's clean
 * checkout — so `EXIT_NOT_CHECKED` there is the expected, honest answer rather than a
 * finding, and it must not gate.
 *
 * @type {ReadonlySet<string>}
 */
export const NOT_CHECKED_NON_GATING_SCRIPTS = Object.freeze(
  new Set([
    'seed:substitutions:check',
    'lint:di-seam-arity-strands',
    'lint:deps-wiring-parity',
    'lint:vimock-export-strands',
    'lint:required-field-strands:typecheck',
    'lint:peer-dep-conflicts',
    'lint:no-unreachable-tier-mock',
  ]),
);

/**
 * Does this leg's registration forgive "I could not look"?
 *
 * Accepts either a bare script name (`lint:vimock-export-strands`) or a workspace-qualified
 * leg id as the gate's repair signature spells it (`@papercusp/operator-core ::
 * lint:vimock-export-strands`). The gate carries the qualified form, and callers were
 * otherwise left to split on `' :: '` themselves at each call site — which is the kind of
 * detail that gets it right in one place and wrong in the next.
 *
 * @param {string | null | undefined} idOrScript
 * @returns {boolean}
 */
export function isNotCheckedNonGating(idOrScript) {
  if (typeof idOrScript !== 'string') return false;
  const script = idOrScript.includes(' :: ')
    ? idOrScript.slice(idOrScript.lastIndexOf(' :: ') + 4).trim()
    : idOrScript.trim();
  return NOT_CHECKED_NON_GATING_SCRIPTS.has(script);
}
