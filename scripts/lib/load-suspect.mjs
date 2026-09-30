// load-suspect.mjs — the pure classification behind one question in
// `scripts/affected-tests.mjs`: HARDEN-GATE flake absorption re-ran the failed files and
// they failed AGAIN. Is that a regression, or is it the box?
//
// WHY THIS EXISTS (WI-38300). Absorption rests on a premise stated in affected-tests.mjs's
// own comment: "A real regression fails both runs; a load flake almost never fails twice in
// a row." That premise is FALSE for the one flake class absorption is auto-enabled BY.
// The retry is switched on because load1 crossed a threshold (`>>> load1=89 > 40 —
// auto-enabling flake-absorbing retry`), but the retry it then performs is deliberately
// IMMEDIATE and cheap, so it necessarily re-runs while the load that caused the failure is
// still present. A fresh process clears polluted module state; it does not clear a loaded
// box. So the single flake class that TRIGGERS absorption is the one class absorption
// cannot absorb, and its residue is rendered as a plain hard red.
//
// Measured 2026-08-12 (run 20:11:46Z->20:39:25Z, 60 tasks, box load 86-109 on 128 cores):
// 8 operator-core files failed the first pass, absorption cleared 5, and the surviving 3
// were reported as a hard red. All three pass scoped on the same box (63 passed / 0 failed
// in 6.9s) and passed in an earlier complete run of the same suite — i.e. they failed the
// first pass AND the fresh-process re-run while not being broken, which is exactly what the
// premise says cannot happen.
//
// ⚠ THE CENTRAL DESIGN DECISION: `load-suspect` is a LABEL, NOT AN ABSOLUTION.
// It still GATES (see `residualGates`). The tempting reading of "don't report it as a hard
// red" is to stop counting it, and that would be strictly worse than the bug it fixes: a
// genuine regression landing while the box is loaded would be waved through, converting a
// noisy-but-safe false RED into a silent false GREEN. A gate may cost you an investigation;
// it must never cost you a regression. What changes here is ATTRIBUTION — the reader is told
// the residue is load-correlated and must be re-triaged on a quiet box before anyone
// "fixes" it — not the verdict.
//
// This is the same error class as the leak-ratchet's `unadopted` verdict (plan decision
// D-026): absence of quiet-box evidence must not be rendered as a positive regression
// finding. Naming the third state is the whole point; collapsing it in EITHER direction
// (silent green, or confident red) is the failure.
//
// WHY ITS OWN MODULE (the WI-37830 argument, unchanged): every branch that consults this
// runs ONLY once a task has already failed — on a healthy tree that is never. In-process it
// would be reachable by no test and checkable only by reading it, which is precisely how
// the false premise above survived in a comment for two months. Gate-PROTECTING logic must
// not be the code that never runs until the gate is already broken.
//
// Kept dependency-free ON PURPOSE, for the same reason as task-exit-class.mjs: this module
// is on every agent's `test:affected` path, so `threshold` is a PARAMETER rather than an
// import of the caller's `AUTO_RETRY_LOAD1_THRESHOLD`. Passing it in also keeps the
// classification honest about WHICH threshold it judged against, which is what the emitted
// notice has to name.

/**
 * @typedef {'absorbed' | 'not-absorbed' | 'load-suspect' | 'hard-red'} ResidualFailureClass
 *
 * - `absorbed`      the fresh-process re-run PASSED — counted as a flake, not a failure.
 * - `not-absorbed`  no absorption ran (retry disabled, too many failed files to re-run
 *                   scoped, or nothing parseable to re-run), so this run holds no
 *                   second-observation evidence either way.
 * - `load-suspect`  re-ran and failed again, but the box was STILL loaded at re-run time —
 *                   the premise that distinguishes flake from regression did not hold.
 * - `hard-red`      re-ran and failed again on a quiet box. The premise held; believe it.
 */

/**
 * Classify a failed task after HARDEN-GATE absorption has had its chance.
 *
 * TOTAL BY DESIGN, including `absorbed`, which `affected-tests.mjs` never actually sees
 * (it consults this only inside `if (r.status !== 0)`). That mirrors `classifyTaskExit`,
 * which likewise returns a `pass` its caller cannot observe: a helper that models the whole
 * space can be unit-tested as a function, and the caller's narrowing stays the caller's
 * business rather than being baked in as an untestable precondition.
 *
 * `load1AtRerun` must be sampled AFTER the re-run completes, not before it. The 1-minute
 * load average is trailing, so a sample taken after the re-run describes the load the
 * RE-RUN ITSELF experienced — which is the thing in question. A sample taken before it
 * describes the load during the FIRST pass, which is already known to have been high (it is
 * what enabled absorption in the first place) and therefore cannot discriminate anything.
 *
 * A null/undefined/non-finite `load1AtRerun` means "not measured". That is reported as
 * `hard-red` deliberately: this helper must never manufacture a load excuse from an absent
 * reading. Unknown load is not evidence of load — the same rule the header cites D-026 for,
 * applied to this function's own input.
 *
 * @param {object} opts
 * @param {boolean} opts.absorptionRan did a fresh-process/whole-workspace re-run actually happen?
 * @param {number | null | undefined} opts.rerunStatus exit status of that re-run (null when none ran)
 * @param {number | null | undefined} opts.load1AtRerun loadavg()[0] sampled AFTER the re-run
 * @param {number} opts.threshold the caller's AUTO_RETRY_LOAD1_THRESHOLD
 * @returns {ResidualFailureClass}
 */
export function classifyResidualFailure({ absorptionRan, rerunStatus, load1AtRerun, threshold }) {
  if (!absorptionRan) return 'not-absorbed';
  if (rerunStatus === 0) return 'absorbed';
  // Strictly greater-than, matching the caller's own `currentLoad1 > AUTO_RETRY_LOAD1_THRESHOLD`
  // enabling test. If the two comparisons disagreed, a run could enable absorption on a load
  // it then refuses to blame, which is the incoherence this whole item is about.
  if (typeof load1AtRerun === 'number' && Number.isFinite(load1AtRerun) && load1AtRerun > threshold) {
    return 'load-suspect';
  }
  return 'hard-red';
}

/**
 * Does this classification count against the run?
 *
 * EVERYTHING except `absorbed` gates — `load-suspect` INCLUDED. See the header: labelling a
 * residue load-correlated changes what the reader is told, never whether the gate holds.
 * A test pins this exact property, because "don't report it as a plain hard red" is one
 * careless edit away from "don't report it", and that edit would be invisible on a green
 * tree.
 *
 * @param {ResidualFailureClass} cls
 * @returns {boolean}
 */
export function residualGates(cls) {
  return cls !== 'absorbed';
}

/**
 * The human-facing explanation attached to a load-suspect residue, in the log a triager
 * actually reads. Sibling in spirit to the existing "timed out" notice in affected-tests.mjs:
 * it names the mechanism, the measurement, and the ONE next action — re-triage on a quiet
 * box — so nobody starts "fixing" tests that were never broken.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {number} opts.load1AtRerun
 * @param {number} opts.threshold
 * @param {readonly string[]} [opts.files] the residual failed files, when known
 * @returns {string}
 */
export function formatLoadSuspectNotice({ workspace, load1AtRerun, threshold, files = [] }) {
  const fileList = files.length ? ` Residual file(s): ${files.join(', ')}.` : '';
  return (
    `  ⚠ ${workspace}: LOAD-SUSPECT residue — these file(s) failed the first pass AND the ` +
    `fresh-process re-run, but load1 was still ${load1AtRerun.toFixed(0)} (> ${threshold}) when the ` +
    `re-run happened, so absorption re-ran them under the SAME load that caused the original ` +
    `failure. Absorption clears polluted process state; it does not clear a loaded box, so for ` +
    `this class "failed twice" is NOT evidence of a regression (WI-38300).${fileList}\n` +
    `    STILL COUNTED AS A FAILURE — the gate holds. But RE-TRIAGE ON A QUIET BOX before ` +
    `changing any test: run these files scoped and compare. Only a quiet-box failure is a regression.`
  );
}

/**
 * The greppable machine line, emitted once per run and ONLY when there is load-suspect
 * residue. Deliberately a SEPARATE marker rather than a new field on `AFFECTED_TESTS_RESULT`:
 * that line's shape is pinned by affected-tests-result-line.test.ts and parsed by
 * green-checkpoint, and widening a verdict contract to carry an advisory is how advisories
 * end up being read as verdicts. Absence of this line means no load-suspect residue, which
 * is the common case and needs no output at all.
 *
 * Follows the house `MARKER key=value` shape (see machine-line-grep-anchors.ts) so a triage
 * recipe can anchor on `AFFECTED_TESTS_LOAD_SUSPECT tasks=` rather than the bare marker —
 * a bare grep also matches vitest TEST NAMES echoed into the same log.
 *
 * @param {object} opts
 * @param {number} opts.tasks how many tasks carried load-suspect residue
 * @param {number} opts.files how many residual files across them
 * @param {number} opts.maxLoad1 the highest re-run load observed
 * @param {number} opts.threshold
 * @returns {string}
 */
export function formatLoadSuspectMarker({ tasks, files, maxLoad1, threshold }) {
  return (
    `AFFECTED_TESTS_LOAD_SUSPECT tasks=${tasks} files=${files} ` +
    `maxLoad1=${maxLoad1.toFixed(0)} threshold=${threshold}`
  );
}
