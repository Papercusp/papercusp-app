/**
 * carry-note-unread-run — EI-19455262557905604.
 *
 * `checks: [{ claim, recheck?, verified? }]` on `work_items:checkpoint` already
 * carries the VERIFIED-vs-PREDICTED distinction: `verified` is an evidence STRING
 * whose presence renders `✓ VERIFIED` and whose absence renders `? PREDICTED`.
 * It landed 2026-08-02T01:31Z. The problem is not that it is missing — it is that
 * it is INVISIBLE at the one moment it is actionable.
 *
 * Two independent misses, both AFTER the field shipped, are what this module
 * answers:
 *
 *  1. A checkpoint written ~5h after `checks` landed still wrote `RESOLVED (6)` vs
 *     `REMAINING (5) — NOT yet diagnosed` as flat prose. All 5 "REMAINING" files
 *     were already green; a successor nearly "fixed" 5 passing files.
 *  2. ~40h after it shipped, an su read the tool, concluded "there is no field,
 *     badge, or convention separating them", and filed to BUILD it. Miss (2) is
 *     the sharper signal: not merely unused, but undiscoverable to someone
 *     deliberately looking.
 *
 * This is the D-016 shape, and this repo has solved it once already: `loop:arm`'s
 * `blockedOn` measured ZERO uses in 294 arm calls across 91 arming agents (14d).
 * D-098's fix was NOT to document it harder — it was to surface the affordance at
 * the one moment it is actionable, on a STRUCTURAL trigger. This mirrors those
 * constraints exactly: advisory, no rejection, no behaviour change, fail-open.
 *
 * MEASURED BASELINE (2026-09-05, harness_shared.carry_notes, papercusp-workspace,
 * scope LIKE 'workitem:%'). The filing itself reported `0 / 0` and correctly
 * labelled it a FALSE ZERO from a wrong accessor (`metadata->>'checkpoint'`);
 * checkpoints are carry-notes. The real numbers:
 *   - 10,475 work-item carry-notes; 919 (8.8%) carry a `## Checks` section.
 *   - Last 14d: 530 / 7,849 = 6.75% — adoption is LOWER recently, i.e. not rising.
 *   - 676 (6.5%) contain in-flight vocabulary; 447 of those carry no checks.
 *   - 132 (1.26%) carry in-flight vocabulary AND a run artifact AND no checks.
 * That last figure is this advisory's firing rate, and it is why BOTH positive
 * signals are required: at 1.26% it is rare enough to be read, which is the D-004
 * property an advisory firing on every write does not have.
 *
 * WHY BOTH SIGNALS, AND WHY NO "RESULT LINE" SUPPRESSOR. The in-flight vocabulary
 * IS the writer's own statement that the result is unread — "still running",
 * "NOT yet diagnosed", "awaiting result". Adding a fuzzy result-detector on top
 * would buy nothing and could suppress a true positive, which is the worse failure
 * direction: an advisory that silently does not fire is indistinguishable from one
 * that had nothing to say.
 *
 * WHY THE TRIGGER IS PROSE AND NOT STRUCTURAL. Half of it IS structural — "this
 * write stored zero check rows" is a fact about the note, not a guess about it.
 * The other half cannot be: nothing in the argument surface says "I launched a run
 * I have not read". D-098 had an interval to key on; there is no equivalent
 * argument here, which is exactly the "wherever possible" carve-out in the filing.
 */

/**
 * The writer's own admission that a result is not yet in hand.
 *
 * Deliberately narrow. `launched` alone is far too common ("launched a fleet"),
 * which is why a run artifact is also required before anything fires.
 */
const IN_FLIGHT_RE =
  /\b(?:launched|in[-\s]flight|still running|not yet diagnosed|not yet read|awaiting (?:the )?results?|pending results?|results? (?:are )?pending)\b/gi;

/**
 * A reference to a run whose output lives somewhere OTHER than this note — the
 * thing that makes the prose above a prediction rather than a report.
 */
const RUN_REF_RE = /(?:\/tmp\/\S+|\S+\.log\b|bash_id|run_in_background|bash_output)/gi;

/** Cap on how many matched fragments are echoed back, so the note stays one line. */
const MAX_SIGNALS = 3;

export interface UnreadRunSignals {
  /** In-flight phrases this body used (deduped, lowercased, capped). */
  inFlight: string[];
  /** Run artifacts this body referenced (deduped, capped). */
  runRefs: string[];
}

export interface UnreadRunAdvisory {
  flagged: true;
  note: string;
  signals: UnreadRunSignals;
}

function collect(text: string, re: RegExp, lower: boolean): string[] {
  const seen = new Set<string>();
  // A `g` regex carries lastIndex across calls; matchAll consumes a fresh clone.
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    // A path is greedy to a whitespace boundary, so it absorbs the sentence
    // punctuation that follows it — `/tmp/run.log.` rather than `/tmp/run.log`.
    // Echoing that back reads like a different (nonexistent) file, so trim it.
    const raw = m[0].trim().replace(/[.,;:!?)\]}>"']+$/, '');
    if (!raw) continue;
    const key = lower ? raw.toLowerCase() : raw;
    if (!seen.has(key)) seen.add(key);
    if (seen.size >= MAX_SIGNALS) break;
  }
  return [...seen];
}

/**
 * Describe a checkpoint body that reports a launched-but-unread run in prose while
 * storing no `checks` rows.
 *
 * @param body            the checkpoint prose SUPPLIED BY THIS CALL (not the merged
 *                        stored note) — the same choice `absenceLint` makes, so a
 *                        later checks-only patch is not re-flagged for old prose.
 * @param storedChecks    how many `## Checks` rows the FINAL stored note ended up
 *                        with. Any row at all suppresses: the writer has clearly
 *                        found the affordance, and this advisory exists only to
 *                        point at it.
 * @returns the advisory, or `null` when there is nothing to say.
 */
export function describeUnreadRun(
  body: string | null | undefined,
  storedChecks: number,
): UnreadRunAdvisory | null {
  if (storedChecks > 0) return null;
  const text = (body ?? '').trim();
  if (!text) return null;

  const inFlight = collect(text, IN_FLIGHT_RE, true);
  if (inFlight.length === 0) return null;
  const runRefs = collect(text, RUN_REF_RE, false);
  if (runRefs.length === 0) return null;

  return {
    flagged: true,
    note:
      'unread_run_lint: this checkpoint describes a run you launched but have not read ' +
      `(${inFlight.join(', ')} — ${runRefs.join(', ')}) and stores no check rows, so its ` +
      'status lines will reach your successor as prose it cannot tell apart from measurement. ' +
      'Pass `checks:[{ claim, recheck }]` and OMIT `verified` — that renders the row ? PREDICTED, ' +
      'so the next holder re-measures instead of trusting it. Add `verified:"<evidence>"` only for ' +
      'a result you actually read. Advisory only; the write was kept.',
    signals: { inFlight, runRefs },
  };
}
