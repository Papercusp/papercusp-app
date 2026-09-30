/**
 * loop-goal-fact-divergence.ts — EI-21459285533379701.
 *
 * THE BUG. `loop:arm`'s `goal` is frozen at arm time. `facts:assert` can CORRECT a
 * claim after that, and the correction cannot reach the frozen goal — they are
 * independent carry surfaces. So the goal keeps asserting a claim its own author has
 * since withdrawn, on every wake, and the carry document faithfully reproduces it.
 *
 * The measured instance: an agent asserted `guard-rail:trigger-poll-liveness-instruments`
 * at 20:33Z, CORRECTING its own earlier rule that a stale `trigger_sources.updated_at`
 * proves a fault (it does not — the column only advances when a poll WRITES, so a
 * connected idle mailbox legitimately freezes it). That retracted rule was also baked
 * into a goal armed at 20:01Z and already fired 15 times. At 20:43Z the agent woke,
 * read a 15-minute-stale value, and concluded "REAL FAULT" exactly as the goal
 * instructed. The mailbox was healthy. It was caught only by noticing the fact's
 * correction stamp post-dated the carry build — luck, not process.
 *
 * WHY THE EXISTING SURFACES DO NOT COVER IT.
 *  - `loop-goal-staleness.ts` judges the same goal, but against WORK-ITEM IDS it names.
 *    A retracted claim names no id, so it is invisible there.
 *  - `contested-fold.ts` marks the FACT when >=2 OTHER agents wrote to the key. A
 *    SELF-correction has no other authors, so it never fires; and even when it does, it
 *    marks the fact, not the goal that still echoes the withdrawn version.
 * The gap is precisely: the goal surface, for a claim its own author corrected.
 *
 * ⚠ THE SELECTIVITY IS IN THE GATING POPULATION, NOT THE THRESHOLD — measured, because
 * the obvious implementation is noise. Comparing the goal against ALL of an owner's
 * standing facts fires on 69% of live loops (20/29 measured), dominated by the
 * `launch-provenance` boilerplate every agent holds, which shares fleet/session
 * vocabulary with every mission-shaped goal. Gating on facts CORRECTED SINCE THE LOOP
 * WAS ARMED — the only population where the goal provably cannot reflect the current
 * claim — fires on 1 of 39 live loops. Same threshold, same tokenizer; the gate is what
 * makes it a signal. A caller that widens the population must re-measure.
 *
 * ⚠ NEVER ANNOUNCE WHAT WAS NOT MEASURED, the same rail `loop-goal-staleness` carries.
 * An unknown arm time and a failed fact read both mean "cannot judge", and both yield
 * NO note rather than a reassuring or an alarming one. Only a positive, dated
 * correction produces output.
 *
 * Pure + clock-free: corrections come in as data with their timestamps, so this is
 * exhaustively testable with no PG.
 */
import { overlappingFacts } from '../../facts/fact-text-overlap';

/** A standing fact whose CURRENT version superseded an earlier one. */
export interface CorrectedFact {
  key: string;
  /** The CURRENT (corrected) body — what the goal should have said. */
  body: string;
  /** When the correction landed. Compared against the loop's arm time. */
  correctedAtMs: number;
}

export interface GoalFactDivergenceVerdict {
  /**
   * Facts corrected AFTER the goal was frozen whose subject the goal still discusses,
   * strongest overlap first. Empty ⇒ nothing to say.
   */
  diverged: Array<{ key: string; shared: number; correctedAtMs: number }>;
  /** The wake annotation, or null when there is nothing honest to say. */
  note: string | null;
}

/** At most this many keys are named in the note — beyond it the line stops being read. */
const MAX_NAMED_KEYS = 3;

/**
 * Judge a frozen goal against facts corrected since it was armed.
 *
 * `armedAtMs` null (or non-finite) ⇒ the arm time is unknown, so "corrected since
 * arming" is unanswerable and the verdict is empty. `corrected` must be built from a
 * SUCCESSFUL read; pass an empty array for a failed one, which correctly yields no
 * claim at all rather than a false all-clear dressed as a measurement.
 */
export function assessGoalFactDivergence(
  goal: string | null | undefined,
  corrected: ReadonlyArray<CorrectedFact>,
  armedAtMs: number | null | undefined,
): GoalFactDivergenceVerdict {
  if (armedAtMs == null || !Number.isFinite(armedAtMs)) return { diverged: [], note: null };
  const since = corrected.filter(
    (f) => Number.isFinite(f.correctedAtMs) && f.correctedAtMs > armedAtMs,
  );
  if (!since.length) return { diverged: [], note: null };

  const byKey = new Map(since.map((f) => [f.key, f]));
  const diverged = overlappingFacts(goal, since).map((h) => ({
    key: h.key,
    shared: h.shared,
    // Non-null by construction: every hit key came from `since`.
    correctedAtMs: byKey.get(h.key)!.correctedAtMs,
  }));

  return { diverged, note: renderNote(diverged) };
}

/**
 * The annotation.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY — the same discipline as `loop-goal-staleness`.
 * It fires exactly when the goal text is dangerous; a reassurance on every healthy wake
 * would be scenery within a day, and scenery is what the generic "frozen at arm time"
 * caution already became.
 *
 * It states a MEASUREMENT ("you corrected this key after arming, and the goal still
 * discusses it") and names the repair, rather than asking the reader to go and check.
 */
function renderNote(
  diverged: ReadonlyArray<{ key: string; correctedAtMs: number }>,
): string | null {
  if (!diverged.length) return null;
  const named = diverged.slice(0, MAX_NAMED_KEYS).map((d) => d.key).join(', ');
  const more = diverged.length > MAX_NAMED_KEYS ? ` (+${diverged.length - MAX_NAMED_KEYS} more)` : '';
  const subject =
    diverged.length === 1 ? 'a standing fact covering the same subject was' : 'standing facts covering the same subject were';
  return (
    `⚠⚠ THIS GOAL MAY ECHO A CLAIM YOU HAVE SINCE WITHDRAWN — ${subject} ` +
    `CORRECTED after this loop was armed: ${named}${more}. A fact and a goal are ` +
    `INDEPENDENT carry surfaces: facts:assert corrected the fact, and nothing can reach the ` +
    `frozen goal, so the goal keeps asserting the superseded version with more apparent ` +
    `authority than the correction. Re-read the fact (facts:list { scope: 'owner', key }) ` +
    `BEFORE acting on the goal; where they disagree the FACT is current. Then re-arm with ` +
    `corrected text (loop:arm { goal }) so the next wake stops repeating it.`
  );
}
