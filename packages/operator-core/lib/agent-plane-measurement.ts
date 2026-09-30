/**
 * agent-plane-measurement.ts — P-015 of unified-agent-state-plane-2026-07-27:
 * the baseline + standing measurement for the whole plane.
 *
 * P-015's own text names the failure it exists to prevent: *"the non-monotonic
 * 47.1% → 59.1% → 34.9% evidence-compliance curve … the signature of a rule
 * carried by prose rather than structure."* So this module carries its rules in
 * TYPES, not in comments — see {@link MetricSpec.vacuousPassWhen}, which the
 * compiler will not let a metric omit.
 *
 * ── IT COMPOSES; IT DOES NOT RE-DERIVE (D-038 axis 5) ───────────────────────
 *
 * Every number here is produced by a detector that ALREADY computes it:
 * `agent-state-divergence.ts`'s {@link DivergenceCoverage} (which documents
 * `stampFillRate` as "THE number P-015 measures") and
 * `coord:send`'s persisted `staleValueQuotes` verdicts. This module owns the
 * FUNNEL and the disclosure; it owns no derivation of its own. D-046 also
 * forbids a fourth pull read over `tool_invocations`, so re-reading would be wrong
 * twice over. (A third source, `agent-facts/conflicts.ts`'s
 * `ConflictCoverage.comparedPairs`, was retired with its metric by WI-6545 / D-103.)
 *
 * ── THE THREE-LEVEL FUNNEL, AND WHY TWO DENOMINATORS ARE NOT ONE ────────────
 *
 *   population  — units examined in the window
 *   eligible    — of those, the units carrying the INPUT this metric needs
 *   comparable  — of those, the units on which a verdict was actually POSSIBLE
 *   observed    — the finding
 *
 * `fillRate = eligible/population` and `rate = observed/comparable` are DIFFERENT
 * questions and collapsing them is the exact defect D-089 was written about:
 *
 * > "'Structurally always-NULL' and 'nobody declared anything' are different
 * >  facts; only the measurement separates them."
 *
 * A metric can examine 176,784 calls and still be uncomputable because none of
 * them carried a stamp. With one denominator that reads as `0.0 — healthy`. With
 * two it reads as `fillRate 0.0 — the producer has never written`, which is the
 * truth. Hence also {@link PlaneMetric.rate} being **null, never 0**, when
 * `comparable` is 0: a rate of zero is a finding, and this is the absence of one.
 *
 * ── PRE-REGISTRATION IS A FROZEN TABLE, NOT A PROMISE (D-030 §3) ────────────
 *
 * D-030 requires P-015 to "pre-register the metric and the N". {@link METRIC_SPECS}
 * is that pre-registration: the id, the question, the producer and the vacuous-pass
 * answer are FIXED CONSTANTS, and {@link composePlaneMeasurement} may only fill in
 * counts. A run therefore cannot invent a metric, quietly restate its question to
 * match a number it happens to have, or ship one without declaring how it could
 * mislead. `agent-plane-measurement.test.ts` asserts the table is total.
 *
 * ── WHAT THIS MEASURES IS NOT WHAT P-015's ITEM TEXT SAYS (D-032) ───────────
 *
 * The item lists "cells-read vs values-transcribed-into-prose". **D-032 corrects
 * that metric and this module implements the correction**: counting transcriptions
 * measures PRESENTATION — the very question D-030 was settling, and one this
 * fleet's own data now DISFAVOURS as the cell plane's justification. The corrected
 * quantity is *how often an agent acts on a value that was already stale or wrong
 * at the moment it acted* ({@link 'acted-on-stale-or-wrong-value'}), and D-032 is
 * explicit that staleness and wrongness are ONE defect class to be counted
 * together, not two axes.
 */

/**
 * The pre-registered metric set. Two divergence legs rather than one, because
 * D-091 gates delivery PER LEG: the sampling leg is live today while the stamped
 * leg cannot run at all, and a single fused metric would either suppress the
 * working leg or report from the dead one.
 */
export const PLANE_METRIC_IDS = [
  'intent-action-divergence-stamped',
  'intent-action-divergence-sampling',
  'clarification-rate',
  // ⚠ `conflicting-assumption-incidence` (P-011) was REMOVED here by WI-6545 /
  // D-103, and its absence is deliberate. Do not re-add it without new evidence.
  // Measured over all 2,217 agent_facts rows ever written: `claim` had 3 rows
  // spanning ONE identity, and D-087 R3 excludes same-identity pairs as
  // supersession — so the detector could never assemble a single comparable pair,
  // whatever its entry gate. It was not an unbuilt producer waiting on adoption;
  // it was a metric whose population is empty by construction.
  'acted-on-stale-or-wrong-value',
  // WI-6465 / D-102: the two COMMITMENT-backed legs. Separate ids rather than a
  // widening of the cell-backed leg above, for the reason D-091 already split
  // divergence in two — the cell leg cannot run in a background sweep (it needs
  // a reader identity) while these two need only SQL, and a single fused metric
  // would either suppress the working leg or report from the dead one.
  'acted-on-stale-declared-basis',
  'closed-work-basis-moved',
  'plane-token-cost',
] as const;
export type PlaneMetricId = (typeof PLANE_METRIC_IDS)[number];

/**
 * What the `observed` count MEANS — and therefore what a zero means.
 *
 * ⚠⚠ FOUND BY RUNNING THIS MODULE OVER THE LIVE CORPUS, NOT BY A FIXTURE.
 * Without this field every metric was implicitly a DEFECT counter, so the zero
 * ladder ended at `'clean'` — "the only zero that is good news". The live window
 * then produced **0 clarifications across 4,142 calls** and the module rendered
 * it as a clean pass. But zero clarifications is not good news: it is equally
 * consistent with agents having enough context and with agents guessing instead
 * of asking, which is *exactly what that metric's own `vacuousPassWhen` says*.
 * The prose was right and the structure contradicted it — P-015's own thesis
 * ("a rule carried by prose rather than structure") turned on itself.
 *
 * A fixture could not catch it because a fixture author picks the numbers, and
 * every fixture here was written around divergence-shaped metrics where 0 IS the
 * good case. Only a real corpus offers a desirable behaviour that nobody
 * performed.
 */
export const METRIC_POLARITIES = [
  /** `observed` counts something BAD. Zero over a real denominator is good news. */
  'defect',
  /** `observed` counts something GOOD. Zero over a real denominator is a WARNING. */
  'desirable',
  /** `observed` is a MAGNITUDE (bytes), not a count of events. Never a "finding". */
  'gauge',
] as const;
export type MetricPolarity = (typeof METRIC_POLARITIES)[number];

/**
 * Why a metric reported nothing. Only `'clean'` is an informative good-news zero
 * — the others mean either "nothing was measured" (the D-089 misread this module
 * exists to prevent) or, for a desirable behaviour, "it was measured and it did
 * not happen". Same shape and rule as the sibling detector's
 * `DIVERGENCE_ZERO_REASONS`.
 */
export const PLANE_ZERO_REASONS = [
  /** Nothing was examined at all — an idle window, not a verdict. */
  'population-empty',
  /**
   * Units were examined but none carried the metric's input. THE D-089 case: the
   * producer has never written, so the metric is not merely zero, it is unbuilt.
   */
  'nothing-eligible',
  /**
   * The input was present but no unit admitted a verdict (e.g. stamps exist but
   * no bucket holds two comparable calls). A partial answer wearing a zero.
   */
  'nothing-comparable',
  /**
   * A `desirable` metric measured over a real denominator that observed NOTHING.
   * The instrument worked, so this is not a structural zero — it is a finding of
   * ABSENCE, and it must never render as `'clean'`.
   */
  'none-observed',
  /** `comparable > 0`, `observed === 0`, and the count was of a DEFECT. Good news. */
  'clean',
] as const;
export type PlaneZeroReason = (typeof PLANE_ZERO_REASONS)[number];

/**
 * True when the zero means "nothing was measured".
 *
 * `'none-observed'` is deliberately NOT structural: the instrument ran and
 * returned an answer. It is simply not a good answer, which is a different thing
 * and is why it needs its own reason rather than being folded into either side.
 */
export function isStructuralZero(reason: PlaneZeroReason | null): boolean {
  return reason !== null && reason !== 'clean' && reason !== 'none-observed';
}

/** True when a zero must not be shown to a reader as a pass. */
export function isConcerningZero(reason: PlaneZeroReason | null): boolean {
  return reason !== null && reason !== 'clean';
}

/**
 * D-030 §3 requires a minimum of TWO batches per condition before any trend is
 * reported, because in su-07374's experiment *"within-arm variance >= between-arm
 * variance"* — the same arm scored 2/3 then 0/3. A single-batch delta "will report
 * noise with a straight face".
 */
export const MIN_BATCHES_FOR_VARIANCE = 2;

/** The immutable half of a metric: everything fixed BEFORE any data is seen. */
export interface MetricSpec {
  id: PlaneMetricId;
  /** The question, in one line. Frozen so a run cannot restate it to fit a number. */
  question: string;
  /**
   * The surface that must WRITE for this metric to become computable. Named, not
   * described, so a `fillRate` of 0 points at a producer instead of reading as a
   * clean result (D-089).
   */
  inputProducer: string;
  /** Unit of `population` / `eligible`. */
  unit: string;
  /** Unit of `comparable` / `observed` — often, but not always, the same as `unit`. */
  verdictUnit: string;
  /**
   * What `observed` counts, and therefore what a zero means. Required: without it
   * every metric silently defaults to "defect", and a desirable behaviour nobody
   * performed reports as a clean pass — see {@link METRIC_POLARITIES}.
   */
  polarity: MetricPolarity;
  /**
   * ⚠ D-030 §3, REQUIRED OF EVERY METRIC BEFORE IT SHIPS A NUMBER: *"what state of
   * the world makes this pass for the WRONG reason?"*
   *
   * It is a required field rather than a doc comment on purpose. D-030 observed
   * two metrics passing vacuously — *no-contradiction* passed 6/6 only because the
   * agent never reached a proposal (you cannot contradict a plan you never
   * formed), and *surfaces-the-undetermined-question* passed at ceiling in the
   * control precisely BECAUSE the control was told nothing. Both read as passes on
   * a dashboard. A prose convention would not have caught either; a required field
   * means the question cannot go unanswered for a metric that ships.
   */
  vacuousPassWhen: string;
  /**
   * Companion metrics this one CANNOT BE READ WITHOUT (P-019).
   *
   * Some metrics are not self-sufficient: the number is ambiguous in isolation and
   * acquires a direction only alongside another metric. `clarification-rate` is the
   * case this field was added for — a LOW rate is equally consistent with agents
   * having enough context (the win) and with agents guessing instead of asking (the
   * loss), and only `acted-on-stale-or-wrong-value` separates them.
   *
   * ⚠ THIS IS THE SAME ARGUMENT THAT MADE {@link MetricSpec.polarity} A FIELD. That
   * one exists because without it "a desirable behaviour nobody performed reports as
   * a clean pass". This one exists because without it a metric whose companion is
   * DEAD reports as a clean pass too: the dependency was stated only in
   * `vacuousPassWhen` prose, which no reader and no gate can act on, so the ratchet
   * rendered `clarification-rate` as an unqualified `✓ holding` while the very
   * companion its own spec demands sat `never-interpretable` (WI-6465).
   *
   * A prose caveat the machine then contradicts is exactly the
   * derivation-correct/disclosure-dropped failure this plane's verification plan
   * exists because of. Declaring it structurally makes the ratchet say so out loud.
   */
  interpretableOnlyWith?: readonly PlaneMetricId[];
  /**
   * Does `eligible` count an OCCURRENCE of the measured phenomenon, rather than an
   * INPUT a producer must write? (WI-6562.)
   *
   * ⚠ THIS IS THE SAME ARGUMENT AGAIN, one layer below `polarity` and
   * `interpretableOnlyWith`. Both of those exist because a zero's MEANING cannot be
   * inferred from the number — it has to be declared. This one exists because
   * `zeroReason: 'nothing-eligible'` carries a hard-coded causal claim — "units were
   * examined but none carried the metric's input, THE PRODUCER HAS NOT WRITTEN" —
   * that is true only when eligibility is an input someone writes.
   *
   * For most metrics it is: `eligible` is stamped calls, facts carrying `dependsOn`,
   * closes naming keys. Zero of those over a live population really does mean a
   * producer died, and the ratchet must keep failing on the first such window.
   *
   * `intent-action-divergence-sampling` is the exception, and it inverts the sign:
   * its `eligible` is `coverage.failuresSeen`, the tool-call FAILURES it then looks
   * for thrash within. Zero failures is not a missing producer — it is the fleet
   * having a clean half-hour, which is the outcome we WANT. Its own
   * `vacuousPassWhen` already names the discriminator ("`population` separates
   * them"); this field is that sentence made machine-readable, so the ratchet stops
   * paging for a healthy quiet window.
   *
   * Live proof it was needed: 2026-07-28T04:09Z, 926 calls examined, 0 failures,
   * judged `regressed` and it held `main` for the whole fleet. No commit caused it
   * and no commit could have greened it.
   */
  eligibilityIsOccurrence?: boolean;

  /**
   * Is producer liveness INDEPENDENT of whether an eligible occurrence appears?
   *
   * This is narrower than {@link MetricSpec.eligibilityIsOccurrence}. A failure-row
   * scanner can use a sufficiently busy call population as evidence that failures
   * should eventually appear. `acted-on-stale-or-wrong-value` cannot: its producer
   * runs at every `coord:send`, while eligibility is a sender choosing to spell a
   * registered cell identity in section text. Thousands of ordinary messages with
   * no such citation say nothing about whether the resolver ran. Without this bit,
   * the ratchet turns a long citation-free period into a claimed producer death and
   * red-pins the release even though the only observable event simply did not occur.
   *
   * A true value therefore keeps sustained zero-occurrence windows explicitly
   * UNJUDGEABLE; it never turns them into a clean pass. The producer wiring remains
   * guarded at its actual chokepoint by the coord:send integration tests.
   */
  producerLivenessIndependentOfEligibility?: boolean;

  /**
   * The THIRD quiet-window shape (WI-212675, measured 2026-09-03): eligibility is
   * FLEET TRAFFIC on a named set of surfaces, not an input a producer stamps and not
   * a defect occurrence.
   *
   * For such a metric `population` and `eligible` count DIFFERENT populations — every
   * tool call vs. calls to the ten enriched surfaces — so `fillRate` conflates two
   * unrelated facts: "a producer stopped stamping" and "the fleet stopped making these
   * calls". The ratchet reads a zero fill rate as the former, which is right for a
   * stamped input and wrong here: when every account in the provider pool is
   * usage-walled, the fleet makes no enriched calls at all and nothing has died.
   *
   * Live proof it was needed: 2026-09-03 07:00–10:59Z, all 7 Claude accounts
   * usage-walled. Workspace tool volume fell ~6,800/hr → ~380/hr and enriched calls
   * hit EXACTLY zero for four consecutive hours, so `plane-token-cost` reported
   * `regressed` and held `main` for the whole fleet. No commit caused it and no commit
   * could have greened it — the same shape, and the same cost, as the
   * `eligibilityIsOccurrence` case above.
   *
   * This does NOT weaken the ratchet: the verdict only becomes `window-unjudgeable`,
   * which still goes through `sustainedlyUninterpretable`. A fleet back at its normal
   * volume that STILL yields no comparable enriched call clears the WI-6562 evidence
   * floor and reaches `regressed` exactly as before.
   */
  eligibilityIsTraffic?: boolean;
}

/** The counts a run supplies for one metric. All four are required — an omitted
 *  denominator is how a rate silently becomes uninterpretable. */
export interface MetricCounts {
  population: number;
  eligible: number;
  comparable: number;
  observed: number;
}

/** A pre-registered metric with one window's counts attached. */
export interface PlaneMetric extends MetricSpec, MetricCounts {
  /** `eligible / population` — D-089's number. Null only when nothing was examined. */
  fillRate: number | null;
  /**
   * `observed / comparable`. **Null, never 0, when `comparable` is 0** — see the
   * module header: a zero rate is a finding and this is the absence of one.
   */
  rate: number | null;
  zeroReason: PlaneZeroReason | null;
  /** False when the number must not be read as a verdict about the fleet. */
  interpretable: boolean;
}

export interface PlaneMeasurement {
  measuredAt: string;
  windowStartMs: number;
  windowEndMs: number;
  metrics: PlaneMetric[];
  /** Metrics that could report a rate at all. */
  interpretableCount: number;
  /** Metrics whose input producer has never written — the headline, not a footnote. */
  awaitingProducer: PlaneMetricId[];
  /**
   * DESIRABLE behaviours that were measured over a real denominator and did not
   * happen at all. Separate from {@link awaitingProducer} because the instrument
   * worked here — this is a finding, not a gap in the instrument.
   */
  noneObserved: PlaneMetricId[];
  /** One line stating how much of the plane is actually measurable right now. */
  summary: string;
}

/**
 * THE PRE-REGISTRATION (D-030 §3). Frozen before data.
 *
 * Every `vacuousPassWhen` below was written against the LIVE corpus measured on
 * 2026-07-27, not imagined: 176,784 calls in 24h carrying 0 stamps of any kind,
 * and 2,148 `agent_facts` rows carrying 0 assumptions, 0 `dependsOn` and 0 typed
 * claims. Four of these six metrics are structurally unmeasurable today, and
 * saying so IS the baseline.
 */
export const METRIC_SPECS: Readonly<Record<PlaneMetricId, MetricSpec>> = Object.freeze({
  'intent-action-divergence-stamped': {
    id: 'intent-action-divergence-stamped',
    question:
      'Within one declared intent, how often do an agent’s calls span two different goals without a re-declaration?',
    inputProducer: 'P-009’s stamp writer → tool_invocations.intent_event_id + goal_ref',
    unit: 'tool call',
    verdictUnit: 'intent bucket',
    polarity: 'defect',
    vacuousPassWhen:
      'The P-009 stamp writer is not deployed, so fillRate is 0, no bucket holds two comparable calls, and the leg reports nothing for the same reason a perfectly-disciplined fleet would. Read `fillRate`, never `rate`, until the stamp is live.',
  },
  'intent-action-divergence-sampling': {
    id: 'intent-action-divergence-sampling',
    question:
      'How often does an agent fail the same tool ≥3× in 10 minutes — acting without its reasoning converging (MAST FM-2.6)?',
    inputProducer: 'tool_invocations failure rows — needs no stamp, so this leg is live today',
    unit: 'tool call',
    verdictUnit: 'observed failure',
    polarity: 'defect',
    vacuousPassWhen:
      'A window in which the fleet was IDLE produces the same clean zero as a window in which every agent converged. `population` separates them; `rate` alone does not. A fleet that has learned to retry more SLOWLY also improves this number without converging any better.',
    // WI-6562. `eligible` here is `coverage.failuresSeen` — the failures this metric
    // looks for thrash WITHIN — not an input any producer writes. So zero eligible
    // over a real population means "nobody failed a tool this window", not "the
    // failure-row producer died", and the ratchet must not read it as a death.
    // This is the ONLY metric of the seven whose eligibility is an occurrence: every
    // other one counts a written input, and keeps the first-window teeth.
    eligibilityIsOccurrence: true,
  },
  'clarification-rate': {
    id: 'clarification-rate',
    question: 'How often does an agent stop and ask rather than proceed on an unverified premise?',
    inputProducer: 'coord:ask · coord:ask-owner · conversations:post · conversations:answer',
    unit: 'attributed tool call',
    verdictUnit: 'clarification-shaped call',
    // ⚠ DESIRABLE, not defect: asking is the behaviour we WANT, so `observed: 0`
    // is a finding of ABSENCE, never a pass. Measured live 2026-07-27: 0 across
    // 4,142 calls in one 30-minute window — which the defect-shaped ladder was
    // rendering as "✓ clean" until this field existed.
    polarity: 'desirable',
    vacuousPassWhen:
      'A LOW rate is ambiguous BY CONSTRUCTION — equally consistent with agents having enough context (the win) and with agents guessing instead of asking (the loss). It is only interpretable read ALONGSIDE `acted-on-stale-or-wrong-value`, never on its own. D-030 §4 adds the opposite hazard: clarification-seeking measurably WIDENS prompt-injection exposure, so a rising rate is not automatically good either.',
    // P-019: the companion named in `vacuousPassWhen` above, now DECLARED rather
    // than only described. That companion is `never-interpretable` pending
    // WI-6548, so this metric's own `holding` verdict must not be rendered as an
    // unqualified pass — which is exactly what P-019 asked be recorded instead of
    // "fixed". Do NOT drop this to make the ratchet look cleaner: the honest
    // resolution is WI-6548 landing a `dependsOn` producer.
    //
    // ⚠ WI-6545 / D-103 tested this rule rather than merely restating it. That
    // change retired the OTHER blind metric (`conflicting-assumption-incidence`)
    // and deliberately left this one standing, because retiring a companion is the
    // cheapest way to launder an uninterpretable number into a clean one.
    interpretableOnlyWith: ['acted-on-stale-or-wrong-value'],
  },
  'acted-on-stale-or-wrong-value': {
    id: 'acted-on-stale-or-wrong-value',
    question:
      'How often does an agent quote a registered live-state cell into a coordination message without a fresh read of that cell’s canonical door?',
    inputProducer:
      'coord:send → resolveStaleQuoteStamps → coord_event_log.body.staleValueQuotes',
    unit: 'coordination message',
    verdictUnit: 'registered-cell citation with a send-time read verdict',
    polarity: 'defect',
    vacuousPassWhen:
      'A citation-free window has no comparable unit and is NOT a clean zero. The detector intentionally matches only registered cell identities and dotted projected paths, never bare values such as a SHA; the rate therefore measures the honest detectable subset, not every live value an agent may have quoted.',
    // Eligibility is the CITATION occurrence, not output a producer writes. The
    // resolver runs at coord:send even when no sender happens to cite a cell, and
    // message volume cannot turn that absence into evidence the resolver died.
    eligibilityIsOccurrence: true,
    producerLivenessIndependentOfEligibility: true,
  },
  'acted-on-stale-declared-basis': {
    id: 'acted-on-stale-declared-basis',
    question:
      'How often was a terminal close resting on a fact that was ALREADY superseded, retracted or lapsed at the moment it closed?',
    // ⚠ NAMED AS THE PRODUCER THAT ALREADY WRITES. Unlike every other metric here
    // whose fillRate of 0 points at an unbuilt writer, this one's producer has
    // been live since D-079 — the input was there all along and nothing read it.
    inputProducer:
      'work_items:complete / set_state { assumptions } → resolveDeclaredAssumptions → work_items.payload._assumptions.declared[].condition',
    unit: 'terminal close carrying a declaration',
    verdictUnit: 'declared basis entry',
    polarity: 'defect',
    vacuousPassWhen:
      'The denominator is REAL but SMALL and self-selected: measured 2026-07-27, 271 of 301 closes declared the literal "none", leaving 31 entries across 30 closes — so one careless close moves the rate several points. Worse, `none` is unfalsifiable: a closer who rested on an unrecorded assumption and typed "none" is indistinguishable from one who genuinely rested on nothing, and BOTH leave this metric clean. Read it with `fillRate` (the ~10% of closes that name anything), never alone. A zero here says the citations that WERE made were current when made; it says nothing about the closes that made none.',
  },
  'closed-work-basis-moved': {
    id: 'closed-work-basis-moved',
    question:
      'How much closed work rests on a declared basis that has since changed — the re-check nobody performs once an item leaves the queue?',
    inputProducer:
      'the same stored declaration, re-resolved against harness_shared.agent_facts by classifyBasisMovement',
    unit: 'terminal close carrying a declaration',
    verdictUnit: 'declared basis entry',
    // `observed` counts bases that moved — a state you would like to be zero, so
    // the defect ladder's "clean over a real denominator" reading is correct.
    // ⚠ It is NOT an accusation against the closer: see vacuousPassWhen.
    polarity: 'defect',
    vacuousPassWhen:
      'A NON-zero here is NOT a closer error and must never be read as one — a peer revising a fact after the close moves this number without anyone having done anything wrong. It is a RE-CHECK QUEUE, not a scorecard, which is why D-102 keeps it apart from `acted-on-stale-declared-basis` (that one, and only that one, is about the closer). The vacuous pass runs the other way: this metric goes quiet exactly when the fleet stops revising facts — indistinguishable from a fleet whose facts are all correct — and it can only ever see the ~10% of closes that name a basis at all. It also DECAYS: a fact hard-deleted 30d past expiry reports `vanished`, so an old window measures ledger retention as much as it measures drift.',
  },
  'plane-token-cost': {
    id: 'plane-token-cost',
    question: 'What payload does the plane actually add to the surfaces it enriches?',
    inputProducer: 'tool_invocations.output_size on the enriched surfaces',
    unit: 'tool call on an enriched surface',
    verdictUnit: 'output byte',
    // ⚠ GAUGE: `observed` is BYTES — a magnitude, not a count of events. It is
    // never a "finding" however large it grows, and a reader who sees it listed
    // beside real defect counts will mis-rank the whole row.
    polarity: 'gauge',
    // WI-212675: `eligible` here is calls to ENRICHED_SURFACES — fleet traffic, not a
    // stamped input. A usage-walled fleet drives it to zero over a population that is
    // still non-empty (background/system calls keep firing), which the ratchet would
    // otherwise read as a dead producer. See MetricSpec.eligibilityIsTraffic.
    eligibilityIsTraffic: true,
    vacuousPassWhen:
      'NONE of the plane’s enrichments are deployed yet, so this window is the PRE-enrichment baseline. Reading a low number as "the plane is cheap" is exactly backwards — the cost is the DELTA against this row once the enrichments are live, and there is no delta to read until then.',
  },
});

/** 4dp, matching `DivergenceCoverage.stampFillRate`, so the two agree on the wire. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * The zero ladder — coarsest cause first, so a reader is told the OUTERMOST
 * reason nothing was found rather than an inner one that is merely a consequence.
 *
 * The final rung is polarity-dependent, and that is the whole point: `'clean'` is
 * reserved for a DEFECT count that came back empty over a real denominator. A
 * desirable behaviour that nobody performed lands on `'none-observed'` instead —
 * measured, answered, and not a pass.
 */
function zeroReasonFor(c: MetricCounts, polarity: MetricPolarity): PlaneZeroReason | null {
  if (c.observed > 0) return null;
  if (c.population <= 0) return 'population-empty';
  if (c.eligible <= 0) return 'nothing-eligible';
  if (c.comparable <= 0) return 'nothing-comparable';
  return polarity === 'desirable' ? 'none-observed' : 'clean';
}

/** Guard against a negative or non-finite count silently poisoning a rate. */
function clamp(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Attach one window's counts to a pre-registered spec.
 *
 * Total: an out-of-range count is clamped rather than thrown on, because this runs
 * inside a sweep and a measurement that throws takes the tick down with it.
 */
export function buildMetric(id: PlaneMetricId, raw: MetricCounts): PlaneMetric {
  const spec = METRIC_SPECS[id];
  const counts: MetricCounts = {
    population: clamp(raw.population),
    eligible: clamp(raw.eligible),
    comparable: clamp(raw.comparable),
    observed: clamp(raw.observed),
  };
  const zeroReason = zeroReasonFor(counts, spec.polarity);
  return {
    ...spec,
    ...counts,
    fillRate: ratio(counts.eligible, counts.population),
    rate: ratio(counts.observed, counts.comparable),
    zeroReason,
    // A metric is interpretable exactly when a verdict was possible. `observed > 0`
    // implies it was, so a finding is never suppressed by a mis-supplied denominator.
    interpretable: counts.observed > 0 || counts.comparable > 0,
  };
}

/** Every metric's counts for one window, keyed by id — total by construction, so a
 *  new metric id cannot be forgotten at a call site. */
export type PlaneCounts = Readonly<Record<PlaneMetricId, MetricCounts>>;

/**
 * Compose the whole measurement. PURE and deterministic — same counts, same row.
 *
 * The `summary` leads with how much of the plane is measurable rather than with a
 * rate, because on today's corpus four of six metrics are structurally empty and a
 * summary that opened with "0 divergences, 0 conflicts" would be the precise
 * misreading D-089 and D-087 were both written to prevent.
 */
export function composePlaneMeasurement(args: {
  counts: PlaneCounts;
  windowStartMs: number;
  windowEndMs: number;
  measuredAt?: string;
}): PlaneMeasurement {
  const metrics = PLANE_METRIC_IDS.map((id) => buildMetric(id, args.counts[id]));
  const interpretableCount = metrics.filter((m) => m.interpretable).length;
  const awaitingProducer = metrics
    .filter((m) => {
      if (m.zeroReason === 'population-empty') return true;
      if (m.zeroReason !== 'nothing-eligible') return false;
      // WI-6562 — the same conflation the ratchet had, and the reason the summary
      // line was reporting a demonstrably-live producer as "awaiting a producer".
      // When eligibility is the OCCURRENCE (see MetricSpec.eligibilityIsOccurrence),
      // zero eligible over a real population means the defect did not happen, not
      // that nothing wrote it. A null fill rate still means nothing was examined.
      return !(m.eligibilityIsOccurrence === true && m.fillRate === 0);
    })
    .map((m) => m.id);

  // ⚠ ONLY a DEFECT count is a "finding". A gauge's magnitude (bytes) listed
  // beside real defect counts makes the whole line unrankable, and a desirable
  // behaviour's count is the opposite of a finding when it is high.
  const findings = metrics.filter((m) => m.polarity === 'defect' && m.observed > 0);
  // Measured, answered, and NOT a pass — the case the live corpus surfaced.
  const noneObserved = metrics.filter((m) => m.zeroReason === 'none-observed').map((m) => m.id);
  const gauges = metrics.filter((m) => m.polarity === 'gauge' && m.rate != null);

  const summary =
    `${interpretableCount}/${PLANE_METRIC_IDS.length} plane metrics are measurable in this window` +
    (awaitingProducer.length
      ? `; ${awaitingProducer.length} awaiting a producer (${awaitingProducer.join(', ')})`
      : '') +
    (findings.length
      ? `; findings: ${findings.map((m) => `${m.id}=${m.observed}/${m.comparable}`).join(', ')}`
      : '; no defect findings in the measurable metrics') +
    (noneObserved.length
      ? `; ⚠ never observed: ${noneObserved.join(', ')} (measured, and it did not happen — not a pass)`
      : '') +
    (gauges.length ? `; gauges: ${gauges.map((m) => `${m.id}=${m.rate}/${m.verdictUnit}`).join(', ')}` : '');

  return {
    measuredAt: args.measuredAt ?? new Date(args.windowEndMs).toISOString(),
    windowStartMs: args.windowStartMs,
    windowEndMs: args.windowEndMs,
    metrics,
    interpretableCount,
    awaitingProducer,
    noneObserved,
    summary,
  };
}

/** The verdict of looking at one metric ACROSS windows. */
export interface SeriesAssessment {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** max - min. The number D-030 says must be visible before any delta is believed. */
  spread: number | null;
  verdict: 'insufficient-batches' | 'reportable';
  note: string;
}

/**
 * Assess a metric across windows — the standing half of "baseline and standing
 * measurement".
 *
 * ⚠ IT REFUSES TO REPORT A TREND FROM ONE BATCH, and that refusal is the point.
 * D-030 measured within-arm variance at or above between-arm variance (arm C
 * scored 2/3 then 0/3 on the same scenario), so a single-window delta is noise
 * presented as a result.
 *
 * ⚠ D-035 (STANDING RULE) — *"an effect size may NEVER be inferred from a power
 * requirement."* `insufficient-batches` therefore means "this instrument has not
 * been read enough times to say anything", NEVER "the effect is small". A caller
 * that renders it as the latter has re-introduced exactly the inference D-035
 * forbids.
 */
export function assessSeries(values: readonly (number | null)[]): SeriesAssessment {
  const usable = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (usable.length < MIN_BATCHES_FOR_VARIANCE) {
    return {
      n: usable.length,
      mean: null,
      min: null,
      max: null,
      spread: null,
      verdict: 'insufficient-batches',
      note:
        `Fewer than ${MIN_BATCHES_FOR_VARIANCE} windows carry a rate, so variance is invisible and no ` +
        'trend may be reported (D-030 §3). This says nothing about the SIZE of any effect — inferring ' +
        'a small effect from a thin series is the inference D-035 forbids.',
    };
  }
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  return {
    n: usable.length,
    mean: Math.round(mean * 10_000) / 10_000,
    min,
    max,
    spread: Math.round((max - min) * 10_000) / 10_000,
    verdict: 'reportable',
    note: `${usable.length} windows; spread ${Math.round((max - min) * 10_000) / 10_000} must be read alongside any claimed change.`,
  };
}

/** The five things a metric can be saying. */
export const METRIC_VERDICTS = [
  /** Nothing was measured — the instrument could not run. */
  'unmeasured',
  /** Measured, and a DESIRABLE behaviour did not occur at all. Not a pass. */
  'never-observed',
  /** A defect count came back empty over a real denominator. Good news. */
  'clean',
  /** A DEFECT was found. */
  'finding',
  /** A DESIRABLE behaviour did occur. */
  'present',
  /** A magnitude reading — never good or bad on its own. */
  'gauge',
] as const;
export type MetricVerdict = (typeof METRIC_VERDICTS)[number];

/**
 * What this metric is SAYING, in one word — the single place the polarity and the
 * zero reason are combined.
 *
 * ⚠ It exists because the obvious hand-rolled version is wrong, and was: a
 * consumer naturally writes `isStructuralZero(r) ? 'UNMEASURED' : 'clean'`, which
 * silently relabels `'none-observed'` as a pass. That is the very defect the live
 * run exposed, and it reappeared IMMEDIATELY in the first consumer written after
 * the fix. So the ternary is not left for callers to rebuild — this is the lazy
 * path, per the same D-016/D-047 rule the rest of this plan follows.
 */
export function metricVerdict(
  m: Pick<PlaneMetric, 'zeroReason' | 'polarity' | 'observed'>,
): MetricVerdict {
  if (m.zeroReason && isStructuralZero(m.zeroReason)) return 'unmeasured';
  if (m.zeroReason === 'none-observed') return 'never-observed';
  if (m.zeroReason === 'clean') return 'clean';
  if (m.polarity === 'gauge') return 'gauge';
  return m.polarity === 'desirable' ? 'present' : 'finding';
}

/** True when the verdict must NOT be rendered to a reader as a pass. */
export function isPassVerdict(v: MetricVerdict): boolean {
  return v === 'clean' || v === 'present';
}

/** Render a zero honestly, in one line, wherever a reader meets it. */
export function explainZero(reason: PlaneZeroReason): string {
  switch (reason) {
    case 'population-empty':
      return 'nothing was examined in this window — an idle instrument, not a verdict';
    case 'nothing-eligible':
      return 'units were examined but none carried this metric’s input — the producer has not written, so the metric is unbuilt rather than clean';
    case 'nothing-comparable':
      return 'the input was present but no unit admitted a verdict — a partial answer wearing a zero';
    case 'none-observed':
      return 'measured over a real denominator, and the desirable behaviour did not happen ONCE — the instrument worked, so this is a finding of absence and NOT a pass';
    case 'clean':
      return 'a defect count was possible and nothing was found — the only zero that is good news';
  }
}
