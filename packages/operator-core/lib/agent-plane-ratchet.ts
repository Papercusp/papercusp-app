/**
 * THE INTERPRETABILITY RATCHET
 * (agent-state-plane-verification-2026-07-27 P-003).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * P-015's sweep writes one `agent_plane_measurements` row per window carrying
 * `interpretable_count / metric_count`. On the live series that has read 3/6,
 * then 4/6 from 14:34 onward — the step where P-009's stamp writer came online
 * and `intent-action-divergence-stamped` became measurable for the first time.
 *
 * The plane's whole argument is that an unbuilt metric must report
 * `interpretable: false` rather than a clean zero. That rule is what made WI-6465
 * findable at all. But it only pays off if someone NOTICES when the number moves
 * — in either direction. Two things have to be true and nothing was checking
 * either:
 *
 *   1. A metric that once worked must not quietly stop working. A producer that
 *      dies takes its metric back to `interpretable: false`, and the resulting
 *      "0 conflicts" is indistinguishable on a dashboard from a healthy fleet.
 *   2. A metric known to be unbuilt must become interpretable when its producer
 *      is declared built — otherwise WI-6465 can be closed while the instrument
 *      that would show the fix working is still blind.
 *
 * ── ⚠ THE VACUOUS PASS: RATCHETING THE COUNT ────────────────────────────────
 *
 * The obvious implementation — the one the plan item's own wording invites, and
 * the one this module deliberately does NOT do — is to assert that
 * `interpretable_count` never decreases.
 *
 * `interpretable_count` is an AGGREGATE, and an aggregate cannot see a swap. If
 * `acted-on-stale-or-wrong-value` becomes measurable in the same window that
 * `intent-action-divergence-stamped` dies, the count stays 4 and a count-ratchet
 * reports "holding" — while a producer this plane depends on has just failed.
 * The count is exactly as high as before, which is precisely why it is worthless:
 * the one event the ratchet exists to catch is the one event it cannot see.
 *
 * So the ratchet is PER-METRIC. `interpretable_count` is reported because it is a
 * useful headline, and it is never the thing asserted on.
 *
 * ── ⚠ AND: "NEVER WORKED" IS NOT "STOPPED WORKING" ──────────────────────────
 *
 * These two have the same symptom — `interpretable: false` today — and opposite
 * causes, owners and urgencies. `never-interpretable` is an unbuilt producer: it
 * is a filed, owned gap (WI-6548) and re-failing the build for it teaches the
 * fleet to ignore this gate. `regressed` is a producer that DEMONSTRABLY WORKED
 * and has stopped, which is a live incident nobody has noticed yet.
 *
 * Collapsing them into "not interpretable" is the same mistake as P-001's
 * `no-producer` vs `no-data`, one layer up: it makes a dead producer read like a
 * feature that was never built, so nobody is paged for it.
 *
 * ── ⚠ AND: A QUIET WINDOW IS NOT A DEAD PRODUCER ────────────────────────────
 *
 * The third confusion, and the one that actually red the fleet gate — caught live
 * at 2026-07-28T03:08Z, when `intent-action-divergence-stamped` was judged
 * `regressed` while its producer was demonstrably healthy.
 *
 * This module is careful never to round a zero UP to a pass. It was rounding a
 * quiet window DOWN to a regression, which is the same error with the sign
 * flipped, and it is worse for the fleet: a vacuous pass is silent, but a false
 * regression stops every deploy. The window read `eligible: 37, comparable: 0,
 * fillRate: 0.022, zeroReason: 'nothing-comparable'` — 37 calls DID carry the
 * stamp. The fleet had simply gone from 2,439 calls / 59 agents to 529 / 7, so no
 * single intent bucket held two calls to compare. Nothing broke. Nothing was
 * deployed. The gate red anyway, and no commit could have greened it.
 *
 * A metric whose interpretability depends on TRAFFIC VOLUME will always have quiet
 * windows. Treating each one as an incident is how a gate earns the fleet-wide
 * habit of ignoring it — the exact outcome `companionsUnavailable` reasons about
 * below, and the failure mode that nearly killed the no-bespoke-state-read gate.
 *
 * So the regression test is now: the producer WROTE (`nothing-comparable` with a
 * non-zero fill rate — the measurement layer's own distinction, not a heuristic)
 * AND this is not yet a sustained run. One quiet window is `window-unjudgeable`;
 * {@link UNJUDGEABLE_WINDOW_RUN} consecutive uninterpretable windows is still
 * `regressed`. A producer that genuinely dies reports `nothing-eligible` and
 * reaches `regressed` on the very first window, exactly as before — the teeth are
 * unchanged for the case they were built for.
 */
import {
  METRIC_SPECS,
  PLANE_METRIC_IDS,
  type PlaneMetricId,
  type PlaneZeroReason,
} from './agent-plane-measurement';

/**
 * `never-interpretable` and `no-data` are NEITHER pass nor fail — they are the
 * two "we cannot say" states, kept apart for the reasons in the header.
 */
export const RATCHET_VERDICTS = [
  /** Interpretable now, and either always was or newly became so. The good state. */
  'holding',
  /** Was interpretable in an earlier window and is NOT now. A producer died. */
  'regressed',
  /** Never once interpretable across the whole series. An unbuilt producer. */
  'never-interpretable',
  /**
   * Was interpretable before and is not in THIS window — but the producer
   * demonstrably still wrote, and the window simply held no comparable unit.
   * "We could not judge this window", which is NOT "a producer died". See
   * {@link producerWroteButNothingComparable}.
   */
  'window-unjudgeable',
  /**
   * Claims `interpretable: true` while its OWN funnel says nothing was eligible.
   * A metric cannot have a comparable unit it never made eligible, so this is not
   * a bad reading — it is an incoherent one, and it is the shape a "fix" takes
   * when someone relabels a zero instead of building the producer.
   */
  'incoherent',
  /** No windows to judge. Says nothing about any producer. */
  'no-data',
] as const;
export type RatchetVerdict = (typeof RATCHET_VERDICTS)[number];

export const WINDOW_UNJUDGEABLE_REASONS = [
  'producer-output-no-comparable',
  'occurrence-absent',
  'occurrence-absent-liveness-independent',
  'fleet-traffic-absent',
] as const;
export type WindowUnjudgeableReason = (typeof WINDOW_UNJUDGEABLE_REASONS)[number];

/**
 * Which open item explains a metric that has never been interpretable.
 *
 * A metric whose emptiness NOTHING explains is not exempt — it fails. The point
 * of naming the item is that the exemption expires when the item closes: see
 * {@link judgeKnownGap}, which turns the exemption into a hard failure the moment
 * someone reports the producer built.
 */
export const METRIC_KNOWN_GAPS: Readonly<Partial<Record<PlaneMetricId, string>>> = Object.freeze({
  // ⚠ `conflicting-assumption-incidence` is NOT listed here any more, and its
  // absence is not an oversight: WI-6545 / D-103 RETIRED the metric outright, so
  // there is no longer a gap to excuse. An exemption is for a metric that is blind
  // TODAY and expected to see later; that one was blind BY CONSTRUCTION. Measured
  // over all 2,217 agent_facts rows ever written: `claim` has 3 rows spanning ONE
  // identity, and D-087 R3 excludes same-identity pairs as supersession, so the
  // detector computed `identities.size < 2` → zero compared pairs, permanently.
  // Widening its gate would have changed which structural-zero string printed and
  // nothing else. Do NOT re-add it: the metric id no longer exists.
  //
  // `acted-on-stale-or-wrong-value` is deliberately NOT listed here either. It
  // remains `clarification-rate`'s declared `interpretableOnlyWith` companion, so
  // retiring the metric would silently promote that rate to an unqualified pass.
  // WI-6548 instead replaced the blind fact-dependency replay with the send-time
  // `staleValueQuotes` stamp already captured inline by `coord:send`. Producer v3's
  // first persisted row (2026-09-04T18:30:21.818Z) proved that leg live over 696
  // messages: 1 eligible, 1 comparable, 0 stale, `clean` and interpretable. With
  // the producer proven, keeping an exemption would now hide a future regression.
  // ⚠ `acted-on-stale-declared-basis` and `closed-work-basis-moved` were listed here
  // under WI-6465 while their producer was still being built. They are deliberately NOT
  // listed any more: both now HOLD in production, measured every ~30min since
  // 2026-07-27T23:36Z at producer_version 2 (01:38Z: rates 0 with zeroReason 'clean',
  // and 0.1944 — both interpretable). The note that stood here claimed "every recorded
  // window through 18:36 carries metric_count 6 and never mentions these ids"; that was
  // TRUE when written and was falsified by the 19:36Z+ windows, which is exactly why it
  // is recorded rather than quietly deleted. Re-adding them would be wrong twice over:
  // an exemption is for a metric that has NEVER been interpretable, and one that HAS
  // been can only ever reach `regressed` — which judgeKnownGap deliberately refuses to
  // excuse, because a producer that worked and then died is never a "known gap".
});

/** One metric's state in one window, as read back from a measurement row. */
export interface MetricWindow {
  measuredAt: string;
  interpretable: boolean;
  /** `eligible / population`. Null when nothing was examined. */
  fillRate: number | null;
  zeroReason: PlaneZeroReason | null;
  /**
   * How much of the producer's own output this window carried (WI-6562).
   *
   * `fillRate` alone cannot support {@link sustainedlyUninterpretable}'s evidence
   * test: it is a RATIO, so a window with 37 stamped calls out of 926 and one with
   * 370 out of 9,260 are indistinguishable, while only the second carries enough
   * output for "no comparable unit" to mean anything. Optional because a window
   * persisted before this field existed simply has none — and the run test falls
   * back to the old pure-count behaviour when it is absent, so an old series is
   * judged exactly as before rather than silently excused.
   */
  eligible?: number | null;
  /**
   * How many units the window EXAMINED — the evidence weight for a metric whose
   * eligibility is the occurrence (WI-6562).
   *
   * ⚠ The two eligibility semantics need DIFFERENT evidence units, which is the
   * subtlety that makes this a second field rather than a reuse of `eligible`. For
   * an input metric, "zero comparable is surprising" is made surprising by the
   * PRODUCER'S OUTPUT — 400 stamps and no comparable bucket means something broke.
   * For an occurrence metric, `eligible` IS the zero being explained, so weighing
   * the run by it would make the run weigh zero and the excuse permanent; what
   * makes zero failures surprising is how many calls we SCANNED to find none.
   */
  population?: number | null;
}

export interface RatchetRow {
  metric: PlaneMetricId;
  verdict: RatchetVerdict;
  everInterpretable: boolean;
  interpretableNow: boolean;
  /** When it first became measurable — the evidence that it CAN be. */
  firstInterpretableAt: string | null;
  /** The last window it worked in. For a regression, when it died. */
  lastInterpretableAt: string | null;
  windows: number;
  knownGap?: string;
  /** Set when the known gap's item has closed, so the exemption no longer applies. */
  gapClosed?: boolean;
  /** Why this window is unjudgeable, so the live reporter preserves the causal distinction. */
  windowUnjudgeableReason?: WindowUnjudgeableReason;
  /**
   * Declared companions (`MetricSpec.interpretableOnlyWith`) that are NOT holding
   * right now — so this metric's own verdict must not be read as a usable signal.
   * Empty/absent means every companion it needs is available. See
   * {@link companionsUnavailable}.
   */
  unreadableAlone?: PlaneMetricId[];
}

/**
 * A metric asserting interpretability its own counts cannot support.
 *
 * `fillRate === 0` means no unit was ever eligible; `comparable` is a subset of
 * eligible, so nothing could have been comparable, so nothing was interpretable.
 * A row claiming otherwise has had its labels moved without its funnel being
 * built — which is the one "fix" for an unbuilt metric that must never pass.
 */
export function isIncoherent(w: MetricWindow): boolean {
  if (!w.interpretable) return false;
  if (w.zeroReason === 'nothing-eligible' || w.zeroReason === 'population-empty') return true;
  return w.fillRate === 0;
}

/**
 * Judge ONE metric across its windows, oldest-first.
 *
 * Pure ({ windows } -> verdict), so every distinction above is testable against
 * literal arrays with no database — which matters because the states that must
 * be told apart (a died-yesterday producer, a never-built one) are exactly the
 * ones a live box will not be in on the day you write the check.
 */
export function judgeMetricRatchet(
  windows: readonly MetricWindow[],
  /**
   * The judged metric's declared eligibility semantics. Defaults to `false` — the
   * input-eligibility reading — so an undeclared metric keeps the original
   * first-window teeth and only a metric that OPTS IN gets the occurrence reading.
   */
  opts: {
    eligibilityIsOccurrence?: boolean;
    eligibilityIsTraffic?: boolean;
    producerLivenessIndependentOfEligibility?: boolean;
  } = {},
): RatchetVerdict {
  if (windows.length === 0) return 'no-data';
  const latest = windows[windows.length - 1];
  if (isIncoherent(latest)) return 'incoherent';
  const everInterpretable = windows.some((w) => w.interpretable && !isIncoherent(w));
  if (latest.interpretable) return 'holding';
  if (!everInterpretable) return 'never-interpretable';
  // ⚠ A QUIET WINDOW IS NOT A DEAD PRODUCER — see the header section of the same
  // name. Only a SUSTAINED inability to compare is a degradation. Two shapes reach
  // here: the input was present but nothing compared, and (for an occurrence-
  // eligibility metric) the scan ran and the defect simply did not occur.
  const isOccurrence = opts.eligibilityIsOccurrence ?? false;
  const isTraffic = opts.eligibilityIsTraffic ?? false;
  const quietReason = classifyUnjudgeableWindow(latest, {
    eligibilityIsOccurrence: isOccurrence,
    eligibilityIsTraffic: isTraffic,
    producerLivenessIndependentOfEligibility:
      opts.producerLivenessIndependentOfEligibility ?? false,
  });
  // A sparse, sender-authored occurrence can be absent across arbitrarily busy
  // windows without saying anything about producer liveness. Keep that absence
  // unjudgeable forever; do not launder it into holding, and do not misreport it
  // as a dead producer merely because unrelated message volume accumulated.
  if (
    quietReason != null &&
    ((quietReason === 'occurrence-absent-liveness-independent') ||
      !sustainedlyUninterpretable(windows, isOccurrence))
  ) {
    return 'window-unjudgeable';
  }
  return 'regressed';
}

/**
 * How many consecutive uninterpretable windows stop being noise and start being a
 * degradation. At the live ~30min cadence this is ~1.5h of a metric never once
 * finding a comparable unit — long past "the fleet was quiet for half an hour".
 */
export const UNJUDGEABLE_WINDOW_RUN = 3;

/**
 * Did the producer WRITE this window, with the funnel simply yielding no unit that
 * admits a verdict?
 *
 * THE DISCRIMINATOR, and it is the measurement layer's own vocabulary rather than a
 * heuristic I invented (`explainZero`, agent-plane-measurement.ts):
 *   · `nothing-eligible`  — "units were examined but none carried this metric's
 *     input — THE PRODUCER HAS NOT WRITTEN". That is a producer signal; it must
 *     still reach `regressed`.
 *   · `nothing-comparable` — "THE INPUT WAS PRESENT but no unit admitted a verdict
 *     — a partial answer wearing a zero". The producer wrote. Nothing died.
 *
 * `fillRate` (= eligible/population) is required to be > 0 as the independent
 * corroboration: a zero fill rate means nothing was eligible at all, whatever the
 * reason string claims, and this must never excuse that.
 */
export function producerWroteButNothingComparable(w: MetricWindow): boolean {
  return !w.interpretable && w.zeroReason === 'nothing-comparable' && (w.fillRate ?? 0) > 0;
}

/**
 * The SECOND quiet-window shape: nothing was eligible because nothing HAPPENED.
 *
 * `nothing-eligible` normally means a producer stopped writing, and for six of the
 * seven metrics it does. For a metric whose eligibility is the measured occurrence
 * itself ({@link MetricSpec.eligibilityIsOccurrence}) it means the opposite: the
 * scan ran over a real population and found none of the defect. Zero tool failures
 * in a quiet half-hour is the outcome we want, not a dead scanner.
 *
 * `fillRate === 0` — never `null` — is the corroboration, and it is exactly the
 * "population separates them" test that metric's own `vacuousPassWhen` asks for: a
 * null fill rate means the population itself was empty (`population-empty`), i.e.
 * nothing was examined at all, which stays a producer signal.
 */
export function producerRanButNothingOccurred(
  w: MetricWindow,
  eligibilityIsOccurrence: boolean,
): boolean {
  if (!eligibilityIsOccurrence) return false;
  return !w.interpretable && w.zeroReason === 'nothing-eligible' && w.fillRate === 0;
}

/**
 * The THIRD quiet-window shape: nothing was eligible because THE FLEET MADE NO SUCH
 * CALLS (WI-212675).
 *
 * Same predicate as the occurrence case above and deliberately a separate function,
 * because it answers a different question and is opted into by a different spec field
 * — collapsing them would make the ratchet's own vocabulary say "a defect did not
 * occur" about a metric that measures traffic.
 *
 * For a metric whose eligibility is traffic on a named surface set
 * ({@link MetricSpec.eligibilityIsTraffic}), `population` and `eligible` count
 * DIFFERENT populations, so `fillRate === 0` cannot mean "the producer stopped
 * writing" — background and system calls keep the population non-empty while the
 * agents that would call those surfaces are usage-walled. Measured live: four
 * consecutive hours at exactly zero enriched calls while workspace volume ran at
 * ~380/hr, judged `regressed`, holding `main` for the whole fleet.
 *
 * `fillRate === 0` — never `null` — is the corroboration, exactly as above: a null
 * fill rate means the population itself was empty (`population-empty`), i.e. nothing
 * was examined at all, which stays a producer signal.
 */
export function producerRanButFleetWasStarved(
  w: MetricWindow,
  eligibilityIsTraffic: boolean,
): boolean {
  if (!eligibilityIsTraffic) return false;
  return !w.interpretable && w.zeroReason === 'nothing-eligible' && w.fillRate === 0;
}

/**
 * Classify the causal shape behind `window-unjudgeable` once, so the verdict and
 * its live explanation cannot drift into contradictory stories.
 */
export function classifyUnjudgeableWindow(
  w: MetricWindow,
  opts: {
    eligibilityIsOccurrence: boolean;
    eligibilityIsTraffic: boolean;
    producerLivenessIndependentOfEligibility: boolean;
  },
): WindowUnjudgeableReason | null {
  if (producerRanButNothingOccurred(w, opts.eligibilityIsOccurrence)) {
    return opts.producerLivenessIndependentOfEligibility
      ? 'occurrence-absent-liveness-independent'
      : 'occurrence-absent';
  }
  if (producerRanButFleetWasStarved(w, opts.eligibilityIsTraffic)) {
    return 'fleet-traffic-absent';
  }
  if (producerWroteButNothingComparable(w)) {
    return 'producer-output-no-comparable';
  }
  return null;
}

/**
 * The output level at which this metric has DEMONSTRATED it can yield a verdict —
 * the median `eligible` across its own interpretable windows.
 *
 * Self-calibrating on purpose: any constant here would be tuned to one metric's
 * funnel and to the traffic of the week it was written. The median (rather than the
 * min) keeps one lucky low-volume window from setting a floor so low it excuses
 * nothing — for the live stamped series it reads 363, against a lucky 43.
 *
 * Null when the metric has no interpretable history to calibrate against, which
 * {@link sustainedlyUninterpretable} treats as "no basis to excuse anything".
 */
export function demonstratedEvidenceFloor(
  windows: readonly MetricWindow[],
  eligibilityIsOccurrence = false,
): number | null {
  const seen = windows
    .filter((w) => w.interpretable && !isIncoherent(w))
    .map((w) => windowEvidence(w, eligibilityIsOccurrence))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  return seen.length > 0 ? seen[Math.floor(seen.length / 2)] : null;
}

/**
 * How much this window WEIGHS as evidence, in the unit its metric's eligibility
 * semantics make meaningful. See {@link MetricWindow.population} for why the unit
 * differs. Null when the window carries no usable count, which keeps an absent
 * measurement from ever reading as "zero evidence" and excusing a run.
 */
export function windowEvidence(
  w: MetricWindow,
  eligibilityIsOccurrence: boolean,
): number | null {
  const n = eligibilityIsOccurrence ? w.population : w.eligible;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Have the last {@link UNJUDGEABLE_WINDOW_RUN} windows ALL failed to interpret —
 * over enough producer output for that to MEAN anything?
 *
 * ⚠ WI-6562: the run used to be counted purely in windows, and a window is a unit
 * of WALL CLOCK, not of evidence. So the test got sharply more sensitive exactly
 * when the fleet went quiet and each window carried less. Live on 2026-07-28: three
 * "sustained" windows carried 37+129+37 = 203 stamped calls between them — fewer
 * than the SINGLE window of 206 that had yielded a verdict two hours earlier, and
 * in a corpus where comparable units arrive at roughly eligible/70. The gate red on
 * a metric whose producer was visibly alive, and stayed red because no commit
 * could move a number that only tracks traffic.
 *
 * So a run must now be long enough AND carry at least the output this metric has
 * demonstrably needed. The teeth are unchanged where they matter: a producer that
 * keeps writing at its normal volume while never yielding a comparable unit — a
 * half-death, e.g. stamps still written but `goal_ref` dropped — clears the floor
 * within the same three windows and still reports `regressed`. What no longer
 * fires is a run whose windows were too small to expect an answer at all.
 */
export function sustainedlyUninterpretable(
  windows: readonly MetricWindow[],
  eligibilityIsOccurrence = false,
): boolean {
  const tail = windows.slice(-UNJUDGEABLE_WINDOW_RUN);
  if (tail.length < UNJUDGEABLE_WINDOW_RUN) return false;
  if (!tail.every((w) => !w.interpretable)) return false;
  const floor = demonstratedEvidenceFloor(windows, eligibilityIsOccurrence);
  // No calibration available (no interpretable window carried a usable count, incl.
  // every series persisted before these fields existed) — judge on run length
  // alone, exactly as before. An absent measurement must never become an excuse.
  if (floor == null) return true;
  const carried = tail.reduce((n, w) => n + (windowEvidence(w, eligibilityIsOccurrence) ?? 0), 0);
  return carried >= floor;
}

/**
 * Does a known gap still excuse this metric?
 *
 * THE RATCHET'S TEETH. While the item is open the metric is REPORTED and passes.
 * The moment it closes, the exemption is gone and an uninterpretable metric FAILS
 * — so the producer fix cannot be reported done while the instrument that would
 * show it working is still blind. That transition is the entire point of P-003;
 * without it, closing WI-6465 silently retires the only evidence anyone had that
 * the assumption vertical was dead.
 */
export function judgeKnownGap(args: {
  verdict: RatchetVerdict;
  knownGap?: string;
  gapClosed?: boolean;
}): 'exempt' | 'fails' | 'not-applicable' {
  if (args.verdict !== 'never-interpretable') return 'not-applicable';
  if (!args.knownGap) return 'fails';
  return args.gapClosed ? 'fails' : 'exempt';
}

/**
 * Which of a metric's DECLARED companions are unavailable (P-019).
 *
 * A metric can be perfectly interpretable on its own funnel and still not be
 * READABLE, because its spec says the number has no direction without a companion.
 * `clarification-rate` is the live case: it is `holding` on 4,142 examined calls,
 * and its companion `acted-on-stale-or-wrong-value` is `never-interpretable`
 * pending WI-6548 — so its zero is *uninterpretable*, not clean.
 *
 * ⚠ This companion is precisely why WI-6545 / D-103 retired P-011's metric but did
 * NOT retire this one. Dropping a blind companion is the cheapest possible way to
 * make a ratchet look clean — and it would silently convert `clarification-rate`'s
 * hedged zero into an unqualified pass. A companion is retired only when the
 * QUESTION stops mattering, never because its producer is inconvenient.
 *
 * ⚠ WHY THIS IS NOT A VERDICT. {@link judgeMetricRatchet} is pure over ONE metric's
 * windows, and deliberately so — the states it must separate (a producer that died
 * yesterday, one never built) are testable only against literal arrays. Companion
 * availability is a CROSS-metric fact, so folding it into the verdict would make
 * every verdict depend on the whole report and destroy that property. It is a
 * separate disclosure on top of an unchanged verdict.
 *
 * ⚠ AND WHY IT DOES NOT FAIL THE BUILD. The honest fix for an unavailable companion
 * is to make its producer emit. While that work is filed and open, METRIC_KNOWN_GAPS
 * keeps one known absence from pinning the fleet gate red forever. WI-6548 completed
 * that lifecycle: producer v3 replaced the blind `dependsOn` leg with persisted
 * `staleValueQuotes`, proved the companion holding, and removed its exemption. The
 * ordinary ratchet now has the teeth again if that producer ever regresses.
 */
export function companionsUnavailable(
  metric: PlaneMetricId,
  verdictByMetric: ReadonlyMap<PlaneMetricId, RatchetVerdict>,
  specs: Readonly<Partial<Record<PlaneMetricId, { interpretableOnlyWith?: readonly PlaneMetricId[] }>>>,
): PlaneMetricId[] {
  const needed = specs[metric]?.interpretableOnlyWith ?? [];
  return needed.filter((companion) => verdictByMetric.get(companion) !== 'holding');
}

export interface RatchetReport {
  rows: RatchetRow[];
  windows: number;
  /** Highest `interpretable_count` the series ever reached — reported, not asserted on. */
  highWaterCount: number;
  currentCount: number;
  metricCount: number;
  /** Verdicts that fail: a regression, an incoherent row, or an unexcused gap. */
  failures: RatchetRow[];
  /** Reported and tolerated: a gap whose item is still open. */
  exempt: RatchetRow[];
  /**
   * Reported, never failing: metrics that are interpretable on their own funnel but
   * whose DECLARED companion is not available, so their number must not be read as
   * a verdict. See {@link companionsUnavailable}.
   */
  unreadableAlone: RatchetRow[];
}

/**
 * Roll a whole series into a ratchet report.
 *
 * `series` is oldest-first, each entry one measurement window's per-metric state.
 * `closedGaps` names the known-gap items that have since closed — supplied by the
 * caller because whether WI-6465 is open is a live fact, not a property of the
 * numbers, and baking it in would make this untestable.
 */
export function ratchetPlaneSeries(args: {
  series: ReadonlyArray<{ measuredAt: string; metrics: ReadonlyArray<{ id: string } & MetricWindow> }>;
  closedGaps?: ReadonlySet<string>;
  /**
   * Metric specs, for the companion-dependency disclosure. Defaults to the shipped
   * {@link METRIC_SPECS}; injectable so the cross-metric behaviour is testable
   * against literal specs rather than only the live registry.
   */
  specs?: Readonly<
    Partial<
      Record<
        PlaneMetricId,
        {
          interpretableOnlyWith?: readonly PlaneMetricId[];
          eligibilityIsOccurrence?: boolean;
          eligibilityIsTraffic?: boolean;
          producerLivenessIndependentOfEligibility?: boolean;
        }
      >
    >
  >;
  /**
   * metric → the item excusing its blindness. Defaults to the shipped
   * {@link METRIC_KNOWN_GAPS}; injectable for the same reason `specs` is — the
   * live map legitimately EMPTIES as its gaps get built, and a suite keyed off it
   * would then go vacuously green instead of failing. The exemption/withdrawal
   * behaviour must stay testable against a literal map once the real one is bare.
   */
  gaps?: Readonly<Partial<Record<PlaneMetricId, string>>>;
}): RatchetReport {
  const { series, closedGaps = new Set<string>(), specs = METRIC_SPECS, gaps = METRIC_KNOWN_GAPS } = args;
  const rows: RatchetRow[] = [];

  for (const metric of PLANE_METRIC_IDS) {
    const windows: MetricWindow[] = [];
    for (const point of series) {
      const found = point.metrics.find((m) => m.id === metric);
      // ⚠ Stamp the window's own timestamp when the stored metric lacks one. The
      // persisted `metrics` jsonb holds { id, interpretable, fillRate, zeroReason }
      // — `measured_at` is a COLUMN on the row, not a field on each metric — so
      // every `firstInterpretableAt`/`lastInterpretableAt` derived from live data
      // was undefined. That is why the `regressed` banner has been printing
      // "WORKED until null", the one fact a reader needs to tell a producer that
      // died an hour ago from one that died last week.
      if (found) windows.push({ ...found, measuredAt: found.measuredAt ?? point.measuredAt });
    }
    const interpretableWindows = windows.filter((w) => w.interpretable && !isIncoherent(w));
    const metricSemantics = {
      eligibilityIsOccurrence: specs[metric]?.eligibilityIsOccurrence ?? false,
      eligibilityIsTraffic: specs[metric]?.eligibilityIsTraffic ?? false,
      producerLivenessIndependentOfEligibility:
        specs[metric]?.producerLivenessIndependentOfEligibility ?? false,
    };
    const verdict = judgeMetricRatchet(windows, metricSemantics);
    const latest = windows[windows.length - 1];
    const windowUnjudgeableReason =
      verdict === 'window-unjudgeable' && latest
        ? classifyUnjudgeableWindow(latest, metricSemantics)
        : null;
    const knownGap = gaps[metric];
    rows.push({
      metric,
      verdict,
      everInterpretable: interpretableWindows.length > 0,
      interpretableNow: windows.length > 0 && windows[windows.length - 1].interpretable,
      firstInterpretableAt: interpretableWindows[0]?.measuredAt ?? null,
      lastInterpretableAt: interpretableWindows[interpretableWindows.length - 1]?.measuredAt ?? null,
      windows: windows.length,
      ...(knownGap ? { knownGap, gapClosed: closedGaps.has(knownGap) } : {}),
      ...(windowUnjudgeableReason ? { windowUnjudgeableReason } : {}),
    });
  }

  // SECOND PASS — companion availability is cross-metric, so every verdict must
  // exist before any row can be judged unreadable-alone.
  const verdictByMetric = new Map<PlaneMetricId, RatchetVerdict>(rows.map((r) => [r.metric, r.verdict]));
  for (const row of rows) {
    const unavailable = companionsUnavailable(row.metric, verdictByMetric, specs);
    if (unavailable.length > 0) row.unreadableAlone = unavailable;
  }

  const countAt = (point: (typeof series)[number]) =>
    point.metrics.filter((m) => m.interpretable).length;

  const failures = rows.filter((r) => {
    if (r.verdict === 'regressed' || r.verdict === 'incoherent') return true;
    return judgeKnownGap(r) === 'fails';
  });

  return {
    rows,
    windows: series.length,
    highWaterCount: series.length ? Math.max(...series.map(countAt)) : 0,
    currentCount: series.length ? countAt(series[series.length - 1]) : 0,
    metricCount: PLANE_METRIC_IDS.length,
    failures,
    exempt: rows.filter((r) => judgeKnownGap(r) === 'exempt'),
    unreadableAlone: rows.filter((r) => (r.unreadableAlone?.length ?? 0) > 0),
  };
}
