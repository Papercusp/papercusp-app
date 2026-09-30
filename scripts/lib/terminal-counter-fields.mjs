/**
 * WI-1048027 layer 2 — the abort verdict's counter fields, as a pure function.
 *
 * WHY THIS IS EXTRACTED rather than inlined in `emitAbortMarker`: the thing worth
 * guarding is a DECISION (is this verdict understating the damage?), and a decision
 * inlined in a crash handler can only be tested by crashing the runner. Extracted, the
 * exact predicate that renders a release verdict is unit-testable in milliseconds.
 *
 * THE DEFECT THIS ENCODES (measured, run 4, 2026-08-30):
 *
 *   AFFECTED_TESTS_RESULT status=aborted tasks=121 failed=0 quarantinedFailed=0 \
 *     timedOutTasks=0 undeterminedTasks=0 reason=exit-without-verdict code=1
 *
 * Every counter zero — which reads as "121 tasks ran, nothing failed". In fact ~85 tasks
 * had started and one had ALREADY exited 1 (a governed-admission error under a pgbouncer
 * CONNECTION_CLOSED), logged three lines above that very verdict. The run died between
 * OBSERVING that exit and TALLYING it: the crash arrived from an async postgres.js
 * `Immediate` callback, so the run loop's `failed++` never executed.
 *
 * So the tally fields are not wrong so much as UNGROUNDED at abort time — they report
 * what was counted, and counting is precisely what the crash pre-empted. The observation
 * counters (`observedNonzeroExits`, `observedAdmissionErrors`) are incremented where the
 * outcome is SEEN, so they survive that window and can contradict a too-clean tally.
 *
 * `tasks=` is the PLANNED count, which is what makes the all-zeros line so misleading:
 * the one large number in it is the one number that does NOT mean "ran".
 */

/**
 * Render the trailing counter fields for a terminal AFFECTED_TESTS_RESULT line.
 *
 * Fields are appended TRAILING so the existing prefix (through `undeterminedTasks=`)
 * stays byte-identical for anything already parsing this line — the same additive
 * discipline AFFECTED_TASK_PROGRESS uses for `watchdogDeadlineMs`.
 *
 * @param {{
 *   failed?: number,
 *   observedNonzeroExits?: number,
 *   observedAdmissionErrors?: number,
 * }} counters
 * @returns {{ text: string, undercount: boolean }}
 */
export function formatTerminalCounterFields(counters = {}) {
  // Coerced defensively: this runs on the crash path, where a counter may legitimately
  // not exist yet (an abort before the run loop reads the pre-upgrade closure). A
  // `NaN`/`undefined` leaking into a release verdict would be worse than a zero.
  const observedNonzeroExits = toCount(counters.observedNonzeroExits);
  const observedAdmissionErrors = toCount(counters.observedAdmissionErrors);
  const failed = toCount(counters.failed);

  // THE PREDICATE. Something was seen exiting nonzero, yet the tally says nothing
  // failed — the two disagree, and the tally is the one that cannot be trusted here.
  //
  // Deliberately NOT `observedNonzeroExits !== failed`: the tally legitimately runs
  // AHEAD of, or level with, observation on a healthy run, and quarantined failures are
  // counted separately. Only the strict `failed === 0` case is unambiguous enough to
  // assert on, and a guard that fires on ambiguity is a guard people learn to ignore.
  const undercount = observedNonzeroExits > 0 && failed === 0;

  let text =
    ` observedNonzeroExits=${observedNonzeroExits}` +
    ` observedAdmissionErrors=${observedAdmissionErrors}`;

  if (undercount) {
    // Stated in words, not left as two numbers a reader must notice disagree. The
    // failure being prevented is a HUMAN one: run 4's verdict was nearly read as a
    // near-pass because `failed=0` is the shape of good news.
    text +=
      ` ⚠ TALLY-UNDERCOUNT: ${observedNonzeroExits} task(s) were OBSERVED exiting nonzero` +
      ` but failed=0 — this run died between observing an exit and counting it, so the` +
      ` tally fields above UNDERSTATE the damage. NOT a clean run. Do not read failed=0` +
      ` as "nothing failed"; \`tasks=\` is the PLANNED count, not the number that ran.`;
  }

  return { text, undercount };
}

function toCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
