/**
 * Detects a RETRACTION or CORRECTION of a population claim in coord traffic.
 *
 * Plan `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`,
 * P-003 — the second of the plan's two independent signals. The bet is that
 * showing an agent a predicate's PARTITION instead of a bare scalar changes what
 * it concludes; if that is true, the rate at which agents publicly walk back
 * population claims should move. If it is false, this number will not move while
 * the advisory fires constantly — and the plan's acceptance bar exists to keep
 * that verdict reachable.
 *
 * ⚠ THIS IS DELIBERATELY NOT A `CoordBucket`.
 * `categorizeCoordMessage` is FIRST-MATCH-WINS, with its ordering encoding
 * precedence. Adding a bucket there would silently steal messages from
 * `finding-health` and `contextual` and move dev:coord_categorize's published
 * headline percentages — a behavioural strand in another instrument, introduced
 * while building this one. It is also what the acceptance bar requires: this
 * predicate is evaluated over ALL authored traffic, orthogonally, and is never
 * joined to advisory fires. A correction is counted whether or not an advisory
 * preceded it. That independence is the only reason the pair of signals can
 * return the verdict "the advisory fired constantly and changed nothing."
 *
 * ==========================================================================
 * CALIBRATED AGAINST REAL TRAFFIC, NOT GUESSED
 * ==========================================================================
 * Measured over harness_shared.coord_event_log, surface='messages',
 * workspace 'papercusp-workspace', 14 days to 2026-09-20 (122,386 rows).
 * A naive prose predicate scored 10,760 "corrections". The GROUP BY partition
 * over the `auto` dimension showed it had measured ECHO, not corrections:
 *
 *              total    retract   'correcti'   'i was wrong'
 *   authored   40,065      777       5,049          32
 *   automated  82,320    2,217       2,033           9
 *
 * Two independent false-positive sources, both fatal if left unhandled:
 *
 *   1. AUTOMATED ECHO. "retract" appears ~3x MORE often in automated traffic
 *      than in authored traffic, because carry-notes, loop-wake blocks and
 *      carried-check lists QUOTE the word while reporting on prior work. Those
 *      are not corrections; they are machine restatements of one. Hence
 *      `auto === true` is excluded, and a future maintainer tempted to "also
 *      count automated traffic for completeness" would be re-introducing the
 *      dominant error term, not improving coverage.
 *
 *   2. "correction" IS ORDINARY AGENT VOCABULARY. The `correcti` stem scored
 *      4,550 authored hits, and a follow-up partition showed 4,549 of them are
 *      the genuine words correction/correcting/corrective. Agents discuss
 *      corrections constantly — in plans, checkpoints, and meta-prose like this
 *      very docstring — without any claim being walked back. BREADTH is the
 *      defect, not a stem collision, which is why a speech act alone is
 *      insufficient and must be conjoined with a population referent below.
 *
 *      ⚠ RETRACTED, AND LEFT HERE ON PURPOSE: an earlier revision of this
 *      comment asserted that the stem matched "correctLY" and that this
 *      explained the count. It does not. "correctly" is c-o-r-r-e-c-t-L-y and
 *      the stem cannot match it — measured, 343 authored messages contain
 *      "correctly" and 313 of those contain no "correcti" at all, so they were
 *      never counted in the first place. That was a plausible-sounding mechanism
 *      invented to explain a real number, and it is precisely the failure this
 *      plan exists to correct: a scalar acted on through an unverified story
 *      about what produced it. It is recorded rather than quietly deleted so the
 *      next reader inherits the trap along with the fix. The permanent negative
 *      control in the sibling test file is what caught it.
 *
 * Spot-checking authored hits also returned non-corrections ("TAKING THE GATE",
 * "MOVED: plan ..."), so a speech act alone is still not enough: a match
 * additionally requires a POPULATION referent, because this plan is about claims
 * over populations, not about retractions in general.
 */
import type { CoordMsgLike } from './corpus-categorize';

/**
 * The author is walking back something THEY previously asserted.
 * Word-anchored throughout — see the `correctLY` note above.
 */
const SPEECH_ACT =
  /\b(retract(s|ed|ing|ion)?|withdraw(n|s|ing)?|miscount(ed|s)?|over-?count(ed|s)?|under-?count(ed|s)?|overstated|understated|supersed(e|es|ed)|correction|corrected|correcting)\b|\bi was wrong\b|\bthat (count|number|figure|total) (was|is) (wrong|off)\b|\bmy (earlier|previous|prior) (claim|count|number|finding|figure)\b/i;

/**
 * The thing being walked back is a claim about a POPULATION — a count, a share,
 * or a set of rows. A multi-digit number counts: a corrected population claim in
 * this corpus almost always restates the figure it is replacing.
 */
const POPULATION_REFERENT =
  /\b(count(s|ed|ing)?|rows?|population|total(s)?|tally|percent(age)?|share|majority|all of them|none of them|every one|\d+\s*(of|\/)\s*\d+)\b|\d{2,}|%/i;

/**
 * An automated emission restating prior work, not an author correcting a claim.
 * `auto` is set by coord:emit; the textual markers catch automated bodies that
 * reach this corpus without the flag (loop-wake and carried-check blocks).
 */
const MACHINE_RESTATEMENT = /\bloop wake #\d+|\bCARRIED CHECKS\b|⧟\s*LIVE:|\bshort form \(the full loop contract\b/i;

/**
 * A POSIX-ERE prefilter for pushing the cheap half of this predicate into SQL.
 *
 * A 7-day window of this corpus is ~60k rows; pulling them all into memory to
 * run the TS predicate is not an option, so the database narrows first. That
 * makes this string load-bearing in a dangerous way: if it is ever NARROWER
 * than `SPEECH_ACT`, candidates are dropped before the real predicate ever sees
 * them and the instrument silently under-counts — reporting a fall in
 * corrections that is really a fall in what was fetched. Exactly the kind of
 * definitional artifact that would be read as evidence FOR the advisory.
 *
 * It is therefore deliberately BROADER than SPEECH_ACT (stems, not word-anchored
 * forms; precision is re-applied in TS afterwards), and a test asserts the
 * superset property against every alternative SPEECH_ACT accepts. Note \\b is not
 * POSIX — this stays unanchored rather than using \\y, since breadth is the goal.
 */
export const SPEECH_ACT_SQL_PREFILTER =
  '(retract|withdraw|miscount|over-?count|under-?count|overstat|understat|supersed|correction|corrected|correcting|was wrong|is wrong|was off|is off|my earlier|my previous|my prior)';

/** The text this predicate reads: the message body, falling back to its summary. */
export function correctionText(m: CoordMsgLike): string {
  return `${m.body ?? ''}\n${m.summary ?? ''}`;
}

export interface CorrectionMatch {
  isCorrection: boolean;
  /** Why not, when it is not — so a calibration run can be read, not just totalled. */
  rejectedBecause?: 'automated' | 'machine-restatement' | 'no-speech-act' | 'no-population-referent';
}

/**
 * Is this message an authored retraction/correction of a population claim?
 *
 * Order matters for the diagnosis, not the verdict: the automated checks run
 * first so a calibration report attributes an excluded message to the dominant
 * error term rather than to whichever pattern happened to miss.
 */
export function matchPopulationClaimCorrection(m: CoordMsgLike): CorrectionMatch {
  if (m.auto === true) return { isCorrection: false, rejectedBecause: 'automated' };

  const text = correctionText(m);
  if (MACHINE_RESTATEMENT.test(text)) {
    return { isCorrection: false, rejectedBecause: 'machine-restatement' };
  }
  if (!SPEECH_ACT.test(text)) {
    return { isCorrection: false, rejectedBecause: 'no-speech-act' };
  }
  if (!POPULATION_REFERENT.test(text)) {
    return { isCorrection: false, rejectedBecause: 'no-population-referent' };
  }
  return { isCorrection: true };
}

/** Convenience predicate. */
export function isPopulationClaimCorrection(m: CoordMsgLike): boolean {
  return matchPopulationClaimCorrection(m).isCorrection;
}

export interface CorrectionReport {
  /** Every message considered, automated included — the denominator's denominator. */
  messages: number;
  /** Authored messages: the population this rate is actually over. */
  authored: number;
  /**
   * Authored messages carrying a correction SPEECH ACT, whether or not the thing
   * being walked back was a population claim.
   *
   * Reported beside `corrections` on purpose. Deciding from prose whether a
   * retraction concerned a POPULATION is the genuinely uncertain step here, and
   * a single headline scalar would hide that uncertainty behind a confident
   * number — which is the exact failure this plan exists to correct. Publishing
   * both lets a reader see whether a before/after movement is real or an
   * artifact of where the population-referent line was drawn: if `corrections`
   * moves while `speechActs` does not (or vice versa), the filter is doing the
   * work, not the advisory.
   */
  speechActs: number;
  corrections: number;
  /** corrections / authored, or null when there is nothing to divide by. */
  ratePerAuthored: number | null;
  /** Why the excluded messages were excluded — a calibration aid, not a metric. */
  rejected: Record<NonNullable<CorrectionMatch['rejectedBecause']>, number>;
}

/**
 * Count corrections over a corpus.
 *
 * The rate is expressed per AUTHORED message rather than per message, because
 * automated traffic is ~2/3 of the corpus here and its volume moves for reasons
 * (fleet size, loop cadence) that have nothing to do with the advisory. A rate
 * whose denominator drifts with headcount cannot settle a before/after bet.
 */
export function countPopulationClaimCorrections(
  messages: readonly CoordMsgLike[],
): CorrectionReport {
  const rejected: CorrectionReport['rejected'] = {
    automated: 0,
    'machine-restatement': 0,
    'no-speech-act': 0,
    'no-population-referent': 0,
  };
  let authored = 0;
  let corrections = 0;

  for (const m of messages) {
    const r = matchPopulationClaimCorrection(m);
    if (m.auto !== true) authored++;
    if (r.isCorrection) corrections++;
    else if (r.rejectedBecause) rejected[r.rejectedBecause]++;
  }

  // A message reaching 'no-population-referent' already cleared the speech-act
  // gate, so the broader count is exactly the two together. Derived rather than
  // tallied separately so the two can never drift apart.
  const speechActs = corrections + rejected['no-population-referent'];

  return {
    messages: messages.length,
    authored,
    speechActs,
    corrections,
    ratePerAuthored: authored > 0 ? corrections / authored : null,
    rejected,
  };
}
