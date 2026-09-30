/**
 * D-021/P-002: report the serial-equivalent task work performed by
 * `scripts/affected-tests.mjs`.
 *
 * D-021 introduced this helper while workspace suites ran strictly serially, so the summed leg
 * duration was also phase wall time. P-002 now overlaps them under a single worker/memory budget.
 * The sum remains useful as SERIAL-EQUIVALENT WORK, but it is no longer elapsed wall time. The
 * exported names and `serialMs` marker field remain stable for downstream compatibility; human
 * wording must make the updated units explicit.
 *
 * WHY THIS IS A SEPARATE MODULE rather than inline in affected-tests.mjs — the same argument as
 * load-suspect.mjs and task-exit-class.mjs: a claim nothing executes is a claim nothing can
 * contradict. Inline, this arithmetic would run only during a real multi-workspace suite run
 * (minutes long, needing a loaded box to be representative), so a wrong bound would be
 * discovered by being quoted in a planning decision rather than by failing a test.
 *
 * ⚠ THE BOUND IS AN UPPER BOUND, AND THAT IS THE WHOLE POINT OF STATING IT CAREFULLY.
 * Even with concurrent execution, a batch cannot finish faster than its LONGEST single leg, so
 * `serialMs / longestMs` is the most perfect overlap could EVER buy versus serial execution. It
 * ignores host contention and the scheduler's two-lane shape, so it remains a theoretical bound,
 * never an achieved or forecast speedup.
 */

/**
 * Reduce recorded legs to the phase's shape. Returns `null` for an empty set, so a caller that
 * ran zero tasks (`--print-affected`, a no-op selection) emits nothing at all rather than a row
 * of zeros — a zeroed measurement reads like a real one that found nothing, which is the
 * failure mode this whole module exists to avoid.
 *
 * @param {Array<{ name: string, ms: number }>} legs
 * @param {{ wallMs?: number }} [opts] measured phase wall; omit it rather than passing a
 *   placeholder, so an unmeasured phase reports no achieved overlap instead of 0.00x.
 */
export function summarizeSerialPhase(legs, opts = {}) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const clean = legs
    .filter((leg) => leg && typeof leg.ms === 'number' && Number.isFinite(leg.ms) && leg.ms >= 0)
    .map((leg) => ({ name: String(leg.name ?? '(unnamed)'), ms: leg.ms }));
  if (clean.length === 0) return null;

  // Legacy field name: this is the sum of task durations (serial-equivalent work), not current
  // scheduler wall time. Keep the marker stable; make the units explicit in rendered prose.
  const serialMs = clean.reduce((n, leg) => n + leg.ms, 0);
  const longest = clean.reduce((a, b) => (b.ms > a.ms ? b : a));
  // A single leg, or an all-zero set, can buy nothing by being parallelized: 1.00x, never a
  // divide-by-zero and never an Infinity dressed up as an opportunity.
  const ceilingX = longest.ms > 0 ? serialMs / longest.ms : 1;

  // ACHIEVED overlap, when the caller measured the phase's actual wall. `ceilingX` above is a
  // BOUND — what perfect overlap could buy. It cannot say what the scheduler ACTUALLY got, and
  // the gap between the two is the whole question when deciding whether a run is short of
  // concurrency or short of nothing. Reconstructing it after the fact is not possible from the
  // log: AFFECTED_TASK_PROGRESS lines carry no timestamps, the log is not written in
  // chronological order (per-leg captured output is flushed when a leg ends), and
  // harness_shared.test_runs stamps commit_sha on only a fraction of gate rows. So the phase
  // measures its own wall or the number does not exist.
  //
  // Left undefined when the caller did not measure it: a MISSING measurement must not render as
  // a real one, which is the same reason summarizeSerialPhase returns null for an empty leg set
  // rather than a row of zeros.
  const wallMs =
    typeof opts.wallMs === 'number' && Number.isFinite(opts.wallMs) && opts.wallMs > 0
      ? opts.wallMs
      : undefined;
  const achievedX = wallMs !== undefined ? serialMs / wallMs : undefined;

  return {
    legs: clean.length,
    serialMs,
    longestMs: longest.ms,
    longestName: longest.name,
    ceilingX,
    wallMs,
    achievedX,
    slowest: [...clean].sort((a, b) => b.ms - a.ms),
  };
}

/**
 * The greppable marker. Deliberately NOT a field on `AFFECTED_TESTS_RESULT`: that line's shape is
 * pinned by affected-tests-result-line.test.ts and parsed by green-checkpoint, and widening a
 * VERDICT contract to carry a MEASUREMENT is how measurements come to be read as verdicts — the
 * same reasoning that keeps the load-suspect marker on its own line.
 */
export function formatSerialPhaseMarker(summary) {
  // The wall pair is APPENDED, never interleaved, and omitted entirely when unmeasured — an
  // existing consumer keeps matching the prefix it already matches, and absence stays visibly
  // absent rather than becoming a zero.
  const wall =
    summary.wallMs !== undefined
      ? ` wallMs=${summary.wallMs} achievedX=${summary.achievedX.toFixed(2)}`
      : '';
  return (
    `AFFECTED_TESTS_PHASE legs=${summary.legs} serialMs=${summary.serialMs} ` +
    `longestMs=${summary.longestMs} ceilingX=${summary.ceilingX.toFixed(2)}${wall}`
  );
}

const secs = (ms) => (ms / 1000).toFixed(1);

/**
 * The full human-readable block, marker first. Returns [] for an empty/degenerate leg set so the
 * caller can splat it unconditionally.
 *
 * @param {Array<{ name: string, ms: number }>} legs
 * @param {{ topN?: number, wallMs?: number }} [opts]
 */
export function formatSerialPhaseSummary(legs, opts = {}) {
  const summary = summarizeSerialPhase(legs, opts);
  if (!summary) return [];
  const topN = opts.topN ?? 5;

  const lines = [
    '',
    formatSerialPhaseMarker(summary),
    `  task work:    ${secs(summary.serialMs)}s serial-equivalent across ${summary.legs} leg(s) ` +
      `(scheduler may overlap legs)`,
    `  longest leg:  ${secs(summary.longestMs)}s — ${summary.longestName}`,
    `  ceiling:      ${summary.ceilingX.toFixed(2)}x — ideal overlap versus serial execution ` +
      `(bounded by the longest leg; ignores host contention and achieved overlap, so it is a bound and not a forecast)`,
  ];
  if (summary.wallMs !== undefined) {
    lines.push(
      `  phase wall:   ${secs(summary.wallMs)}s elapsed — first leg start to last leg end`,
      `  achieved:     ${summary.achievedX.toFixed(2)}x of the ${summary.ceilingX.toFixed(2)}x ceiling ` +
        `(MEASURED overlap: serial-equivalent work divided by elapsed wall)`,
      `  headroom:     ${secs(summary.wallMs - summary.longestMs)}s of wall beyond the longest leg — ` +
        `what perfect overlap could still remove, and 0 means the phase is already bounded by that one leg`,
    );
  }
  for (const leg of summary.slowest.slice(0, topN)) {
    lines.push(`    ${secs(leg.ms).padStart(7)}s  ${leg.name}`);
  }
  return lines;
}
