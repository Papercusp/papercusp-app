/**
 * success-metrics.ts — the blender-self-learning program's DONE-CHECK
 * (blender-self-learning-2026-07-12 P-015).
 *
 * The program shipped a learning substrate (rubric-grounded ideation, a routed-idea
 * ledger, volume-mode cadence, grading throughput). P-015 asks the one question that
 * closes it: **did the substrate actually start working, on real rows?** — not "do the
 * tests pass" (they did, while the rubric lane sat silently at zero for its whole life)
 * but "is the shipped instrumentation reading back the values the program promised?".
 *
 * So this is a GATE, not another metric: five named bars, each PASS / FAIL / UNKNOWN,
 * evaluated against the ledgers the program itself shipped.
 *
 * Three layers, the same split as {@link ./quality-metrics} (whose readers + report this
 * module REUSES rather than re-querying — a second PG read of the same ledgers is how the
 * two surfaces would silently disagree):
 *
 *  1. **Pure core** — {@link evaluateProgramSuccess} folds the injected ledger snapshots
 *     ({@link ScoutQualityInputs}) into a {@link ProgramSuccessReport}. No PG, no clock.
 *  2. **Assembly** — {@link buildProgramSuccessReport} reads the real ledgers via
 *     {@link buildQualityReportInputs} (lazy PG edge) and folds them.
 *  3. **Surface** — `blender:success-metrics` (agent-tools/scout/success-metrics.ts) makes
 *     it QUERYABLE, which is the actual P-015 deliverable: a check nobody can run is not a
 *     gate. (quality-metrics' own degradation watchdog was built, tested, and never wired
 *     to a caller — this module deliberately ships with its consumer.)
 *
 * ## UNKNOWN is a first-class verdict
 * A bar whose DENOMINATOR is empty is `unknown`, never `pass` and never `fail`: an empty
 * window cannot prove the substrate works, and it must not be allowed to silently certify
 * the program done. The standing house rule — a decision procedure must be shown to
 * DISCRIMINATE on real data before it may act (agent-insights/prove-it-discriminates-
 * before-it-acts) — is why every bar below reports what it actually measured (`observed`)
 * next to the bar it was judged against (`bar`), so a green gate can be audited rather
 * than trusted.
 */

import { groundingLaneHistogram } from './scheduler';
import { computeScoutQualityReport, foldScoutTickStats, buildQualityReportInputs, type ScoutQualityInputs } from './quality-metrics';
import type { BuildQualityInputsOptions } from './quality-metrics';
import type { ScoutTickRecord } from './tick-ledger';
// EI-12146: the rolling-window FALLBACK below shares its ms value with
// resolveCriterionWindow()'s own default (rubric-template.ts is dependency-free, exactly
// so instruments can import it without a PG edge) — the last remaining "two independent
// 48h hardcodes" seam this item was filed to close. The tool surface
// (agent-tools/scout/success-metrics.ts) resolves the REAL default from the
// blender-release-readiness rubric's own declared criterion window; this constant is
// only the safety-net used when that rubric read is unavailable.
import { DEFAULT_CRITERION_WINDOW_MS } from '../agent-tools/plans/rubric-template';
import { hasForcedDiversity } from './invariants';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import type { CreativeLens, SuIdeationLens } from './types';
import { SU_IDEATION_LENSES } from './types';
import { cellUnknown, type CellUnknown } from '../cell-contract';

/** The digest lane a rubric-RATING-grounded idea is attributed to (scheduler's histogram key). */
export const RUBRIC_GROUNDING_LANE = 'rubric-rating';

/**
 * How many of the NEWEST scout-routed ideas the lens-diversity bar looks at (WI-4482).
 *
 * It MUST be a recent sample, not the whole window: the roster collapsed to a single lens
 * on 2026-06-25, but the ledger still holds multi-lens rows from 2026-06-11, so a lifetime
 * `distinct(lens)` count reports 4 lenses and PASSES a bar that is presently broken. Judging
 * a live-health question over a window that straddles the regression is the same
 * measure-across-a-boundary error that made the ledger-reconcile bar read as drift
 * (LEDGER_RECONCILE_EPOCH_MS) — here the fix is a recency sample rather than an epoch floor,
 * because "is the roster diverse RIGHT NOW" has no fix-boundary to anchor to.
 */
export const LENS_DIVERSITY_SAMPLE = 20;

/**
 * The program spans TWO ledger partitions, and the bars do not all live on the same one —
 * reading only one silently turns half the gate into UNKNOWN (the first live run of this
 * module did exactly that, and it looked like missing data rather than a bug in the read):
 *
 *  - **cadence** (`origin:'scout'`) — the ticks the CADENCE GATE actually governs. Only a
 *    Scout cycle is gated, scored, and joined to a cycleId, so the volume-mode, error-rate
 *    and reconciliation bars can ONLY be judged here. A `su-ideate` tick is a hand-recorded
 *    pass (blender:ideate-pass-record): it never gates, never carries a signal score, and
 *    never routes under a cycleId — asking it those questions is a category error.
 *  - **ideas** — every routed idea, BOTH origins. Rubric grounding and grader adoption are
 *    properties of the SUBSTRATE'S OUTPUT, wherever the idea came from; partitioning them
 *    would hide (e.g.) the fact that every graded+adopted idea today is Scout-origin.
 */
export interface ProgramSuccessInputs {
  cadence: ScoutQualityInputs<CreativeLens>;
  ideas: readonly RoutedIdeaProvenance[];
  /**
   * WI-5397 soak-method fix: ticks sharing the CURRENTLY RUNNING scout code's content
   * hash, spanning any number of bg-host restarts that happened to load byte-identical
   * code — UNBOUNDED by time (see tick-ledger.ts's readScoutTicksByCodeHash). Used
   * ONLY for the cycle-error-rate bar's denominator/numerator, replacing the
   * time-windowed `cadence.ticks` there specifically: a fixed sinceMs window resets
   * its tick history to near-zero on every bg-host restart (observed 41min-3.9h
   * between restarts vs the ~30min cadence — a ~48h/~20-tick window needs ~10h
   * UNINTERRUPTED, which restart-zeroing never allows; fact
   * alpha-011-soak-unreachable-as-planned). Undefined ⇒ the bar falls back to the
   * time-windowed `cadence.ticks` (pre-WI-5397 behavior — also the path every
   * existing pure-core fixture takes, since they don't set this).
   *
   * WI-5451: when the assembly layer resolved this from a caller-EXPLICIT window floor
   * (`sinceMs`/`watermarkRef`), `ticks` here is ALREADY intersected with that floor at
   * the PG read (readScoutTicksByCodeHash's own `sinceMs` — see tick-ledger.ts) — this
   * pure core never re-derives or re-applies the floor itself, it just folds whatever
   * union it was handed. The floor and the code-hash predicate are independent and BOTH
   * must hold: the union alone answers "which code produced these ticks", not "which
   * period counts" — replacing the windowed read with an un-floored union let a
   * pre-floor, same-hash tick silently count as post-floor evidence (the defect this
   * item closes). On the implicit rolling-default path (no explicit floor requested)
   * `ticks` stays unbounded by time exactly as before WI-5451.
   */
  cadenceByCodeHash?: { ticks: readonly ScoutTickRecord[]; codeHash: string | null };
  /**
   * GYM TASK CORPUS counts for the harness whose gym feeds this program
   * (plan gym-real-fitness-signal-2026-07-27, P-011).
   *
   * WHY THIS BAR EXISTS AT ALL — the failure it closes is not a bug, it is a
   * BLIND SPOT in this very report. Every other criterion here measures MECHANISM
   * integrity: cycle error rate, ledger reconciliation, lens diversity, grading-loop
   * closure. All of them can be, and were, perfectly green for six consecutive
   * scorecards while the gym's fitness function was three hardcoded toy tasks against
   * a generated 4-line stub (`export function handle(req){ return { status: 404 }; }`,
   * sole gate `node --check`). A release gate that cannot fail when the benchmark is
   * fake is not measuring learning; it is laundering it. So this bar asks the one
   * question none of the others could: IS THE THING WE OPTIMIZE AGAINST REAL?
   *
   * OPTIONAL by construction — an absent value rates `unknown`, never `pass`. Made
   * optional deliberately rather than required: a required field would go stale in
   * every existing fixture and, worse, tempt a fixture author to fill it with a
   * convenient 'real'. Absence must be visibly unproven, not silently fine.
   */
  gymCorpus?: {
    /** Tasks whose corpus is 'real' (derived from genuinely shipped work). */
    realCount: number;
    /** Tasks whose corpus is 'synthetic' (a generated stub substrate). */
    syntheticCount: number;
    /**
     * How many SCORED runs exist against real-corpus tasks.
     *
     * THE LOOPHOLE THIS CLOSES: without it, the bar greens on LABELS alone — insert
     * a few `corpus='real'` rows that nothing can execute and the gate reports a real
     * fitness signal while the gym is still learning nothing. That is the same
     * mistake one level up (certifying an artifact's description instead of its
     * behaviour), and it would be an easy accident for whoever implements P-001. A
     * real corpus only counts once it has actually been RUN and SCORED.
     */
    realScoredRuns?: number;
    /** The harness these counts were read for, for the observed-line provenance. */
    harnessSlug?: string;
  };
}

export type SuccessStatus = 'pass' | 'fail' | 'unknown';

/** One named bar of the program's done-check. */
export interface SuccessCriterion {
  /** Stable key (the join key for a trend read / a scorecard). */
  key: string;
  /** The bar as the plan stated it. */
  bar: string;
  status: SuccessStatus;
  /** What was actually MEASURED — the audit trail behind `status`. */
  observed: string;
  /** Why the bar could not be judged (present only when status==='unknown'). */
  unknownReason?: CellUnknown;
}

export interface ProgramSuccessReport {
  criteria: SuccessCriterion[];
  passed: number;
  failed: number;
  unknown: number;
  /**
   * 'pass' — every bar passed. 'fail' — at least one bar FAILED (a real regression
   * against a promise the program made). 'incomplete' — no failures, but at least one bar
   * is unknown (not enough evidence yet). Only 'pass' closes the program.
   */
  verdict: 'pass' | 'fail' | 'incomplete';
  /** Window provenance, so a verdict is never read without knowing what it saw. */
  window: {
    ticks: number;
    ranCycles: number;
    routedIdeas: number;
    ledgerTruncated: boolean;
    /** Assembly-time tick window; absent for injected pure-core fixtures. */
    tickWindowMs?: number;
    tickSinceMs?: number;
    tickInstallSlug?: string;
    /**
     * WI-5397: the running scout code's content hash the cycle-error-rate bar was
     * ACTUALLY judged against (null when unresolved — the bar then fell back to the
     * time-windowed read) + how many code-identical ticks fed it, so a verdict is
     * auditable rather than trusted. See {@link ProgramSuccessInputs.cadenceByCodeHash}.
     */
    codeHash?: string | null;
    codeHashTicks?: number;
  };
}

export interface ProgramSuccessOptions {
  /** Max cycle error rate before the bar fails (default 0.05 — the plan's <5%). */
  maxErrorRate?: number;
  /**
   * The ledger snapshot hit its row limit, so older rows are missing. Reconciliation is
   * reported `unknown` rather than FAILING on rows the read simply never saw (a truncated
   * read would otherwise manufacture phantom drift — the exact false positive that makes a
   * gate untrustworthy and then ignored).
   */
  ledgerTruncated?: boolean;
  /**
   * Cycles started before this epoch-ms are EXCLUDED from the reconciliation bar (default
   * {@link LEDGER_RECONCILE_EPOCH_MS} — the P-003 fix's enablement). Pass 0 to judge all of
   * history, e.g. to re-measure the scale of the pre-fix damage.
   */
  reconcileEpochMs?: number;
  /**
   * Minimum cycle denominator before the error-rate bar may report 'pass'
   * (default {@link MIN_ERROR_RATE_DENOMINATOR}). Below it the bar is 'unknown' —
   * see that constant for why a thin clean window is not evidence.
   */
  minErrorRateDenominator?: number;
  /**
   * @deprecated Retained for input compatibility with the pre-EI-223650 API. The
   * literal "<5%" claim is now decided from the exact one-sided binomial upper
   * confidence bound, not from a denominator heuristic.
   */
  strictErrorRateDenominator?: number;
}

const DEFAULT_MAX_ERROR_RATE = 0.05;
const ERROR_RATE_CONFIDENCE = 0.95;

/**
 * MINIMUM DENOMINATOR for a 'pass' on the cycle-error-rate bar (WI-5397, design ask
 * from su-b37b0389 2026-07-19 after the bar emitted status:'pass' on 0 errors / 1 cycle).
 *
 * THE DEFECT THIS CLOSES: `0 errors / 1 cycle = 0.0% < 5%` is arithmetically correct and
 * nearly meaningless. By the rule of three, zero errors in n bounds the true rate below 5%
 * (95% confidence) only near n≈60; at n=1 the data is consistent with a true rate up to
 * ~95%, at n=2 up to ~78%. So the bar was MANUFACTURING a green its own data could not
 * support — and doing it at the worst moment, right after a bg-host restart zeroes the
 * window, exactly when a reader is primed to see the flip. Every consumer would otherwise
 * have to independently remember "check the denominator before trusting pass", which is a
 * verification layer bolted over a value that is simply wrong; the durable fix is to make
 * the primary value correct by construction.
 *
 * WHY 9: 0.7^9 ≈ 4% — nine consecutive clean cycles reject the historical ~30% error rate
 * at p<0.05. That is the claim the 0.0.11-alpha release actually needs ("the ~30% regression
 * is gone"), and at the ~30min cadence it is reachable in ~4.5h. The literal "<5%" claim
 * needs ~60 (~30h) and is reported separately rather than asserted implicitly — a bar whose
 * LABEL and EVIDENCE disagree is the failure this whole hold exists to prevent.
 *
 * ASYMMETRY (deliberate, and the same rule the release watch has run on all along): the
 * denominator guard gates 'pass' ONLY. A 'fail' still fires at any n, because an observed
 * error is positive evidence of breakage while an absence of errors in a thin window is no
 * evidence of health — and the cost of investigating a fluke red is far below the cost of
 * shipping on a manufactured green.
 */
export const MIN_ERROR_RATE_DENOMINATOR = 9;

/**
 * Legacy denominator reference for callers that imported the old heuristic.
 * The release claim no longer uses this value: nonzero failures require the exact
 * one-sided binomial upper confidence bound below the target.
 */
export const STRICT_ERROR_RATE_DENOMINATOR = 60;

/**
 * ENABLEMENT EPOCH for the reconciliation bar (the D-013 pattern already used by
 * ungraded-filings-watchdog's SU_IDEATE_UNGRADED_EPOCH_MS — same problem, same shape).
 *
 * Cycles BEFORE this predate the P-003 ledger-gap fix (scheduler.ts persistRouted): idea ids
 * were POSITIONAL and the ledger upserts ON CONFLICT (idea_id), so every cycle OVERWROTE the
 * previous cycle's rows. Those rows are destroyed and unrecoverable (tracked for annotation
 * in WI-4467) — judging them here would red-pin this bar FOREVER on damage that no fix can
 * repair, and a gate that can never go green is a gate everyone learns to ignore. So the bar
 * judges only cycles the fix actually governs.
 *
 * Set to the bg-host restart that loaded the fix (2026-07-12 14:50 EDT). VERIFIED at that
 * boundary: 432 pre-fix routing cycles → 4 reconciled / 428 drifted; 7 post-fix cycles →
 * 7 reconciled / 0 drifted.
 */
export const LEDGER_RECONCILE_EPOCH_MS = Date.parse('2026-07-12T18:50:00Z');

/** A scout cycleId is `scout-<epochMs>` — recover the cycle's wall-clock for the epoch floor. */
function cycleStartMs(cycleId: string): number | null {
  const ms = Number(cycleId.replace(/^scout-/, '').split(':')[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Exact one-sided Clopper–Pearson upper confidence bound for a binomial error rate.
 *
 * For `errors` observed errors in `trials` independent cycles, this returns the
 * smallest p whose lower-tail probability P(X <= errors | p) is the requested
 * alpha. Equivalently, it is the one-sided upper confidence endpoint
 * `Beta^{-1}(confidence, errors + 1, trials - errors)`. The lower-tail inversion
 * is evaluated by a log-space binomial CDF and a deterministic bisection, so the
 * release bar does not mistake the zero-error rule of three for a bound that also
 * applies when failures are present.
 */
export function oneSidedBinomialUpperBound(
  errors: number,
  trials: number,
  confidence = ERROR_RATE_CONFIDENCE,
): number {
  if (!Number.isInteger(errors) || !Number.isInteger(trials)) {
    throw new Error(`oneSidedBinomialUpperBound: errors and trials must be integers (got errors=${errors}, trials=${trials})`);
  }
  if (trials < 1 || errors < 0 || errors > trials) {
    throw new Error(`oneSidedBinomialUpperBound: need 1 ≤ trials and 0 ≤ errors ≤ trials (got errors=${errors}, trials=${trials})`);
  }
  if (!(confidence > 0 && confidence < 1) || !Number.isFinite(confidence)) {
    throw new Error(`oneSidedBinomialUpperBound: confidence must be between 0 and 1 (got ${confidence})`);
  }

  const alpha = 1 - confidence;
  if (errors === 0) {
    // This is the familiar rule-of-three form, retained as an exact special case.
    return -Math.expm1(Math.log(alpha) / trials);
  }
  if (errors === trials) return 1;

  // The binomial CDF is monotone decreasing in p. Invert P(X <= errors) = alpha.
  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 80; i++) {
    const midpoint = (lower + upper) / 2;
    if (binomialCdfAtMost(errors, trials, midpoint) > alpha) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }
  return (lower + upper) / 2;
}

/** Log-space P(X <= successes) for X ~ Binomial(trials, probability). */
function binomialCdfAtMost(successes: number, trials: number, probability: number): number {
  if (probability <= 0) return 1;
  if (probability >= 1) return 0;

  const logProbability = Math.log(probability);
  const logFailureProbability = Math.log1p(-probability);
  let logTerm = trials * logFailureProbability;
  let maxLogTerm = logTerm;
  let scaledSum = 1;

  for (let successesSeen = 1; successesSeen <= successes; successesSeen++) {
    logTerm +=
      Math.log(trials - successesSeen + 1) -
      Math.log(successesSeen) +
      logProbability -
      logFailureProbability;
    if (logTerm > maxLogTerm) {
      scaledSum = scaledSum * Math.exp(maxLogTerm - logTerm) + 1;
      maxLogTerm = logTerm;
    } else {
      scaledSum += Math.exp(logTerm - maxLogTerm);
    }
  }

  return Math.min(1, Math.exp(maxLogTerm) * scaledSum);
}

/**
 * Fold the ledger snapshots into the program's done-check. PURE — deterministic over the
 * inputs, no IO, no clock.
 */
export function evaluateProgramSuccess(
  inputs: ProgramSuccessInputs,
  opts: ProgramSuccessOptions = {},
): ProgramSuccessReport {
  const report = computeScoutQualityReport(inputs.cadence);
  const maxErrorRate = opts.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const ranTicks = inputs.cadence.ticks.filter((t) => t.status === 'ran');
  const ideas = inputs.ideas;
  const criteria: SuccessCriterion[] = [];

  // EI-19899928839197448: shared LIVENESS precondition for two bars keyed to the mere
  // PRESENCE of scout-routed rows (ledger-reconciles, lens-diversity). Both read "no
  // routed rows" as quiet health, but that reading only holds when NOTHING ran either —
  // an empty window is a genuine absence of evidence. Once cycles actually RAN, a
  // window-wide routed count of zero is no longer silence: it is the routing pipeline
  // having had the opportunity to write and having written nothing, for the entire
  // window. That is itself evidence of breakage, so both bars below must be able to go
  // FAIL on it rather than reporting the mildest verdict available ('unknown'/'pass').
  // Gated on `!opts.ledgerTruncated`: a truncated read cannot support a CONFIDENT "zero"
  // claim (the read simply didn't fetch far enough) — the same reason ledger-reconciles
  // already reports truncation as unknown rather than manufacturing drift.
  const scoutRoutedTotal = inputs.cadence.routedIdeas.length;
  const ranWithNoRoutedOutput = ranTicks.length > 0 && scoutRoutedTotal === 0 && !opts.ledgerTruncated;

  // ── 1. rubric-grounded routed ideas > 0 ─────────────────────────────────────
  // The program's founding defect: the rubric digest lane produced ZERO grounded ideas for
  // its entire life and nobody could see it. Reuse the scheduler's own lane histogram so
  // this reads the SAME attribution the tick detail records (one classifier, not two).
  const lanes = groundingLaneHistogram(ideas);
  const rubricGrounded = lanes[RUBRIC_GROUNDING_LANE] ?? 0;
  const anyGrounded = Object.values(lanes).reduce((a, b) => a + b, 0);
  criteria.push({
    key: 'rubric-grounded-ideas',
    bar: 'rubric-grounded routed ideas > 0 (sustained)',
    ...(ideas.length === 0
      ? {
          status: 'unknown' as const,
          observed: 'no routed ideas in the window',
          unknownReason: cellUnknown('insufficient-data', 'empty ledger window — nothing to attribute to a lane'),
        }
      : {
          status: (rubricGrounded > 0 ? 'pass' : 'fail') as SuccessStatus,
          // When EVERY lane is zero, the defect is upstream of the rubric lane: nothing is
          // grounded to anything, so the rubric lane CANNOT be non-zero. Say so — "0
          // rubric-grounded" and "nothing is grounded to anything" are very different bugs
          // and the second masquerades as the first.
          //
          // But do NOT name a culprit we have not verified. An earlier version of this line
          // asserted "addressesPatternRefs is never populated on the ledger WRITE" — and that
          // false attribution cost a real investigation (WI-4474): the write path was correct
          // all along and the READ path (readRoutedIdeas) was silently dropping the column.
          // A read-side field-drop is INDISTINGUISHABLE from a write-side population failure
          // from here, because this report only ever sees the read. So state the observation
          // and hand over the one query that discriminates, rather than guessing a direction.
          observed:
            anyGrounded === 0
              ? `NO routed idea carries pattern refs at all (0 of ${ideas.length}) — every grounding lane is empty, so the rubric lane cannot be non-zero. This is upstream of the rubric lane, but it does NOT say whether the WRITE or the READ is at fault (this report only sees the read). Discriminate before fixing: SELECT count(*) FILTER (WHERE jsonb_array_length(COALESCE(addresses_pattern_refs,'[]'::jsonb)) > 0) FROM harness_shared.scout_routed_ideas WHERE origin='scout' — refs present in the column ⇒ the read path is dropping them; absent ⇒ the write/ideator path never produced them.`
              : `${rubricGrounded} of ${ideas.length} routed ideas grounded in the rubric lane (all lanes: ${JSON.stringify(lanes)})`,
        }),
  });

  // ── 2. zero score-0 cycles fired ────────────────────────────────────────────
  // Volume mode must veto a cycle over an unchanged corpus ('no-signal'), so spend tracks
  // real activity. A cycle that FIRED at score 0 is pure waste. Judged on the score the
  // scheduler now persists at fire time (P-015); ticks predating that write carry no score
  // and are simply not counted against the bar — an ABSENT score means "volume mode wasn't
  // engaged", never "the score was 0", and conflating those would fail the bar on history.
  const scored = ranTicks.filter((t) => typeof t.detail?.signalScore === 'number');
  const zeroSignalFires = scored.filter((t) => (t.detail?.signalScore as number) <= 0);
  const noSignalGates = report.gatedTickBreakdown['no-signal'] ?? 0;
  criteria.push({
    key: 'zero-signal-cycles',
    bar: 'zero score-0 cycles fired (spend drops in quiet periods)',
    ...(scored.length === 0
      ? {
          status: 'unknown' as const,
          observed: `no fired cycle in the window carries a signal score (${noSignalGates} no-signal veto(es) recorded)`,
          unknownReason: cellUnknown('not-measured', 'volume mode not engaged on any fired tick in this window (or all ticks predate the P-015 score write)'),
        }
      : {
          status: (zeroSignalFires.length === 0 ? 'pass' : 'fail') as SuccessStatus,
          observed: `${zeroSignalFires.length} of ${scored.length} scored cycles fired at score<=0; ${noSignalGates} quiet ticks vetoed by the no-signal gate`,
        }),
  });

  // ── 3. cycle error rate < 5% ────────────────────────────────────────────────
  // Counts only genuine FAILURES. A cycle withheld because the LLM pool had no capacity is
  // gated ('no-capacity'), not errored — pool busy-ness is a resource ceiling, not breakage,
  // and counting it here is what pinned this bar at ~30%. The classification is applied on
  // BOTH sides through capacity-errors: the scheduler gates a LIVE typed capacity failure at
  // write time, while computeScoutQualityReport re-classifies a HISTORICAL unversioned error
  // from the narrow legacy signatures. The persisted classifier version prevents current
  // untyped failures from using that fallback — so this bar reflects real breakage across the
  // carrier transition without hiding new admission-path defects (WI-4475/WI-4771). The
  // capacity gate is reported alongside so the pressure stays VISIBLE rather
  // than reclassified out of sight: a high no-capacity count with a green error bar is a real
  // and actionable signal (the loop is healthy but the account pool is starved).
  // The denominator is CYCLE ticks — the ticks where a cycle actually fired (ran + genuine
  // error) — NOT every tick in the window. A GATED tick (min-interval / no-trigger / no-signal /
  // circuit / no-capacity) is a decision NOT to run a cycle, and a capacity failure is a pool
  // ceiling the rubric requires "classified separately as no-capacity" — neither is a cycle that
  // got a fair shot, so both are excluded from BOTH the numerator (errorTicks already excludes
  // reclassified capacity) and this denominator. Dividing genuine errors by ALL ticks silently
  // DILUTES the rate: a quiet window padded with self-veto ticks turns a real >5% cycle-failure
  // rate into a sub-5% FALSE PASS. This was live (EI-11418): 5 genuine timeout errors among 81
  // cycle ticks is 6.2% and correctly FAILS, but /107 total ticks (18 of them gated) reads 4.7%
  // and passed. windowCycles (status='ran') + errorTicks (genuine, post no-capacity
  // reclassification) is exactly the set of cycles this bar judges.
  // WI-5397: judge this bar over the CODE-HASH-scoped tick union when the caller
  // supplied one (buildProgramSuccessReport always does) — the soak-method fix.
  // Falls back to the time-windowed `report` (computed above from inputs.cadence)
  // when no code-hash union is available (a pure-core fixture, a process whose
  // scout source files were unreadable at hash time, or — WI-5451 — a caller-
  // requested floor with no tick at/after it yet: UNKNOWN over a wrong name is
  // preferred to naming the previous generation's tick as current). WI-5451: the
  // union itself is now INTERSECTED with the caller's explicit window floor, never
  // just replaced by it — buildProgramSuccessReport threads `opts.sinceMs` into
  // BOTH tick-ledger reads only when a floor was actually requested, so a tick
  // predating an explicit watermark can no longer ride into this bar's evidence
  // under a same-hash union with a post-floor tick — never silently substitute a
  // DIFFERENT window than what was actually asked for; the fallback is the same
  // pre-WI-5397 time-windowed read either way.
  const codeHashFold =
    inputs.cadenceByCodeHash?.codeHash != null ? foldScoutTickStats(inputs.cadenceByCodeHash.ticks) : null;
  const errorBarSource = codeHashFold ?? report;
  const cycleTicks = errorBarSource.windowCycles + errorBarSource.errorTicks;
  const errorRate = cycleTicks > 0 ? errorBarSource.errorTicks / cycleTicks : null;
  const noCapacity = errorBarSource.gatedTickBreakdown['no-capacity'] ?? 0;
  const capacityNote =
    noCapacity > 0 ? ` — plus ${noCapacity} cycle(s) withheld by the no-capacity gate (pool starved, not broken)` : '';
  const soakNote = codeHashFold
    ? ` [soak: code-identical union across restarts, hash ${inputs.cadenceByCodeHash!.codeHash}]`
    : '';
  // Denominator guard (see MIN_ERROR_RATE_DENOMINATOR): a clean window is only
  // evidence of health once it is big enough to have caught the regression. Gates
  // 'pass' only — a 'fail' is positive evidence and fires at any n.
  const minDenominator = opts.minErrorRateDenominator ?? MIN_ERROR_RATE_DENOMINATOR;
  const upperErrorRate = cycleTicks > 0 ? oneSidedBinomialUpperBound(errorBarSource.errorTicks, cycleTicks) : null;
  const measured =
    upperErrorRate === null
      ? ''
      : `${errorBarSource.errorTicks} error ticks / ${cycleTicks} cycle ticks (ran + errored) = ${pct(errorRate ?? 0)}` +
        `; exact one-sided 95% upper bound = ${pct(upperErrorRate)}`;
  criteria.push({
    key: 'cycle-error-rate',
    bar: `cycle error rate < ${pct(maxErrorRate)} (was ~30%)`,
    ...(errorRate === null
      ? {
          status: 'unknown' as const,
          observed: `no cycle ran or errored in the window (${errorBarSource.totalTicks} tick(s), all gated)${capacityNote}${soakNote}`,
          unknownReason: cellUnknown('insufficient-data', 'empty cycle window — no cycle got a fair shot, so there is no error-rate denominator'),
        }
      : errorRate >= maxErrorRate
        ? {
            status: 'fail' as const,
            observed: `${measured}${capacityNote}${soakNote}`,
          }
        : cycleTicks < minDenominator
          ? {
              status: 'unknown' as const,
              observed: `${measured} — clean, but the denominator cannot support a pass yet${capacityNote}${soakNote}`,
              unknownReason: cellUnknown('insufficient-data', `denominator too small: n=${cycleTicks} cycle(s), need >=${minDenominator} for zero errors to reject ` +
                `the historical ~30% rate at p<0.05 (rule of three: at n=${cycleTicks} the data is still consistent ` +
                `with a true error rate far above ${pct(maxErrorRate)})`),
            }
          : {
              status: 'pass' as const,
              observed:
                `${measured}${capacityNote}${soakNote}` +
                (upperErrorRate !== null && upperErrorRate < maxErrorRate
                  ? ` [claim: rejects the ~30% baseline at p<0.05 (n=${cycleTicks}>=${minDenominator}); literal ` +
                    `${pct(maxErrorRate)} release bound supported at 95% (upper bound ${pct(upperErrorRate)})]`
                  : ` [claim: rejects the ~30% baseline at p<0.05 (n=${cycleTicks}>=${minDenominator}); literal ` +
                    `${pct(maxErrorRate)} release bound NOT established at 95% (upper bound ${pct(upperErrorRate ?? 1)})]`),
            }),
  });

  // ── 4. ledger rows reconcile with tick routed counts ────────────────────────
  // Per-CYCLE join (not a window total): a tick claiming it routed N ideas must have N rows
  // on the ledger under its cycleId. A window-level sum would cancel a +3/-3 drift to zero
  // and certify a broken write path as healthy.
  // Joined WITHIN the cadence partition: a scout tick's cycleId can only match a
  // scout-origin ledger row, so a cross-origin join would report phantom drift.
  const byCycle = new Map<string, number>();
  for (const idea of inputs.cadence.routedIdeas) {
    if (idea.cycleId) byCycle.set(idea.cycleId, (byCycle.get(idea.cycleId) ?? 0) + 1);
  }
  const epoch = opts.reconcileEpochMs ?? LEDGER_RECONCILE_EPOCH_MS;
  const mismatches: string[] = [];
  let reconciled = 0;
  let preFixSkipped = 0;
  for (const t of ranTicks) {
    const cycleId = typeof t.detail?.cycleId === 'string' ? t.detail.cycleId : undefined;
    if (!cycleId) continue;
    const claimed = t.ideasRouted ?? 0;
    const actual = byCycle.get(cycleId) ?? 0;
    if (claimed === 0 && actual === 0) continue; // trivially consistent — not evidence
    // Pre-fix cycles are EXCLUDED, not counted as drift (see LEDGER_RECONCILE_EPOCH_MS). A
    // cycle with an unparseable id is judged rather than silently skipped — an unknown-age
    // cycle must not become a free pass.
    const startedMs = cycleStartMs(cycleId);
    if (startedMs !== null && startedMs < epoch) {
      preFixSkipped += 1;
      continue;
    }
    if (claimed === actual) reconciled += 1;
    else mismatches.push(`${cycleId}: tick claims ${claimed}, ledger has ${actual}`);
  }
  const preFixNote =
    preFixSkipped > 0
      ? ` (${preFixSkipped} pre-fix cycle(s) excluded — their rows were destroyed by the pre-P-003 overwrite bug; see WI-4467)`
      : '';
  criteria.push({
    key: 'ledger-reconciles',
    bar: 'ledger rows reconcile with tick routed counts (per cycle)',
    ...(opts.ledgerTruncated
      ? {
          status: 'unknown' as const,
          observed: `ledger snapshot truncated at its row limit — ${reconciled} cycle(s) reconciled, ${mismatches.length} apparent mismatch(es) NOT trusted`,
          unknownReason: cellUnknown('insufficient-data', 'a truncated ledger read cannot distinguish real write-path drift from rows the read simply did not fetch — re-run with a higher `limit`'),
        }
      : reconciled === 0 && mismatches.length === 0
        ? ranWithNoRoutedOutput
          ? {
              // EI-19899928839197448: every cycle in this loop hit the `claimed === 0 &&
              // actual === 0` skip above, so there is nothing to reconcile in the narrow
              // per-cycle sense — but that is exactly the shape a totally dead routing
              // pipeline produces (ticks claim nothing because nothing gets that far, and
              // the ledger has nothing because nothing was ever written). A 0=0 match
              // cannot distinguish that from real health, so treat window-wide silence
              // after real cycle activity as a failure, not as trivial consistency.
              status: 'fail' as const,
              observed:
                `${ranTicks.length} cycle(s) ran in the window but the ledger holds ZERO scout-routed ideas at all` +
                `${preFixNote} — a 0=0 per-cycle match is not evidence the write path is healthy when nothing was ever written`,
            }
          : {
              status: 'unknown' as const,
              observed: `no post-fix cycle in the window both ran and routed ideas${preFixNote}`,
              unknownReason: cellUnknown('not-applicable', 'nothing to reconcile — no routing activity the P-003 fix governs'),
            }
        : {
            status: (mismatches.length === 0 ? 'pass' : 'fail') as SuccessStatus,
            observed:
              mismatches.length === 0
                ? `${reconciled} cycle(s) reconcile exactly${preFixNote}`
                : `${mismatches.length} mismatch(es)${preFixNote}: ${mismatches.slice(0, 5).join('; ')}`,
          }),
  });

  // ── 5. ≥1 graded idea has a causally valid typed revision ────────────────────
  // WI-4768 removed the false-green that treated pre-grade routedRef as adoption.
  // WI-4769 closes the missing evidence seam with an explicit `revises` edge. The
  // edge is necessary but not sufficient: both endpoints must have author
  // attribution and the successor must be created AFTER the recorded grade.
  // Session owner ids are intentionally NOT compared: they are ephemeral and an
  // ended originator cannot be resumed/addressed, while a later session can validly
  // incorporate the feedback. The typed edge is the durable causal assertion;
  // author + timestamp attribution makes it auditable.
  const graded = ideas.filter((i) => i.humanGrade != null);
  const attributedFeedback = graded.filter((i) => i.humanFeedback && i.humanFeedback.trim().length > 0 && i.gradedBy);
  const revisedFromFeedback = attributedFeedback.filter((idea) => {
    if (!idea.createdBy || !idea.gradedAt) return false;
    const gradedAtMs = Date.parse(idea.gradedAt);
    if (!Number.isFinite(gradedAtMs)) return false;
    return (idea.feedbackRevisions ?? []).some((revision) => {
      const revisedAtMs = Date.parse(revision.revisedAt);
      return Boolean(revision.createdBy) && Number.isFinite(revisedAtMs) && revisedAtMs > gradedAtMs;
    });
  });
  criteria.push({
    key: 'grader-feedback-revised',
    bar: '>=1 routed idea has attributed feedback and an attributed typed revision created after the grade',
    ...(graded.length === 0
      ? {
          status: 'unknown' as const,
          observed: `0 of ${ideas.length} routed ideas are graded at all`,
          unknownReason: cellUnknown('insufficient-data', 'no grades in the window — the grading channel has not produced input yet'),
        }
      : {
          status: (revisedFromFeedback.length > 0 ? 'pass' : 'fail') as SuccessStatus,
          observed:
            `${revisedFromFeedback.length} routed idea(s) have a causally valid typed feedback revision ` +
            `(of ${attributedFeedback.length} with attributed feedback / ${graded.length} graded / ${ideas.length} routed)`,
        }),
  });

  // ── 6. lens diversity — the roster actually spans lenses (D-004) ─────────────
  // WI-4482: a stale debug config (`maxIdeators: 1`, set 2026-06-25) collapsed the roster to
  // the FIRST lens only, so every cycle for 17 days ran `analogical` alone. That silently
  // voided forced-diversity (D-004) AND left the entire per-lens learning subsystem
  // (scout_lens_weights / perLensWinRates / weight-proportional extra ideators) with a
  // dimension that never varies — a founding invariant of this program, dead, with NOTHING
  // in the gate to notice. A health check that cannot see its own premise collapse is the
  // defect this bar exists to close.
  //
  // Judged on the SCOUT partition only: su-ideate rows carry a different lens vocabulary
  // (SU_IDEATION_LENSES), so mixing them would let su lens variety mask a dead scout roster.
  // Reuses the shipped D-004 predicate (invariants.hasForcedDiversity) rather than
  // re-deriving "diverse" — one notion, every consumer.
  //
  // EI-19899928839197448: a sample drawn ONLY from ROUTED rows goes stale the moment routing
  // output slows or stops — the ledger can keep holding OLD pre-regression rows, so a LIVE
  // roster collapse reads as a healthy "N distinct lenses" from history that no longer
  // reflects what is actually running (measured: 4 stale lenses reported while the live
  // ideators had narrowed to 2 on each of the last 4 cycles). `detail.ideators[]` (EI-13119)
  // is written by every 'ran' tick regardless of whether anything was ultimately routed, so
  // it is LIVE even during a routing outage — prefer it whenever the recent tick window
  // actually carries it, and fall back to the routed-idea sample only when it doesn't
  // (pre-EI-13119 ticks, or a window with no ran ticks at all).
  const recentScoutIdeas = inputs.cadence.routedIdeas.slice(0, LENS_DIVERSITY_SAMPLE);
  const recentRanTicksForLenses = ranTicks.slice(0, LENS_DIVERSITY_SAMPLE);
  const liveIdeatorLenses: CreativeLens[] = recentRanTicksForLenses.flatMap((t) => {
    const slots = t.detail?.ideators;
    if (!Array.isArray(slots)) return [];
    return slots
      .map((slot) =>
        slot && typeof slot === 'object' && typeof (slot as { lens?: unknown }).lens === 'string'
          ? ((slot as { lens: string }).lens as CreativeLens)
          : null,
      )
      .filter((lens): lens is CreativeLens => lens !== null);
  });
  const usingLiveTickSample = liveIdeatorLenses.length > 0;
  const diversitySample: readonly { lens: CreativeLens }[] = usingLiveTickSample
    ? liveIdeatorLenses.map((lens) => ({ lens }))
    : recentScoutIdeas.map((i) => ({ lens: i.lens }));
  const diversityLensesSeen = [...new Set(diversitySample.map((i) => i.lens))].sort();
  const diversitySourceNote = usingLiveTickSample
    ? `live per-ideator tick detail across the newest ${recentRanTicksForLenses.length} ran cycle(s) (${recentScoutIdeas.length} routed idea(s) in the same window)`
    : `the newest ${diversitySample.length} scout-routed ideas`;
  criteria.push({
    key: 'lens-diversity',
    bar: `scout roster spans >=2 lenses (D-004 forced diversity, newest ${LENS_DIVERSITY_SAMPLE} routed ideas or ran cycles)`,
    // A sample of 0-1 slots CANNOT certify diversity. hasForcedDiversity() deliberately
    // returns true for <=1 idea ("a single idea cannot collapse") — correct as an invariant,
    // but as a health bar that is a FALSE PASS: it would green exactly when a roster so
    // broken it emits one idea per window is at its worst. Empty denominators are unknown —
    // UNLESS cycles ran and produced this literal emptiness with no live-tick fallback
    // either, in which case the shared liveness precondition above makes it a FAIL, not an
    // unknown: a silent pipeline with no live signal to fall back on is a broken one.
    ...(diversitySample.length < 2
      ? ranWithNoRoutedOutput
        ? {
            status: 'fail' as const,
            observed:
              `${ranTicks.length} cycle(s) ran in the window but produced ZERO routed ideas AND no live per-ideator ` +
              `tick detail to judge roster diversity from instead — cannot verify the roster is still diverse, so ` +
              'this is treated as a broken pipeline, not an unknown one',
          }
        : {
            status: 'unknown' as const,
            observed:
              `only ${diversitySample.length} scout ideator sample(s) in the recent window ` +
              `(${usingLiveTickSample ? 'live tick detail' : 'routed ideas'}) — too few to judge diversity`,
            unknownReason: cellUnknown('insufficient-data', 'a sample of <2 cannot distinguish a diverse roster from a collapsed one (and must not be allowed to certify either)'),
          }
      : {
          status: (hasForcedDiversity(diversitySample, 2) ? 'pass' : 'fail') as SuccessStatus,
          observed:
            diversityLensesSeen.length >= 2
              ? `${diversityLensesSeen.length} distinct lenses across ${diversitySourceNote}: ${diversityLensesSeen.join(', ')}`
              : `ROSTER COLLAPSED — all ${diversitySample.length} sampled ideator slot(s) (${diversitySourceNote}) are a SINGLE lens (${diversityLensesSeen[0]}). The per-lens learning subsystem has nothing to learn from. Check the scout routine's budget.maxIdeators (1 ⇒ first lens only; see WI-4482).`,
        }),
  });

  // ── 7. fitness-signal-is-real (P-011) ───────────────────────────────────────
  // The bar that makes a green gate over a stub benchmark IMPOSSIBLE. See
  // ProgramSuccessInputs.gymCorpus for why every other criterion could pass while
  // this one was missing. Ordering of the branches is the whole safety property:
  // absent ⇒ unknown, empty ⇒ unknown, ANY synthetic ⇒ fail, all real ⇒ pass.
  const corpus = inputs.gymCorpus;
  criteria.push({
    key: 'fitness-signal-is-real',
    bar: 'the gym optimizes against a REAL task corpus (no synthetic-stub tasks in the active set)',
    ...(corpus == null
      ? {
          status: 'unknown' as const,
          observed: 'gym task corpus not read for this report — provenance unproven',
          unknownReason: cellUnknown('not-measured', 'without the corpus counts this bar cannot distinguish a real benchmark from a generated stub, and MUST NOT default to pass (that default is exactly how six scorecards certified a toy benchmark)'),
        }
      : corpus.realCount + corpus.syntheticCount === 0
        ? {
            status: 'unknown' as const,
            observed: `no gym tasks recorded for ${corpus.harnessSlug ?? 'this harness'} — nothing is being optimized`,
            unknownReason: cellUnknown('not-applicable', 'an empty corpus is neither a real signal nor a fake one; it means the gym has no benchmark at all, which this bar reports rather than grades'),
          }
        : corpus.syntheticCount > 0
          ? {
              status: 'fail' as const,
              observed:
                `SYNTHETIC FITNESS SIGNAL — ${corpus.syntheticCount} of ${corpus.realCount + corpus.syntheticCount} active gym task(s) for ` +
                `${corpus.harnessSlug ?? 'this harness'} are generated stubs (corpus='synthetic'), ${corpus.realCount} are real. ` +
                'A champion crowned on this corpus has proven only that it can edit a toy file, so promotions from it are not evidence of learning. ' +
                'Populate a real task corpus (plan gym-real-fitness-signal-2026-07-27 P-001) — this bar stays RED until every active task is real.',
            }
          : (corpus.realScoredRuns ?? 0) <= 0
            ? {
                status: 'unknown' as const,
                observed:
                  `${corpus.realCount} real gym task(s) are LABELLED for ${corpus.harnessSlug ?? 'this harness'}, but NONE has a scored run yet — ` +
                  'the corpus is declared, not exercised.',
                unknownReason: cellUnknown('insufficient-data', 'a real label with no scored run proves nothing: rows can be inserted for tasks the runner cannot actually execute, so this bar refuses to pass on labels alone and waits for observed scores against real tasks'),
              }
            : {
                status: 'pass' as const,
                observed:
                  `all ${corpus.realCount} active gym task(s) for ${corpus.harnessSlug ?? 'this harness'} are drawn from a REAL corpus (corpus='real'), ` +
                  `with ${corpus.realScoredRuns} scored run(s) against them`,
              }),
  });

  const passed = criteria.filter((c) => c.status === 'pass').length;
  const failed = criteria.filter((c) => c.status === 'fail').length;
  const unknown = criteria.filter((c) => c.status === 'unknown').length;
  return {
    criteria,
    passed,
    failed,
    unknown,
    verdict: failed > 0 ? 'fail' : unknown > 0 ? 'incomplete' : 'pass',
    window: {
      ticks: inputs.cadence.ticks.length,
      ranCycles: ranTicks.length,
      routedIdeas: ideas.length,
      ledgerTruncated: opts.ledgerTruncated === true,
      ...(inputs.cadenceByCodeHash
        ? { codeHash: inputs.cadenceByCodeHash.codeHash, codeHashTicks: inputs.cadenceByCodeHash.ticks.length }
        : {}),
    },
  };
}

export interface BuildProgramSuccessOptions extends Pick<
  BuildQualityInputsOptions,
  'workspaceId' | 'harnessSlug' | 'limit' | 'tickLimit'
> {
  maxErrorRate?: number;
  /** Release-bar time box. Default 48h, matching blender-release-readiness. */
  cycleWindowMs?: number;
  /**
   * ABSOLUTE epoch-ms floor for the tick window (EI-12148) — overrides the rolling
   * `cycleWindowMs` box. The generation-watermark use case: after a fix ships and the
   * bg-host restarts, a rolling window keeps judging PRE-fix errors for up to 48h; a
   * caller that passes the restart instant here judges only what the RUNNING code
   * produced. Omitted ⇒ the rolling default (byte-identical to pre-EI-12148 behavior).
   *
   * WI-5451: when present, this is now ALSO threaded into the WI-5397 code-hash union
   * reads (readNewestScoutCodeHash / readScoutTicksByCodeHash) — intersected with the
   * code-hash predicate, never replacing it, so a tick from before this floor can no
   * longer ride into the cycle-error-rate bar's evidence just because it shares the
   * running code's hash. Omitted ⇒ the union stays unbounded by time exactly as before
   * this fix (its whole cross-restart soak purpose).
   */
  sinceMs?: number;
  /** Deterministic clock injection for tests. */
  nowMs?: number;
  /**
   * EI-19329929546171597: the ACTUAL install_slug the tick writer is using right now,
   * resolved by {@link resolveScoutTickInstallSlug} (byte-identical to the same
   * `workspaceBrainScopeKey(workspaceId, harnessSlug, isWorkspaceCoordinationOn())`
   * computation `scheduler.ts`'s `recordTick` runs at write time). `buildProgramSuccessReport`
   * resolves this itself before calling {@link programSuccessReadScopes} — this field exists
   * so `programSuccessReadScopes` can stay a PURE sync function (and its existing tests stay
   * byte-identical) while still reading under whatever slug the writer is actually using.
   * Omitted ⇒ falls back to the hardcoded legacy `SCOUT_TICK_INSTALL_SLUG` (pre-fix behavior).
   */
  resolvedTickInstallSlug?: string;
}

/**
 * Resolve the install_slug the Scout tick WRITER is using right now, for a given
 * workspace — the read-side mirror of `scheduler.ts`'s `recordTick`, which computes
 * `opts.workspaceId ? workspaceBrainScopeKey(opts.workspaceId, harnessSlug, on) : harnessSlug`
 * with `harnessSlug === SCOUT_TICK_INSTALL_SLUG` for the workspace-singleton Scout routine.
 *
 * EI-19329929546171597: before this fix, `success-metrics.ts` read a HARDCODED
 * `SCOUT_TICK_INSTALL_SLUG` ('@singleton') regardless of the `WORKSPACE_COORDINATION` flag,
 * while the writer already followed the flag. The 2026-08-02 owner-attended cutover
 * (workspace-scoped-coordination-2026-06-20 D-019) graduated that flag to default-ON, which
 * flipped the writer's install_slug from '@singleton' to the workspaceId — and the reader,
 * still pinned to the old constant, went permanently blind (0 ticks seen, 3
 * blender:success-metrics bars stuck 'unknown', blender-release-readiness a PERMANENT NO-GO).
 *
 * No workspaceId ⇒ the writer's own fallback (`harnessSlug` unconditionally) — mirrored here
 * as the legacy constant, since a workspace-less caller can't resolve the K1 sentinel key.
 */
export async function resolveScoutTickInstallSlug(workspaceId?: string): Promise<string> {
  if (!workspaceId) return SCOUT_TICK_INSTALL_SLUG;
  const { isWorkspaceCoordinationOn, workspaceBrainScopeKey } = await import('../workspace-brain-scope');
  return workspaceBrainScopeKey(workspaceId, SCOUT_TICK_INSTALL_SLUG, await isWorkspaceCoordinationOn());
}

/** Default ledger row cap — also the truncation probe (rows === limit ⇒ older rows unseen). */
const DEFAULT_LEDGER_LIMIT = 500;
/** Fallback cycle-error window when the rubric's own declared window can't be read
 *  (EI-12146) — otherwise byte-identical to the pre-EI-12146 hardcode (48h), now sourced
 *  from the same constant resolveCriterionWindow() itself falls back to. */
export const CYCLE_ERROR_WINDOW_MS = DEFAULT_CRITERION_WINDOW_MS;
/** Workspace-global Scout ticks and Scout-origin routed ideas live here. */
export const SCOUT_TICK_INSTALL_SLUG = '@singleton';

/**
 * Build the two production reader scopes in one pure helper. The split is load-bearing:
 * workspace Scout cadence ticks AND Scout-origin routed ideas live under the writer's
 * resolved install slug (falling back to `@singleton` for workspace-less/legacy callers),
 * while su-ideate rows remain scoped to their originating harness. Using a member harness
 * for the cadence ledger manufactured missing-row failures: the singleton ticks claimed
 * routes that the same read had filtered out (WI-4733).
 */
export function programSuccessReadScopes(opts: BuildProgramSuccessOptions = {}): {
  cadence: BuildQualityInputsOptions & { origin: 'scout' };
  suIdeate: BuildQualityInputsOptions & { origin: 'su-ideate'; lenses: readonly SuIdeationLens[] };
  tickWindowMs: number;
  tickSinceMs: number;
} {
  const nowMs = opts.nowMs ?? Date.now();
  // An absolute floor (sinceMs — e.g. the running bg-host generation's start) overrides
  // the rolling box; tickWindowMs is then DERIVED for provenance. Omitted ⇒ the rolling
  // default, byte-identical to the pre-EI-12148 read.
  const tickSinceMs = opts.sinceMs ?? nowMs - (opts.cycleWindowMs ?? CYCLE_ERROR_WINDOW_MS);
  const tickWindowMs = opts.sinceMs != null ? Math.max(0, nowMs - opts.sinceMs) : (opts.cycleWindowMs ?? CYCLE_ERROR_WINDOW_MS);
  // EI-19329929546171597: the writer's ACTUAL current install_slug, resolved by the caller
  // (buildProgramSuccessReport) via resolveScoutTickInstallSlug — falls back to the legacy
  // hardcoded constant when the caller hasn't resolved one (byte-identical pre-fix behavior,
  // and what every existing unit test of this pure function still exercises).
  const tickInstallSlug = opts.resolvedTickInstallSlug ?? SCOUT_TICK_INSTALL_SLUG;
  const shared: BuildQualityInputsOptions = {
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.tickLimit != null ? { tickLimit: opts.tickLimit } : {}),
  };
  return {
    cadence: {
      ...shared,
      // The routed-idea writer uses the same workspace-brain scope as the tick writer when
      // WORKSPACE_COORDINATION is ON. Keep both reads on the resolved writer slug; otherwise
      // the ticks can claim routes that this read filtered out (EI-20186985232612345).
      harnessSlug: tickInstallSlug,
      origin: 'scout',
      tickInstallSlug,
      tickSinceMs,
    },
    suIdeate: {
      ...shared,
      ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
      origin: 'su-ideate',
      lenses: SU_IDEATION_LENSES,
    },
    tickWindowMs,
    tickSinceMs,
  };
}

/**
 * Read the real ledgers and evaluate the program's done-check. Reads BOTH partitions via
 * {@link buildQualityReportInputs} (see {@link ProgramSuccessInputs} for why the bars split
 * across them) and reuses that same assembly, so this gate and the standing quality report
 * can never read different rows.
 *
 * The tick window is TIME-bounded (48h by default): newest-N pinned the bar on stale pre-fix
 * rows when the loop was quiet and could also hide a current error when harness scoping omitted
 * the workspace-global singleton rows. A release bar is about elapsed time, not row volume.
 */
export async function buildProgramSuccessReport(opts: BuildProgramSuccessOptions = {}): Promise<ProgramSuccessReport> {
  const limit = opts.limit ?? DEFAULT_LEDGER_LIMIT;
  // EI-19329929546171597: resolve the WRITER's actual current install_slug before reading —
  // see resolveScoutTickInstallSlug's doc comment for why this can no longer be the hardcoded
  // SCOUT_TICK_INSTALL_SLUG constant now that WORKSPACE_COORDINATION has graduated default-ON.
  const resolvedTickInstallSlug = await resolveScoutTickInstallSlug(opts.workspaceId);
  const scopes = programSuccessReadScopes({ ...opts, limit, resolvedTickInstallSlug });
  const [cadence, suIdeate, cadenceByCodeHash] = await Promise.all([
    buildQualityReportInputs<CreativeLens>(scopes.cadence),
    buildQualityReportInputs<SuIdeationLens>(scopes.suIdeate),
    // WI-5397 soak-method fix: best-effort, never fails the report. Lazy import keeps
    // this module's assembly layer's PG edge deferred (the buildQualityReportInputs
    // convention). Absent/failed ⇒ evaluateProgramSuccess falls back to the
    // time-windowed cadence.ticks for the cycle-error-rate bar (pre-WI-5397 behavior).
    (async () => {
      try {
        const { readNewestScoutCodeHash, readScoutTicksByCodeHash } = await import('./tick-ledger');
        const readOpts = {
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          // EI-19329929546171597: read under the WRITER's actual current install_slug (see
          // resolveScoutTickInstallSlug), not the hardcoded legacy constant.
          installSlug: resolvedTickInstallSlug,
          // WI-5451: intersect the code-hash union with the CALLER'S EXPLICIT window floor
          // — `opts.sinceMs`, never `scopes.tickSinceMs` (which is always populated, even
          // on the plain rolling-default path, and would silently re-impose a time box on
          // the union's entire cross-restart purpose). Only an explicit sinceMs/watermarkRef
          // reaching this function counts as "a floor was requested"; the implicit rolling
          // default leaves the union unbounded by time exactly as before this fix.
          ...(opts.sinceMs != null ? { sinceMs: opts.sinceMs } : {}),
        };
        const codeHash = await readNewestScoutCodeHash(readOpts);
        if (!codeHash) return undefined;
        const ticks = await readScoutTicksByCodeHash({ ...readOpts, codeHash });
        return { ticks, codeHash };
      } catch {
        return undefined;
      }
    })(),
  ]);
  const ideas = [...cadence.routedIdeas, ...suIdeate.routedIdeas];
  // P-011: read the gym's task-corpus split so `fitness-signal-is-real` can fail on a
  // synthetic benchmark. Best-effort and lazily imported, like the code-hash read
  // above — but note the asymmetry: a FAILED read yields `undefined`, which rates the
  // bar `unknown`, never `pass`. A gate that greened because its own probe errored
  // would reproduce the exact blindness this bar exists to end.
  const gymCorpus = await (async () => {
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const harnessSlug = opts.harnessSlug;
      const rows = (await (harnessSlug
        ? sql`SELECT corpus, count(*)::int AS n
                FROM harness_gym_durable.gym_tasks
               WHERE harness_slug = ${harnessSlug}
                 AND active = true
                 ${opts.workspaceId ? sql`AND workspace_id = ${opts.workspaceId}` : sql``}
               GROUP BY corpus`
        : sql`SELECT corpus, count(*)::int AS n
                FROM harness_gym_durable.gym_tasks
               WHERE active = true
                 ${opts.workspaceId ? sql`AND workspace_id = ${opts.workspaceId}` : sql``}
               GROUP BY corpus`)) as Array<{ corpus: string; n: number }>;
      if (rows.length === 0) return undefined;
      let realCount = 0;
      let syntheticCount = 0;
      for (const r of rows) {
        if (r.corpus === 'real') realCount += Number(r.n);
        else syntheticCount += Number(r.n); // unknown labels count as synthetic
      }
      // How many runs against REAL tasks were actually scored. Read only when the
      // corpus is otherwise clean — the bar fails on any synthetic task before it ever
      // consults this, so the extra query is skipped on the (current) failing path.
      let realScoredRuns = 0;
      if (realCount > 0 && syntheticCount === 0) {
        const scored = (await sql`
          SELECT count(*)::int AS n
            FROM harness_gym_durable.gym_scores s
            JOIN harness_gym_durable.gym_runs r
              ON r.workspace_id = s.workspace_id AND r.harness_slug = s.harness_slug AND r.run_id = s.run_id
            JOIN harness_gym_durable.gym_tasks t
              ON t.workspace_id = r.workspace_id AND t.harness_slug = r.harness_slug AND t.task_id = r.task_id
           WHERE t.corpus = 'real'
             AND t.active = true
             ${harnessSlug ? sql`AND s.harness_slug = ${harnessSlug}` : sql``}
             ${opts.workspaceId ? sql`AND s.workspace_id = ${opts.workspaceId}` : sql``}
        `) as Array<{ n: number }>;
        realScoredRuns = Number(scored[0]?.n ?? 0);
      }
      return { realCount, syntheticCount, realScoredRuns, ...(harnessSlug ? { harnessSlug } : {}) };
    } catch {
      return undefined;
    }
  })();
  const report = evaluateProgramSuccess(
    { cadence, ideas, ...(cadenceByCodeHash ? { cadenceByCodeHash } : {}), ...(gymCorpus ? { gymCorpus } : {}) },
    {
      ...(opts.maxErrorRate != null ? { maxErrorRate: opts.maxErrorRate } : {}),
      // A full page back on EITHER partition means the read almost certainly hit the cap and
      // older rows are unseen — reconciliation must not FAIL on rows it never fetched.
      ledgerTruncated: cadence.routedIdeas.length >= limit || suIdeate.routedIdeas.length >= limit,
    },
  );
  return {
    ...report,
    window: {
      ...report.window,
      tickWindowMs: scopes.tickWindowMs,
      tickSinceMs: scopes.tickSinceMs,
      // EI-19329929546171597: report what was ACTUALLY queried, not the legacy constant —
      // this is the field a future partition-mismatch diagnosis would read first.
      tickInstallSlug: resolvedTickInstallSlug,
    },
  };
}
