import { continuityProbeShapeSchema, type ContinuityProbe } from '../../continuity-probes';
import { leadingScaleLabel } from '../../rubric-rating-vocabulary';

/**
 * observation-types.ts — the canonical structured-observation v2 shape
 * (rubric-driven-observations-2026-06-20 P-001 / D-003).
 *
 * A NEUTRAL LEAF MODULE. Both the WRITE side (capture-core.ts + the
 * improvements:capture tool) and the READ side (read-items.ts issueToCandidate)
 * import the type + validator from HERE, so neither imports the other:
 * capture-core already imports read-items (OBSERVATION_TOPIC / issueToCandidate),
 * so a shared type defined IN capture-core that read-items imported would be a
 * read-items ↔ capture-core import cycle. This leaf has no improvement-loop
 * imports, so it breaks the cycle.
 *
 * The structured observation rides `engineer_issues.payload.observation`. v1
 * (turn-end-reflection-observations-2026-06-14 D-005) was
 * `{ kind, scope, confidence, refs }`. v2 (this plan) converges the source-hive
 * tag (workspace-scoped-coordination-2026-06-20 P-001) + the rubric grading
 * (this plan) into ONE coherent extension (D-002), adding:
 *   - sourceHive / targetHive — the hive the observation came FROM / is ABOUT.
 *   - rubricRef — a `rubrics.rubric_id` the observation grades against.
 *   - ratings   — per-criterion structured ratings; evidence MANDATORY per rating.
 * Free-text observations stay FIRST-CLASS: every field is optional; a plain
 * observation carries none of them (rubrics augment, never replace — D-001).
 */

/**
 * The shared rating-scale vocabulary (D-003). A rubric criterion MAY override
 * with its own ratingScale, but this is the default the Overwatch scorecard
 * (P-004) and the Scout digest grouping (P-006) line up on.
 *   - healthy  — the characteristic is working as its rubric model expects.
 *   - degraded — drifting, but not broken (a warning).
 *   - broken   — the characteristic has failed its model.
 *   - unknown  — not-assessable this wake (e.g. an idle subsystem with no signal).
 */
export const OBSERVATION_RATING_SCALE = ['healthy', 'degraded', 'broken', 'unknown'] as const;
export type ObservationRating = (typeof OBSERVATION_RATING_SCALE)[number];

/** Explicit epistemic reason for an unknown rating. */
export const OBSERVATION_UNKNOWN_REASONS = [
  'idle',
  'not-exercised',
  'instrument-unavailable',
  'retention-gap',
  'generation-mismatch',
  'external-capacity',
  'scope-mismatch',
  'other',
] as const;
export type ObservationUnknownReason = (typeof OBSERVATION_UNKNOWN_REASONS)[number];

/** Who/what the evidence describes, kept separate from the rating itself. */
export const OBSERVATION_ATTRIBUTIONS = ['subject', 'system', 'instrument', 'environment', 'ambiguous'] as const;
export type ObservationAttribution = (typeof OBSERVATION_ATTRIBUTIONS)[number];

/** One per-criterion rating against a rubric. `evidence` is MANDATORY + non-empty
 *  (D-002: "mandatory evidence per rated criterion") so a rating is never an
 *  unbacked assertion — `validateObservationRatings` rejects an empty one. */
export interface ObservationRatingEntry {
  /**
   * A value from the criterion's ratingScale (default OBSERVATION_RATING_SCALE).
   * Kept a free `string` (not the enum) so a rubric with a CUSTOM scale still
   * validates — the rubric, not this type, owns the per-criterion vocabulary.
   */
  rating: string;
  /** Concrete evidence backing the rating — a metric, a query result, a cite.
   *  MANDATORY + non-empty. */
  evidence: string;
  /**
   * A concrete replay locator. New scorecards should use this instead of
   * embedding an opaque query/result in prose; historical entries may omit it.
   */
  evidenceRef?: string;
  /** The evidence's source kind, e.g. tool, test, query, or manual. */
  evidenceKind?: string;
  /** Positive control for an absence/zero claim. */
  positiveControlRef?: string;
  /** Explicitly marks that the evidence is making an absence/zero claim. */
  absenceClaim?: boolean;
  /** Explicit epistemic reason when rating is unknown. */
  unknownReason?: ObservationUnknownReason;
  /** Attribution for the observed condition, independent of its rating. */
  attribution?: ObservationAttribution;
  /** Concrete next step to resolve an unknown or measurement gap. */
  nextEvidenceAction?: string;
  /** OPTIONAL grader suggestion (blender-self-learning-2026-07-12 P-005): the
   *  grader's own concrete improvement idea for THIS criterion, born of the
   *  specific context only the grader saw. Folded into the digest's
   *  rubric-rating pattern detail so the Blender's ideators SEE it and can
   *  adopt/adapt it (the owner's "graders also have more specific context"
   *  ruling — the Blender chooses, the grader seeds). */
  suggestion?: string;
  /** scorecard-poor-rating-disposition (owner-directed 2026-08-31): the WI-/EI-/F-
   *  work-item (optionally with a short note) this POOR rating's remediation is
   *  tracked by. A fail/severe/broken/degraded/partial rating on a standard rubric
   *  must carry `remediation` or `disregard` — a poor grade with neither is the
   *  skipped step the gate exists to stop. See
   *  `validateScorecardPoorRatingDisposition`. */
  remediation?: string;
  /** The explicit alternative to `remediation`: a reasoned, OWNED decision not to
   *  act on this poor rating (≥10 chars — "n/a" is not a decision). */
  disregard?: string;
}

/**
 * Per-criterion ratings, KEYED by rubric criterion `key` — one rating per
 * criterion (a scorecard). Record (not Array) by D-003: it encodes the
 * "all criteria present" invariant for a fixed-set scorecard, structurally
 * guarantees criterion-uniqueness (an array can double-list / silently drop),
 * and gives O(1) keyed access for the Scout digest grouping + the v2 trend view
 * (jsonb_each is as SQL-friendly as jsonb_array_elements).
 */
export type ObservationRatings = Record<string, ObservationRatingEntry>;

/**
 * The plan implementer's post-grading acceptance call (plan-completion-audit-and-
 * acceptance-verdict-2026-08-13 D-001). The independent grader owns `ratings`;
 * the acceptance-rubric author records this separate judgment only after reading
 * a complete independent grading.
 */
/**
 * WI-2141007: the audited record of an acceptance seat inherited from a DEAD
 * rubric author. Server-stamped by `scorecards:emit` only — `acceptance` is a
 * `.strict()` zod object, so a caller cannot supply this field and cannot forge
 * a succession it did not earn.
 *
 * This exists because the acceptance seat used to be permanently unfillable once
 * its author session ended: only the author may record the verdict, and any
 * session in the author's lineage is refused as a grader, so with a dead author
 * the eligible set is EMPTY and the plan can never ship. The alternative repair
 * the old refusal advertised — `coord:rebind-identity` — is identity CONTINUITY
 * (one agent reclaiming its own surfaces after its sid changed) and migrates the
 * dead author's ENTIRE owner-keyed surface set (loops, claims, locks, facts,
 * fleet membership). Using it merely to pass an independence control both
 * defeats the control and moves state nobody asked to move (EI-22135313244682666).
 * This record transfers the SEAT ALONE, and says so on the card.
 */
export interface AcceptanceSeatSuccession {
  /** The recorded rubric author whose seat was inherited. */
  succeededFrom: string;
  /** The author's session state observed at succession time; never a live state. */
  authorSessionState: string;
  /** The work-item the successor holds that makes them accountable for the plan. */
  basisWorkItemId: string;
  /** The subject plan that work-item belongs to. */
  basisPlanSlug: string;
  succeededAt: string;
}

export interface ScorecardAcceptance {
  /**
   * 'accept-pending-delivery' records an ACCEPTED judgment whose only
   * outstanding obligation is evidence on a delivery plane the author cannot
   * reach. It is deliberately distinct from both: 'accept' would overclaim a
   * delivery that has not happened, and 'reject' would misstate a healthy
   * grading as a failed one.
   */
  verdict: 'accept' | 'reject' | 'accept-pending-delivery';
  /** Why the independent grading is (or is not) acceptable for this plan. */
  reasoning: string;
  /**
   * Present ONLY when this verdict was recorded by a successor rather than the
   * recorded author. Absent on the ordinary path. Readers that ask "is this an
   * author-side verdict?" must treat a card carrying this as authoritative —
   * see `plan-acceptance-gate.ts`, which would otherwise misclassify a
   * successor's verdict as an independent grading.
   */
  seat?: AcceptanceSeatSuccession;
  /**
   * P-003 (review-verification-efficiency-2026-09-09): present when this
   * verdict's ratings were ADOPTED verbatim from the named independent card
   * rather than transcribed by the author. The persisted card is complete
   * either way, so without this stamp an adopted grading would be
   * indistinguishable from one the author rated themselves — and the whole
   * point of the reference is that the author did NOT re-perform the grading.
   * Absent on the ordinary transcribed path.
   */
  adoptedRatingsFrom?: {
    /** The independent scorecard's issue id, exactly as the author cited it. */
    scorecardId: string;
    /** Who graded it — the party whose judgment these ratings actually are. */
    gradedBy: string;
    /** The rubric revision that card graded; equal to the accepting card's by construction. */
    rubricRevision?: number;
  };
  /**
   * WI-10003534: the independent grading this verdict was ADMITTED against, stamped by
   * the server on EVERY author verdict — whether the ratings were adopted, transcribed,
   * or the card was found by the scan instead of named in `acceptanceOf`.
   *
   * The emit door already refuses an author verdict unless a complete grading from
   * outside the implementer's lineage exists, but before this stamp it recorded WHICH
   * card satisfied that rail only on the adoption path. A census on 2026-09-27 found
   * 13 of 31 verdicts since 2026-09-20 citing no reviewer at all, one of them the final
   * `accept` on a shipped plan. Independence held; the verdict could not show it.
   * `adoptedRatingsFrom` keeps its narrower meaning ("these ratings are that card's").
   */
  independentGrading?: {
    /** The gate-verified independent scorecard's issue id. */
    scorecardId: string;
    /** Its grader — outside the implementer's (and any seat successor's) lineage. */
    gradedBy: string;
    /** The rubric revision that card graded, when recorded. */
    rubricRevision?: number;
    /** `acceptanceOf` = the author named it; `scan` = the server picked the first eligible card. */
    selectedBy: 'acceptanceOf' | 'scan';
  };
}

/**
 * One caller-attested fingerprint used by the spec-test-adequacy evaluator's
 * currentness pass. The nullable dimensions are explicit so a reader can
 * distinguish an intentionally inapplicable dimension from a missing recipe.
 */
export interface SpecTestAdequacyCurrentFingerprint {
  /** Exact clause identity for scoped currentness; omitted on legacy recipes. */
  planSlug?: string;
  specId?: string;
  specRevision?: number;
  specFingerprint?: string;
  evidenceKind: string;
  evidenceRef: string;
  sourceFingerprint: string;
  testFingerprint: string | null;
  fixtureFingerprint: string | null;
  rubricFingerprint: string | null;
  environmentFingerprint: string | null;
}

/**
 * Build identity of the evaluator process that generated a rerun recipe.
 *
 * This is optional on the wire for historical recipes that predate the stamp;
 * newly generated recipes always include it so a terminal card can be compared
 * with the evaluator build that was actually running when it was minted.
 */
export interface SpecTestAdequacyEvaluatorBuild {
  sha: string | null;
  version: string;
}

/**
 * The canonical replay contract emitted with a spec-test-adequacy scorecard.
 * It records both the exact clause/evidence selection and the caller's
 * currentness inputs; without those two pieces a persisted scorecard can only
 * repeat the author's verdict, not independently reproduce freshness.
 */
export interface SpecTestAdequacyRerunRecipe {
  schemaVersion: 1;
  evaluator: 'plans:evaluate-spec-test-adequacy';
  /**
   * Loaded evaluator identity at mint time. Absent only on historical recipes
   * written before evaluator build stamping was introduced.
   */
  evaluatorBuild?: SpecTestAdequacyEvaluatorBuild;
  /**
   * P-043 (review-system-rework-reduction-2026-09-23): the evaluator RULE revision
   * (`SPEC_TEST_ADEQUACY_EVALUATOR_REVISION`) that produced these verdicts. Unlike
   * `evaluatorBuild`, which changes on every deploy, this moves only when a rule
   * change can alter a verdict for unchanged evidence. A card graded under an older
   * revision is re-evaluated from its stored runs; only a changed verdict needs a new
   * audit. Absent on cards minted before the stamp (treated as revision 1).
   */
  evaluatorRevision?: number;
  /**
   * The plan class the recorded verdicts were produced under.
   *
   * REQUIRED by `evaluator`, which rejects a call that omits it, and it materially
   * moves `plan-class-risk-floor`. A recipe that did not record it forced a
  * re-runner to GUESS one of four values, and a wrong guess silently changes the
  * verdict it is supposed to reproduce.
  */
  classRef: string;
  /**
   * The exact argument object to submit to `evaluator` to reproduce these verdicts.
   *
  * `selection` below is the human-readable identity of what was graded; it is NOT
  * submittable — it spells `planSlug`/`specId`/`specRevision`/`specFingerprint`,
  * while the evaluator accepts `slug`/`specIds` and refuses the rest as
  * unrecognized keys. Submit THIS. A rerun recipe its own evaluator rejects is not
  * a rerun recipe, so this field is what makes the card independently checkable.
  */
  args: {
    /** Persist the resolved harness so an operator-scope replay can resolve its data plane. */
    harness?: string;
    slug: string;
    classRef: string;
    /** Pin the evaluator build used to produce this replay recipe. */
    evaluatorBuild?: SpecTestAdequacyEvaluatorBuild;
    specIds: string[];
    /** Preserve the evidence-population selector used by the original evaluation. */
    workItemIds?: string[];
    /** Preserve exact immutable evidence identities so superseded runs stay excluded. */
    evidenceRefs?: string[];
    /** Preserve an explicit plan-item selector instead of widening the replay. */
    planItemIds?: string[];
    /** Bound the evidence page for pressure-safe judge replays. */
    limit?: number;
    /** Pin replay to the exact immutable clause revision graded by the emitter. */
    specRevision?: number;
    /** Content hash paired with specRevision for an exact immutable clause pin. */
    specFingerprint?: string;
    /** Reuse current fingerprints as the graded server-measured snapshot. */
    replaySnapshot?: true;
    includeDraft: true;
    current?: SpecTestAdequacyCurrentFingerprint[];
  };
  selection: {
    planSlug: string;
    specId: string;
    specRevision: number;
    specFingerprint: string;
    evidence: Array<{ evidenceKind: string; evidenceRef: string }>;
  };
  current: {
    supplied: boolean;
    fingerprints: SpecTestAdequacyCurrentFingerprint[];
  };
  derivation: {
    kind: 'listSpecEvidence.currentness';
    classifier: 'classifySpecEvidenceCurrentness';
    unknownWhenMissing: true;
  };
}

/** v1 free-text observation fields (turn-end-reflection-observations D-005). */
export const OBSERVATION_KINDS = ['friction', 'workaround', 'gap', 'surprise', 'reinforce', 'test-failure'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export type ObservationScope = 'self' | 'role' | 'harness' | 'papercusp';
export type ObservationConfidence = 'low' | 'med' | 'high';

/**
 * Authoritative release-gate binding for a scorecard that claims at least one
 * positive criterion. `stale-pass-blocked` is returned by evaluate/emit so the
 * caller can render the gate reason; only `bound` is written to the ledger.
 */
export interface ScorecardReleaseGateBinding {
  status: 'bound' | 'stale-pass-blocked';
  reasonCode: string | null;
  reason: string | null;
  checkedAt: string;
  testedSha: string | null;
  gateVerdict: 'green' | 'not-green' | null;
  gateCandidate: string | null;
  lastGreenCommit: string | null;
  stagingHead: string | null;
  commitsBehindHead: number | null;
  failingTests: string[];
}

/**
 * The canonical structured-observation v2 record stored at
 * `engineer_issues.payload.observation`. All fields optional — free-text
 * observations carry none of them.
 */
export interface StructuredObservation {
  // ── v1 free-text fields (D-005) — unchanged, still first-class.
  kind?: ObservationKind;
  scope?: ObservationScope;
  confidence?: ObservationConfidence;
  refs?: string[];
  // ── v2 fields (this plan / D-003).
  /**
   * The hive the observation came FROM. Auto-derived from ctx (the agent's
   * hive/harness) by the improvements:capture tool when omitted; explicit
   * callers (Overwatch / Scout) may set it. The Scout digest groups by it (P-006).
   */
  sourceHive?: string;
  /** Optional: the hive the observation is ABOUT (a cross-hive observation). */
  targetHive?: string;
  /**
   * A `rubrics.rubric_id` this observation grades against (e.g.
   * 'pot-coordination-health'). Present ⇒ a rubric-graded observation, and
   * `ratings` must be present + each rating backed by evidence.
   */
  rubricRef?: string;
  /** The graded rubric's plan-row revision at emit time; absent on historical cards. */
  rubricRevision?: number;
  /** Acceptance-BAR meaning epoch at emit time; absent on legacy or non-BAR cards. */
  rubricMeaningRevision?: number;
  /**
   * The graded rubric's `criteriaHash` (WI-1393208) at emit time — a stable hash
   * over {characteristic, criteria, ratingScale, methodRef, description}. Unlike
   * `rubricRevision` (which bumps on ANY propose, typo included), this is stale
   * exactly when the rubric's graded SUBSTANCE changed since this card was filed.
   * Absent on historical cards and whenever the hash read failed at emit time.
   */
  criteriaHash?: string;
  /** Identity of a rubric named as the SUBJECT of this scorecard, distinct from rubricRef. */
  subjectRubricIdentity?: {
    rubricRef: string;
    revision?: number;
    criteriaHash?: string;
    meaningRevision?: number;
  };
  /** Per-criterion ratings against `rubricRef` — each carries MANDATORY evidence. */
  ratings?: ObservationRatings;
  /** Server- or grader-derived roll-up; categorical and non-compensating. */
  rollup?: {
    verdict: 'exemplary' | 'pass' | 'partial' | 'fail' | 'severe' | 'unassessable';
    criticalKeys: string[];
    criticalFailures: string[];
    criticalUnknowns: string[];
    coverage: { rated: number; required: number; sufficient: boolean };
  };
  /**
   * Commit that a release-gating scorecard's positive ratings actually tested.
   * `scorecards:emit` accepts this only after binding it to the live green pin and
   * current staging HEAD. Absent on non-release scorecards and historical cards.
   */
  testedSha?: string;
  /**
   * Server-stamped proof that `testedSha` matched the authoritative release gate
   * at emit time. A blocked attempt is returned to the caller but never persisted;
   * stored observations therefore carry only `status:'bound'` records.
   */
  releaseGateBinding?: ScorecardReleaseGateBinding;
  /** Post-grading implementer verdict; valid only for acceptance-kind rubrics. */
  acceptance?: ScorecardAcceptance;
  /** Structured currentness inputs and selector for independently replaying spec-test-adequacy. */
  rerunRecipe?: SpecTestAdequacyRerunRecipe;
  /**
   * Stable SHA-256 of the canonical rubricRef + ratings + deterministic instrument
   * snapshots. Written by scorecards:emit so repeated grading of unchanged evidence
   * can be declined without creating a duplicate history row.
   */
  evidenceFingerprint?: string;
  /**
   * The scorecard issue this filing corrects. The target remains in the append-only
   * ledger for audit, but scorecard reads exclude it from the live sample by default.
   */
  supersedes?: string;
  /** A deliberate withdrawal of this scorecard, preserving the original evidence. */
  retracted?: ScorecardRetraction;
  /** Deterministic instrument snapshots attached by scorecards:emit/evaluate. */
  instrumentSnapshots?: Record<string, unknown>;
  /**
   * WHAT this scorecard grades — the per-RUN identity
   * (goal-mode-rubric-v2-2026-08-10 P-009).
   *
   * THE GAP THIS CLOSES: a PER-RUN rubric (goal-mode-e2e grades ONE run of ONE
   * agent) had nowhere structured to say WHICH run a scorecard is about.
   * `sourceHive`/`targetHive` answer which POT, never which RUN, so all five v1
   * goal-mode-e2e scorecards were indistinguishable from each other by field —
   * you could not re-derive one, compare two runs, or even attribute a grade to
   * its subject without reading prose.
   *
   * WHY THIS SHAPE, and not a free-form label: it is exactly the DRILL PARAMETER
   * BINDING. Measured across goal-mode-e2e v2's 25 criteria, the replication
   * drills are parameterized by three things and no others — `:subject` (20
   * criteria), `:run_start` (12), `:run_end` (11). Recording precisely those
   * makes a scorecard RE-RUNNABLE FROM ITS OWN RECORD: a reader can replay every
   * drill that produced it. A looser "notes"-style field would not have that
   * property, which is the whole point.
   *
   * Optional, like every other field here — a pot-level or free-text observation
   * carries no subject and is unaffected.
   */
  subject?: ObservationSubject;
  /**
   * P-008 (EI-20581177540737568): stamped SERVER-SIDE by scorecards:emit when this
   * scorecard rates 'violatable'-class criteria (monotonic-downward — one violation
   * falsifies permanently) without the emitter affirming the graded subject has
   * TERMINATED. A provisional card is a working note (plan D-004): trend/release
   * surfaces exclude it, and the terminal re-emit (terminal:true, superseding this
   * card) is what makes the grading final. Never caller-supplied.
   */
  provisional?: ScorecardProvisional;
  /**
   * The vetting linkage (consult-min-max-and-rubric-vetting-2026-08-17 P-004) —
   * present only on a vetting scorecard (meta-rubric grading of an acceptance
   * rubric; `subject` then names the vetted rubric). Stamped server-side by
   * scorecards:emit after validating the consult + subject rubric exist; never
   * caller-supplied directly. See {@link ScorecardVetting}.
   */
  vetting?: ScorecardVetting;
  /** P-013: the grade-the-grader audit stamp — see {@link ScorecardGradingAudit}. */
  gradingAudit?: ScorecardGradingAudit;
  /**
   * P-011 (owner-ratified D-006): grading-time DETERMINISTIC check runs, keyed by
   * criterion key — stamped server-side by scorecards:emit for every rated criterion
   * whose rubric check is kind:'tests' or kind:'cargo'. Each record is a LIVE run
   * performed at emit time (never a stale ledger read), so a rating the run contradicts
   * is machine-detectable from the scorecard itself. Never caller-supplied.
   */
  checkRuns?: Record<string, ScorecardCheckRun>;
}

/**
 * One criterion's grading-time deterministic check run — see
 * {@link StructuredObservation.checkRuns}. The emit path REFUSES a contradicted
 * pass-claiming rating outright, so a persisted 'fail' verdict coexists only with a
 * rating that honestly reflects it (or a bespoke scale word outside the pass map).
 */
export type ScorecardCheckRun =
  | ScorecardTestsCheckRun
  | ScorecardProbeCheckRun
  | ScorecardCargoCheckRun
  | ScorecardCoverageCheckRun
  | ScorecardRequirementsCheckRun;

export interface ScorecardTestsCheckRun {
  kind: 'tests';
  /** The repo-root-relative files that ran. */
  files: string[];
  verdict: 'pass' | 'fail';
  /** Test counts from the run (complete, never truncated). */
  passed: number;
  failed: number;
  /** Run correlation id (PAPERCUSP_TEST_RUN_GROUP) — ledger rows findable by it. */
  runId: string | null;
  /** Exact scoped harness_shared.test_runs row ids, when the run had tenant scope. */
  testRunIds?: number[];
  /** ISO instant the run finished (emit time). */
  measuredAt: string;
  /** Bounded failing-test names ("file: test"), only on a 'fail' verdict. */
  failures?: string[];
}

/**
 * One criterion's grading-time ContinuityProbe result. Probe checks are the
 * criterion-level bridge to the existing typed, read-only probe infrastructure:
 * the rubric stores the concrete probe, while scorecards:emit stores the
 * platform-executed predicate result. Only fresh/stale runs are persisted;
 * unknown/error results refuse the emit rather than becoming an unjudgeable
 * scorecard.
 */
export interface ScorecardProbeCheckRun {
  kind: 'probe';
  /** The schema-versioned probe that was executed. */
  probe: ContinuityProbe;
  /** A fresh predicate match is pass; a stale predicate match is fail. */
  verdict: 'pass' | 'fail';
  /** The ContinuityProbe status before mapping to the scorecard verdict. */
  status: 'fresh' | 'stale';
  /** Persisted probe runs are always executed; unexecuted probes refuse emit. */
  executed: true;
  /** Scalar observation returned by the probe, when the predicate exposed one. */
  observed?: string | number | boolean | null;
  /** ISO instant the scorecard recorded this live result. */
  measuredAt: string;
}

/**
 * One criterion's grading-time native Cargo check. Cargo's stable test output
 * reports tests at crate/binary scope, not the Rust source file that contains each
 * inline `#[test]`. `sourceFiles` is therefore an explicit attribution scope, while
 * the counts and verdict remain the honest crate-level measurement.
 */
export interface ScorecardCargoCheckRun {
  kind: 'cargo';
  /** The repo-root-relative manifest that was actually tested. */
  manifestPath: string;
  /** Rust/source files to which the crate-level verdict is attributed. */
  sourceFiles: string[];
  /** Optional Cargo test-name filter used for this measurement. */
  test?: string;
  verdict: 'pass' | 'fail';
  /** Complete counts parsed from Cargo's test result lines. */
  passed: number;
  failed: number;
  ignored: number;
  /** Run correlation id for this live native invocation. */
  runId: string | null;
  /** ISO instant the run finished (emit time). */
  measuredAt: string;
  /** Bounded failing test names, only on a 'fail' verdict. */
  failures?: string[];
}

/**
 * One criterion's grading-time SURFACE-CENSUS measurement (deterministic-coverage-census
 * P-006). Persisted so the verdict stays auditable after the census itself has moved on.
 *
 * ⚠ Every count here is an aggregate over the WHOLE in-scope population, taken from
 * `readCoverage` — never from its `limit`-capped row list. `belowSurfaces` IS bounded
 * (it is a message, not a measurement), which is exactly why `belowUnwaived` is stored
 * beside it: a reader must be able to see that 3 named surfaces stand for 40.
 */
export interface ScorecardCoverageCheckRun {
  kind: 'coverage';
  /** The scope as RESOLVED at grading time (planTouched already expanded to files). */
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true };
  /** The rung asserted — the census's own l1..l4 vocabulary. */
  floor: 'l1' | 'l2' | 'l3' | 'l4';
  verdict: 'pass' | 'fail';
  /** Censused surfaces in scope (the denominator; a 0 here REFUSES rather than passing). */
  surfaces: number;
  /** In-scope surfaces meeting `floor`. */
  meets: number;
  /** In-scope surfaces below `floor` and NOT waived — the pass condition (0 ⇒ pass). */
  belowUnwaived: number;
  /** meets/surfaces as a percentage; NULL when there is no denominator, never 0 or 100. */
  pct: number | null;
  /**
   * The honest ceiling on what the numbers mean. `weakest` is the flimsiest fidelity
   * present in the counted population — 90% over a 'file-only' census is not 90% over a
   * 'declared' one — and a partial census always flatters, because surfaces that were
   * never enumerated cannot appear as gaps.
   */
  fidelity: { weakest: string | null; declaredPct: number | null };
  /** BOUNDED sample of the surfaces below the floor, for the refusal message. */
  belowSurfaces?: string[];
  /** ISO instant the census was read (emit time). */
  measuredAt: string;
}

/**
 * One criterion's grading-time REQUIREMENT-REALIZATION measurement
 * (design-to-code-coverage-seam P-026). Runs the same activation↔completion join the
 * ship gate enforces as `requirement_unrealized`, but from inside the scorecard — so an
 * independent grader, which cannot run Bash, still gets an executable answer to "which
 * of this plan's stated requirements have no observable code".
 *
 * ⚠ The three REPORTED-not-violation populations are stored beside the verdict on
 * purpose. `exemptMappings` (D-035) and `droppedTargets` (P-016) are legitimately not
 * failures, but a pass whose population was mostly unjudged is a different fact from a
 * pass over a fully judged one, and only these counts let a reader tell them apart.
 */
export interface ScorecardRequirementsCheckRun {
  kind: 'requirements';
  verdict: 'pass' | 'fail';
  /** Realizing (covered/repaired) activation mappings this judgement covered. */
  mappingsJudged: number;
  /** `P-NNN` targets actually resolved and judged against the completion audit. */
  checkedTargets: number;
  /**
   * DISTINCT realizing requirements that reached no verified plan item — the fail
   * condition (0 ⇒ pass), and the only count in the same unit as `mappingsJudged`.
   */
  unrealized: number;
  /**
   * The raw (mapping, target) entry count behind `unrealized`. A requirement routed to
   * three unproven items produces three entries and one distinct requirement; both are
   * kept so neither number has to be reconstructed from the other.
   */
  unrealizedEntries: number;
  /**
   * D-035: realizing mappings judged by NOTHING because every target is non-item
   * (`D-NNN` / `section:`). Never a violation — these are conversational requirements
   * whose honest home is a decision — but a pass earned largely from this population is
   * weaker than one earned from `checkedTargets`, so it is reported rather than dropped.
   */
  exemptMappings: number;
  /** P-016: realizing targets pointing at a plan item that is present but `dropped`. */
  droppedTargets: number;
  /**
   * P-016's silent case: dropped targets STILL vouched by a folded pre-drop audit entry,
   * so the coverage claim passes on evidence for work the plan then abandoned.
   */
  droppedTargetsVouchedByStaleAudit: number;
  /** BOUNDED sample of unrealized requirement descriptions, for the refusal message. */
  unrealizedRequirements?: string[];
  /** ISO instant the join was computed (emit time). */
  measuredAt: string;
}

/** The provisional stamp — see {@link StructuredObservation.provisional}. */
export interface ScorecardProvisional {
  /** The rated 'violatable' criterion keys that make this card provisional. */
  violatableKeys: string[];
  /** ISO instant the stamp was applied (emit time). */
  stampedAt: string;
}

/** What kind of thing a scorecard's `subject` names. Open-ended by design: the
 *  grading substrate is per-run TODAY (agent-run/session), but the same identity
 *  gap applies to grading a work-item, a plan, or a pot. 'rubric' = a vetting
 *  scorecard grading a rubric itself against the meta-rubric
 *  (consult-min-max-and-rubric-vetting-2026-08-17 P-004). */
export type ObservationSubjectKind =
  | 'agent-run'
  | 'session'
  | 'work-item'
  | 'plan'
  | 'pot'
  | 'rubric'
  // P-013 (goal-mode-design-intent-hardening-2026-08-16): a grading-integrity AUDIT
  // scorecard grades another SCORECARD (`ref` = the graded card's issue id).
  | 'scorecard';

/**
 * The vetting linkage stamped by scorecards:emit on a VETTING scorecard — a
 * meta-rubric grading of an acceptance rubric (consult-min-max-and-rubric-vetting-
 * 2026-08-17 P-004). The acceptance gate's `acceptance_rubric_unvetted` check keys
 * off this block: the CURRENT rubric revision must carry a complete meta-scorecard
 * with a linked consult. Stamped server-side only after both halves are validated
 * to exist (a dangling consult or subject rubric is refused at emit, mirroring the
 * acceptance-kind link guards — a dangling link is a booby trap).
 */
/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): the grade-the-grader
 * audit stamp on a TERMINAL standard-rubric scorecard. 'pending' = the grading is
 * final but UNAUDITED — excluded from the trend like a provisional card until a
 * NON-AUTHOR auditor grades it against the grading-integrity meta-rubric (mirror of
 * the acceptance grader ≠ author rule). ONE level deep by construction: the audit
 * card itself (rubricRef = grading-integrity) is never stamped pending.
 * `awaiting-reemit` means evaluator semantics changed after the source card was
 * graded; the source author must re-emit it before another audit can make progress.
 */
export interface ScorecardGradingAudit {
  /** `cancelled` means the source scorecard was retracted before its audit settled. */
  state: 'pending' | 'awaiting-reemit' | 'passed' | 'failed' | 'cancelled';
  /** The meta-rubric the audit grades against (grading-integrity). */
  metaRubricRef: string;
  stampedAt: string;
  /** The meta-rubric revision used by the auditor, when the identity was readable. */
  rubricRevision?: number;
  /** The meta-rubric grading-substance hash used by the auditor, when readable. */
  criteriaHash?: string;
  /**
   * Short-lived dispatch reservation written atomically before an auditor is
   * launched. It prevents two independent queue readers from launching for the
   * same pending scorecard; an expired reservation may be replaced safely.
   */
  dispatchReservation?: {
    key: string;
    reservedAt: string;
  };
  /** Why the source card must be re-emitted before its audit can be retried. */
  reemitRequired?: {
    code: 'grading_audit_evaluator_changed';
    at: string;
    reason: string;
  };
  /** The audit scorecard's issue id, once audited. */
  auditIssueId?: string;
  /** The auditor's ownerId (verified ≠ the graded card's author at emit). */
  auditor?: string;
  auditedAt?: string;
}

/** Read-time identity verdict for a grading-integrity stamp. */
export interface ScorecardGradingAuditCurrentness {
  state: 'current' | 'stale' | 'unknown';
  reason:
    | 'current'
    | 'meta-rubric-mismatch'
    | 'recorded-identity-missing'
    | 'live-identity-missing'
    | 'revision-mismatch'
    | 'meaning-revision-mismatch'
    | 'criteria-hash-mismatch';
  recordedRevision: number | null;
  currentRevision: number | null;
  recordedCriteriaHash: string | null;
  currentCriteriaHash: string | null;
}

/**
 * Why a scorecard is NOT admissible as settled evidence — or null when it is
 * (EI-21949865560276745).
 *
 * The trend has always enforced this policy inline, and it was the only place that
 * knew it: a scorecard LIST returns provisional working notes and audit-pending
 * gradings alongside settled ones, so every other reader that took "the newest card"
 * silently took whichever of those happened to be newest. The release-readiness strip
 * did exactly that (see sync-resolver/learning-release-readiness-read.ts).
 *
 * It lives HERE, in the neutral leaf beside the two stamps it reads, rather than in
 * scorecards.ts: the policy is a pure predicate with no storage dependency, and a
 * reader must be able to inherit it without dragging the whole scorecard store (and
 * its PG import) in behind it. Exported rather than copied so a second reader shares
 * the policy instead of drifting from it.
 *
 * ORDER IS LOAD-BEARING: a card that is both provisional AND audit-pending reports
 * 'provisional', so callers bucketing by this value count it ONCE. Counting it in both
 * buckets makes the exclusion figures sum past the number actually excluded — the
 * invisible-arithmetic failure those counts exist to prevent.
 */
export type ScorecardAdmissionExclusion = 'provisional' | 'grading-audit-pending';

export function scorecardAdmissionExclusion(row: {
  provisional?: ScorecardProvisional;
  gradingAudit?: ScorecardGradingAudit;
}): ScorecardAdmissionExclusion | null {
  if (row.provisional) return 'provisional';
  if (row.gradingAudit?.state === 'pending') return 'grading-audit-pending';
  return null;
}

export interface ScorecardVetting {
  /**
   * conversation_id of the get_feedback consult that critiqued the vetted rubric.
   * EXACTLY ONE of `consultId` / `workItemId` is present — the two are alternate
   * recording channels for the same non-vacuity predicate (WI-41477).
   */
  consultId?: string;
  /**
   * WI-41477: the work-item whose third-party comments carry the critique — the
   * channel a LAUNCHED independent reviewer (learning-loop-backlog-triage-2026-08-22
   * D-049) can actually write to, since consult participants are router-assigned and
   * a launched reviewer is never enrolled. Same predicate as the consult channel:
   * ≥1 comment authored by neither the emitter nor the vetted rubric's author.
   */
  workItemId?: string;
  /** The vetted rubric's plan-row `version` (harness_plans.version) at emit time —
   *  how the gate decides the attestation covers the CURRENT revision. Absent when
   *  the version read failed at emit; the gate then treats the card as NOT current
   *  whenever a current revision IS known (strict toward re-vetting). */
  rubricRevision?: number;
  /** Acceptance-BAR meaning epoch of the vetted rubric, when present. */
  rubricMeaningRevision?: number;
  /** The vetted rubric's `criteriaHash` (WI-1393208) at emit time — the graded-
   *  substance fingerprint alongside `rubricRevision`. Absent when the hash read
   *  failed at emit time. */
  criteriaHash?: string;
  /**
   * EI-20821478338037350: how much critique the cited consult had actually
   * received when the stamp was made. The gate used to key off a consult row
   * EXISTING, which made "opened, never answered" indistinguishable from
   * "critiqued" — these three fields are what make the distinction readable
   * after the fact, by a gate or by a human.
   *
   * Third-party posts (neither the emitter's nor the requester's) that counted
   * as critique. 0 only ever appears alongside `unanswered`.
   */
  critiquePosts?: number;
  /** Distinct authors of those critique posts — WHO actually reviewed it. */
  critics?: string[];
  /**
   * An EXPLICIT, recorded no-critique waiver: the emitter attested with a
   * consult nobody answered. Honest and allowed (D-003's live-reviewer fill can
   * still leave a dead responder); what is NOT allowed is it being invisible.
   */
  unanswered?: true;
  /** Why no critique was available — required whenever `unanswered` is set. */
  unansweredReason?: string;
  /** Server-stamped seat succession when a dead author's vetting seat is inherited. */
  seat?: AcceptanceSeatSuccession;
}

/**
 * The graded subject + its measurement window — the binding a replication drill
 * needs to be replayed (`:subject`, `:run_start`, `:run_end`).
 */
export interface ObservationSubject {
  /** What `ref` names. Omitted when the emitter did not classify it. */
  kind?: ObservationSubjectKind;
  /**
   * The graded thing's id — the drills' `:subject`. An ownerId for an agent-run,
   * a session id, a WI-/EI- id, a plan slug, a pot/harness slug. REQUIRED: a
   * subject block that cannot say WHAT it graded is the very gap this closes.
   */
  ref: string;
  /** ISO — start of the graded window; the drills' `:run_start`. */
  windowStart?: string;
  /** ISO — end of the graded window; the drills' `:run_end`. */
  windowEnd?: string;
}

/** Machine-readable scorecard withdrawal metadata. */
export interface ScorecardRetraction {
  at: string;
  by: string;
  reason: string;
}

/** Thrown by `validateObservationRatings` when a rating lacks required evidence
 *  (or a ratings block is malformed). A contract violation, not a soft outcome. */
export class ObservationEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationEvidenceError';
  }
}

/**
 * Enforce D-002's "MANDATORY evidence per rated criterion": every rating in a
 * structured observation MUST carry non-empty `rating` + `evidence`, and a
 * ratings block MUST name its `rubricRef`. Called from the capture CORE so BOTH
 * writers — the improvements:capture tool AND the watchdog — are covered by one
 * gate. Throws `ObservationEvidenceError` on the first offending entry. A
 * free-text / no-rubric observation (no `ratings`, or an empty `ratings`) passes
 * unconditionally — rubrics augment, they never force.
 */
export function validateObservationRatings(obs: StructuredObservation | undefined | null): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings) return;
  const entries = Object.entries(obs.ratings);
  if (entries.length === 0) return;
  if (!obs.rubricRef || !String(obs.rubricRef).trim()) {
    throw new ObservationEvidenceError(
      'a structured observation with ratings must name the rubric it grades against (observation.rubricRef)',
    );
  }
  for (const [criterion, entry] of entries) {
    if (!criterion || !criterion.trim()) {
      throw new ObservationEvidenceError('observation.ratings has an empty criterion key');
    }
    if (!entry || typeof entry !== 'object') {
      throw new ObservationEvidenceError(`observation.ratings['${criterion}'] is not a {rating, evidence} object`);
    }
    if (!entry.rating || !String(entry.rating).trim()) {
      throw new ObservationEvidenceError(`observation.ratings['${criterion}'].rating is required`);
    }
    if (!entry.evidence || !String(entry.evidence).trim()) {
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'] is missing required evidence — a rubric rating must cite ` +
          'concrete evidence (a metric, a query result, a reference)',
      );
    }
  }
}

/**
 * Enforce the scorecard COMPLETENESS mandate (plan-templates-and-rubric-v2 P-014a / D-005):
 * a rubric-graded observation (a scorecard) MUST rate EXACTLY the criteria the rubric declares.
 * An omitted criterion is a silent partial-truncation — D-005 caught a pressured Overwatch
 * emitting 3–4 of 13 keys with no error — NOT a pass. A not-assessable criterion is rated
 * 'unknown' (with evidence, e.g. "no signal this wake"), never dropped. The sibling of
 * `validateObservationRatings`: together they make the every-turn "all keys present, each
 * backed by evidence" mandate a RUNTIME gate, not prompt-only.
 *
 * `requiredKeys` is the rubric's criterion `key` set — the CALLER loads it (via getRubric),
 * keeping this leaf sync + rubrics-import-free (no leaf→rubrics dependency). `null` ⇒ the
 * rubric is unknown/unloaded, so completeness can't be enforced → skip (rubricRef *validity*
 * is a separate concern). A free-text / no-rubric / empty-ratings observation passes
 * unconditionally (rubrics augment, never force). Throws `ObservationEvidenceError` (the
 * capture tool catches it into a clean `{ ok:false, error }`), naming missing and
 * unexpected keys. Extras are not harmless metadata: they become permanent fake
 * dimensions in rubric trends (WI-4761 / EI-11617).
 */
export function validateScorecardCompleteness(
  obs: StructuredObservation | undefined | null,
  requiredKeys: string[] | null,
): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings) return;
  const ratedKeys = Object.keys(obs.ratings);
  if (ratedKeys.length === 0) return; // empty ratings → validateObservationRatings owns that case
  if (!requiredKeys || requiredKeys.length === 0) return; // unknown / criteria-less rubric → can't enforce
  const rated = new Set(ratedKeys);
  const required = new Set(requiredKeys);
  const missing = requiredKeys.filter((k) => !rated.has(k));
  const unexpected = ratedKeys.filter((k) => !required.has(k));
  if (missing.length > 0 || unexpected.length > 0) {
    const mismatch = [
      ...(missing.length > 0 ? [`missing required criterion key(s): ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected criterion key(s): ${unexpected.join(', ')}`] : []),
    ].join('; ');
    throw new ObservationEvidenceError(
      `scorecard for rubric '${obs.rubricRef ?? '(unnamed)'}' is INVALID/INCOMPLETE — ${mismatch}. ` +
        `A rubric scorecard must rate exactly the declared criteria (rate a not-assessable one 'unknown' ` +
        `WITH evidence, never omit or invent a key) — a key mismatch corrupts completeness and trend history.`,
    );
  }
}

/**
 * Enforce rating-VALUE validity (rubric-system-improvements-2026-07-12 P-002):
 * every rating in a rubric-graded scorecard must be a value from the criterion's
 * ratingScale (falling back to the rubric's default scale), case-insensitive;
 * 'unknown' is always accepted (the universal not-assessable rating). Without
 * this, a typo'd rating ("pas", "helthy") files fine and is then silently
 * EXCLUDED from trend direction / staleness — the same silent-exclusion class
 * as the P-004 missing-pass-vocabulary bug, but per-filing. The sibling of
 * `validateScorecardCompleteness` and shaped the same way: the CALLER loads the
 * rubric (this leaf stays sync + rubrics-import-free); `null` rubric ⇒ can't
 * validate ⇒ skip. Throws `ObservationEvidenceError` naming the offending key,
 * the bad value, and the allowed values.
 */
export function validateScorecardRatingValues(
  obs: StructuredObservation | undefined | null,
  rubric: {
    ratingScale?: readonly string[];
    criteria: readonly { key: string; ratingScale?: readonly string[] }[];
  } | null,
): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings || !rubric) return;
  const rubricScale = (rubric.ratingScale ?? []).filter((v) => typeof v === 'string' && v.trim());
  const byKey = new Map(rubric.criteria.map((c) => [c.key, c.ratingScale]));
  for (const [criterion, entry] of Object.entries(obs.ratings)) {
    if (!entry || typeof entry !== 'object' || !entry.rating) continue; // evidence gate owns malformed entries
    const scale = (byKey.get(criterion) ?? rubricScale).filter((v) => typeof v === 'string' && v.trim());
    if (scale.length === 0) continue; // scale-less rubric/criterion → nothing to validate against
    const allowed = new Set(scale.map((v) => v.toLowerCase()));
    allowed.add('unknown');
    if (!allowed.has(String(entry.rating).trim().toLowerCase())) {
      const allowedList =
        allowed.has('unknown') && scale.some((v) => v.toLowerCase() === 'unknown') ? scale : [...scale, 'unknown'];
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'].rating '${entry.rating}' is not on the rubric's rating scale — ` +
          `allowed: ${allowedList.join(' | ')}. An off-scale rating would be silently excluded ` +
          'from trends/staleness, so it is rejected at capture instead.',
      );
    }
  }
}

/** Rating values that demand a disposition (lower-cased compare). Scale-agnostic
 *  on purpose: it spans the default observation scale (degraded/broken) and the
 *  graded-rubric scales (partial/fail/severe); a rubric with an exotic scale whose
 *  poor values match none of these is simply not gated (fail-open, like the
 *  sibling gates' unknown-rubric convention). */
export const POOR_SCORECARD_RATINGS = ['fail', 'severe', 'broken', 'degraded', 'partial'] as const;

/**
 * Enforce the poor-rating DISPOSITION mandate (scorecard-poor-rating-disposition,
 * owner-directed 2026-08-31): every poor rating on a standard rubric must terminate
 * in one of exactly two dispositions — `remediation` (the WI-/EI-/F- work-item the
 * fix/investigation is tracked by) or `disregard` (an explicit, reasoned decision
 * not to act). The failure this kills: a grader files 5 fails and 7 partials, the
 * card looks diligent, and NOTHING routes anywhere — the remediation step is
 * skipped silently and the next agent re-derives the whole fix map from scratch.
 *
 * Fourth sibling of `validateObservationRatings` / `validateScorecardCompleteness`
 * / `validateScorecardRatingValues`, shaped the same way: the CALLER loads the
 * rubric; `null` rubric ⇒ can't judge ⇒ skip. Scoped to `kind:'standard'` rubrics
 * (a missing kind IS standard — the default): acceptance rubrics carry their own
 * disposition ceremony (the implementer's accept/reject verdict) and are exempt.
 * Enforcement is opt-in per WRITE PATH (the agent-facing tools set it; system
 * floor emitters — pulse/backstop/watchdogs — stay exempt so the monitoring floor
 * cannot be broken by the gate). Throws `ObservationEvidenceError` naming the
 * offending key and the exact fields to add.
 */
export function validateScorecardPoorRatingDisposition(
  obs: StructuredObservation | undefined | null,
  rubric: { kind?: string | null } | null,
): void {
  if (!obs || typeof obs !== 'object' || !obs.ratings) return;
  if (!rubric) return; // unknown/unloaded rubric → the sibling gates' fail-open convention
  if ((rubric.kind ?? 'standard') !== 'standard') return; // acceptance flow owns its own disposition
  // grading-integrity audits are exempt: a failing audit rating SETTLES the target
  // card's gradingAudit.state as failed (emit's P-013 path), which itself forces the
  // re-grade — the disposition is structural, not a rating-level field. (Mirrors
  // GRADING_INTEGRITY_RUBRIC_REF; hardcoded so this leaf stays rubrics-import-free.)
  if ((obs.rubricRef ?? '').trim() === 'grading-integrity') return;
  const poor = new Set<string>(POOR_SCORECARD_RATINGS);
  for (const [criterion, entry] of Object.entries(obs.ratings)) {
    if (!entry || typeof entry !== 'object' || !entry.rating) continue; // evidence gate owns malformed entries
    if (!poor.has(String(entry.rating).trim().toLowerCase())) continue;
    const remediation = typeof entry.remediation === 'string' ? entry.remediation.trim() : '';
    const disregard = typeof entry.disregard === 'string' ? entry.disregard.trim() : '';
    if (!remediation && !disregard) {
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'] is rated '${entry.rating}' but carries NO disposition — ` +
          `a poor rating must route somewhere: pass remediation:'<WI-/EI-/F- ref (+ optional note)>' naming ` +
          `the fix/investigation item it feeds (file one first if none exists), or disregard:'<reason>' as an ` +
          `explicit, owned decision not to act. A poor grade nobody routes is a skipped remediation step, ` +
          `and skipping it silently is exactly what this gate rejects.`,
      );
    }
    if (remediation && !/(?:WI|EI|F)-\d+/.test(remediation)) {
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'].remediation ('${entry.remediation}') names no work-item — ` +
          `it must cite the WI-/EI-/F- item the remediation is tracked by (create/claim one first, then ` +
          `cite it; a free-prose intention does not survive the session).`,
      );
    }
    if (!remediation && disregard.length < 10) {
      throw new ObservationEvidenceError(
        `observation.ratings['${criterion}'].disregard ('${entry.disregard}') is too thin — an explicit ` +
          `disregard is an owned decision and needs a real reason (≥10 chars).`,
      );
    }
  }
}

/** The minimal rubric shape needed to canonicalize scorecard rating values. */
export interface ScorecardRatingRubric {
  ratingScale?: readonly string[];
  criteria: readonly { key: string; ratingScale?: readonly string[] }[];
}

/**
 * Resolve a case-insensitive caller rating to the rubric's EXACT canonical spelling.
 * `unknown` is universal; when the rubric omits it we still canonicalize it to the
 * shared lower-case spelling. A short label is also accepted when it is the
 * unambiguous leading label of exactly one scale entry (the text before an em dash
 * or colon). Unknown/off-scale/ambiguous values are returned unchanged so the
 * existing validation gate can reject them with its teaching error.
 */
export function canonicalScorecardRating(rating: string, scale: readonly string[] | null | undefined): string {
  const trimmed = String(rating).trim();
  const candidates = (scale ?? []).filter((candidate) => typeof candidate === 'string' && candidate.trim());
  const normalized = trimmed.toLowerCase();
  const match = candidates.find((candidate) => candidate.trim().toLowerCase() === normalized);
  if (match) return match;
  if (normalized === 'unknown') return 'unknown';

  const shortMatches = candidates.filter((candidate) => leadingScaleLabel(candidate) === normalized);
  return shortMatches.length === 1 ? shortMatches[0] : trimmed;
}

/**
 * Canonicalize every rating against its criterion scale (or rubric default). Pure:
 * callers may safely use it at both write and read boundaries, which repairs historic
 * `PASS`/`pass` splits without rewriting the append-only observation ledger.
 */
export function normalizeScorecardRatings(
  ratings: ObservationRatings,
  rubric: ScorecardRatingRubric | null | undefined,
): ObservationRatings {
  if (!rubric) return { ...ratings };
  const rubricScale = rubric.ratingScale ?? [];
  const criterionScales = new Map(rubric.criteria.map((criterion) => [criterion.key, criterion.ratingScale]));
  return Object.fromEntries(
    Object.entries(ratings).map(([criterion, entry]) => [
      criterion,
      {
        ...entry,
        rating: canonicalScorecardRating(entry.rating, criterionScales.get(criterion) ?? rubricScale),
      },
    ]),
  );
}

/**
 * Read back the server-stamped acceptance-seat succession record without
 * weakening the author boundary. A malformed or partial stamp is omitted, so
 * it can never turn an unrelated scorecard into an author verdict.
 */
function asAcceptanceSeatSuccession(v: unknown): AcceptanceSeatSuccession | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const seat = v as Record<string, unknown>;
  if (
    typeof seat.succeededFrom !== 'string' ||
    !seat.succeededFrom.trim() ||
    typeof seat.authorSessionState !== 'string' ||
    !seat.authorSessionState.trim() ||
    typeof seat.basisWorkItemId !== 'string' ||
    !seat.basisWorkItemId.trim() ||
    typeof seat.basisPlanSlug !== 'string' ||
    !seat.basisPlanSlug.trim() ||
    typeof seat.succeededAt !== 'string' ||
    !seat.succeededAt.trim() ||
    !Number.isFinite(Date.parse(seat.succeededAt))
  ) {
    return undefined;
  }
  return {
    succeededFrom: seat.succeededFrom,
    authorSessionState: seat.authorSessionState,
    basisWorkItemId: seat.basisWorkItemId,
    basisPlanSlug: seat.basisPlanSlug,
    succeededAt: seat.succeededAt,
  };
}

/**
 * Narrow an unknown `payload.observation` field to the StructuredObservation
 * shape (a cheap structural check, mirroring read-items' isIdeaLifecycle). Used
 * by the READ side to surface the structured view onto a candidate without a
 * hard dependency on how it was written.
 */
export function asStructuredObservation(v: unknown): StructuredObservation | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: StructuredObservation = {};
  if (typeof o.kind === 'string') out.kind = o.kind as ObservationKind;
  if (typeof o.scope === 'string') out.scope = o.scope as ObservationScope;
  if (typeof o.confidence === 'string') out.confidence = o.confidence as ObservationConfidence;
  if (Array.isArray(o.refs)) out.refs = o.refs.filter((x): x is string => typeof x === 'string');
  if (typeof o.sourceHive === 'string' && o.sourceHive.trim()) out.sourceHive = o.sourceHive;
  if (typeof o.targetHive === 'string' && o.targetHive.trim()) out.targetHive = o.targetHive;
  if (typeof o.rubricRef === 'string' && o.rubricRef.trim()) out.rubricRef = o.rubricRef;
  if (typeof o.rubricRevision === 'number' && Number.isFinite(o.rubricRevision)) {
    out.rubricRevision = o.rubricRevision;
  }
  if (typeof o.rubricMeaningRevision === 'number' && Number.isInteger(o.rubricMeaningRevision) && o.rubricMeaningRevision > 0) {
    out.rubricMeaningRevision = o.rubricMeaningRevision;
  }
  if (typeof o.criteriaHash === 'string' && o.criteriaHash.trim()) {
    out.criteriaHash = o.criteriaHash;
  }
  if (o.subjectRubricIdentity && typeof o.subjectRubricIdentity === 'object' && !Array.isArray(o.subjectRubricIdentity)) {
    const identity = o.subjectRubricIdentity as Record<string, unknown>;
    if (typeof identity.rubricRef === 'string' && identity.rubricRef.trim()) {
      out.subjectRubricIdentity = {
        rubricRef: identity.rubricRef,
        ...(typeof identity.revision === 'number' && Number.isFinite(identity.revision) ? { revision: identity.revision } : {}),
        ...(typeof identity.criteriaHash === 'string' && identity.criteriaHash.trim() ? { criteriaHash: identity.criteriaHash } : {}),
        ...(typeof identity.meaningRevision === 'number' && Number.isInteger(identity.meaningRevision) && identity.meaningRevision > 0
          ? { meaningRevision: identity.meaningRevision }
          : {}),
      };
    }
  }
  if (typeof o.testedSha === 'string' && o.testedSha.trim()) {
    out.testedSha = o.testedSha;
  }
  if (o.releaseGateBinding && typeof o.releaseGateBinding === 'object' && !Array.isArray(o.releaseGateBinding)) {
    const binding = o.releaseGateBinding as Record<string, unknown>;
    const failingTests = Array.isArray(binding.failingTests)
      ? binding.failingTests.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      (binding.status === 'bound' || binding.status === 'stale-pass-blocked') &&
      typeof binding.checkedAt === 'string' &&
      binding.checkedAt.trim()
    ) {
      out.releaseGateBinding = {
        status: binding.status,
        reasonCode: typeof binding.reasonCode === 'string' ? binding.reasonCode : null,
        reason: typeof binding.reason === 'string' ? binding.reason : null,
        checkedAt: binding.checkedAt,
        testedSha: typeof binding.testedSha === 'string' ? binding.testedSha : null,
        gateVerdict:
          binding.gateVerdict === 'green' || binding.gateVerdict === 'not-green'
            ? binding.gateVerdict
            : null,
        gateCandidate: typeof binding.gateCandidate === 'string' ? binding.gateCandidate : null,
        lastGreenCommit:
          typeof binding.lastGreenCommit === 'string' ? binding.lastGreenCommit : null,
        stagingHead: typeof binding.stagingHead === 'string' ? binding.stagingHead : null,
        commitsBehindHead:
          typeof binding.commitsBehindHead === 'number' && Number.isFinite(binding.commitsBehindHead)
            ? binding.commitsBehindHead
            : null,
        failingTests,
      };
    }
  }
  if (o.ratings && typeof o.ratings === 'object' && !Array.isArray(o.ratings)) {
    const rawRatings = o.ratings as Record<string, unknown>;
    const ratings: ObservationRatings = {};
    for (const [k, raw] of Object.entries(rawRatings)) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.rating === 'string' && typeof e.evidence === 'string') {
      ratings[k] = {
          rating: e.rating,
          evidence: e.evidence,
          ...(typeof e.evidenceRef === 'string' && e.evidenceRef.trim() ? { evidenceRef: e.evidenceRef } : {}),
          ...(typeof e.evidenceKind === 'string' && e.evidenceKind.trim() ? { evidenceKind: e.evidenceKind } : {}),
          ...(typeof e.positiveControlRef === 'string' && e.positiveControlRef.trim()
            ? { positiveControlRef: e.positiveControlRef }
            : {}),
          ...(typeof e.absenceClaim === 'boolean' ? { absenceClaim: e.absenceClaim } : {}),
          ...(OBSERVATION_UNKNOWN_REASONS.includes(e.unknownReason as ObservationUnknownReason)
            ? { unknownReason: e.unknownReason as ObservationUnknownReason }
            : {}),
          ...(OBSERVATION_ATTRIBUTIONS.includes(e.attribution as ObservationAttribution)
            ? { attribution: e.attribution as ObservationAttribution }
            : {}),
          ...(typeof e.nextEvidenceAction === 'string' && e.nextEvidenceAction.trim()
            ? { nextEvidenceAction: e.nextEvidenceAction }
            : {}),
          ...(typeof e.suggestion === 'string' && e.suggestion.trim() ? { suggestion: e.suggestion } : {}),
          ...(typeof e.remediation === 'string' && e.remediation.trim() ? { remediation: e.remediation } : {}),
          ...(typeof e.disregard === 'string' && e.disregard.trim() ? { disregard: e.disregard } : {}),
        };
      }
    }
    // An explicit empty object is a valid COMPLETE rating set for a rubric that
    // intentionally declares zero criteria. Preserve that distinction from a
    // non-empty malformed ratings object, whose entries were all rejected above.
    if (Object.keys(ratings).length > 0 || Object.keys(rawRatings).length === 0) out.ratings = ratings;
  }
  if (o.rollup && typeof o.rollup === 'object' && !Array.isArray(o.rollup)) {
    const r = o.rollup as Record<string, unknown>;
    const verdicts = ['exemplary', 'pass', 'partial', 'fail', 'severe', 'unassessable'] as const;
    const criticalKeys = Array.isArray(r.criticalKeys)
      ? r.criticalKeys.filter((x): x is string => typeof x === 'string')
      : [];
    const criticalFailures = Array.isArray(r.criticalFailures)
      ? r.criticalFailures.filter((x): x is string => typeof x === 'string')
      : [];
    const criticalUnknowns = Array.isArray(r.criticalUnknowns)
      ? r.criticalUnknowns.filter((x): x is string => typeof x === 'string')
      : [];
    const coverage = r.coverage;
    if (
      typeof r.verdict === 'string' &&
      verdicts.includes(r.verdict as (typeof verdicts)[number]) &&
      coverage &&
      typeof coverage === 'object' &&
      typeof (coverage as Record<string, unknown>).rated === 'number' &&
      typeof (coverage as Record<string, unknown>).required === 'number' &&
      typeof (coverage as Record<string, unknown>).sufficient === 'boolean'
    ) {
      out.rollup = {
        verdict: r.verdict as (typeof verdicts)[number],
        criticalKeys,
        criticalFailures,
        criticalUnknowns,
        coverage: {
          rated: (coverage as Record<string, number>).rated,
          required: (coverage as Record<string, number>).required,
          sufficient: (coverage as Record<string, boolean>).sufficient,
        },
      };
    }
  }
  if (o.acceptance && typeof o.acceptance === 'object' && !Array.isArray(o.acceptance)) {
    const a = o.acceptance as Record<string, unknown>;
    // This allowlist is what makes an author verdict DURABLE: a value missing
    // from it is dropped silently, so the card reads back with no acceptance at
    // all rather than with an unrecognized one. 'accept-pending-delivery' must
    // therefore be listed here to be persisted and read back.
    if (
      (a.verdict === 'accept' || a.verdict === 'reject' || a.verdict === 'accept-pending-delivery') &&
      typeof a.reasoning === 'string' &&
      a.reasoning.trim()
    ) {
      const seat = asAcceptanceSeatSuccession(a.seat);
      out.acceptance = { verdict: a.verdict, reasoning: a.reasoning, ...(seat ? { seat } : {}) };
    }
  }
  // EI-21394921596281409: an adequacy card must retain the exact clause/evidence
  // selector and current fingerprints used to classify freshness. This is an
  // explicit allowlist: malformed recipes are dropped rather than projected as
  // an apparently replayable but incomplete attestation.
  if (o.rerunRecipe && typeof o.rerunRecipe === 'object' && !Array.isArray(o.rerunRecipe)) {
    const recipe = o.rerunRecipe as Record<string, unknown>;
    const hasEvaluatorBuild = Object.prototype.hasOwnProperty.call(recipe, 'evaluatorBuild');
    const hasEvaluatorRevision = Object.prototype.hasOwnProperty.call(recipe, 'evaluatorRevision');
    let evaluatorBuild: SpecTestAdequacyEvaluatorBuild | null | undefined;
    if (hasEvaluatorBuild) {
      const rawBuild = recipe.evaluatorBuild;
      if (rawBuild && typeof rawBuild === 'object' && !Array.isArray(rawBuild)) {
        const build = rawBuild as Record<string, unknown>;
        const sha =
          build.sha === null
            ? null
            : typeof build.sha === 'string' && build.sha.trim()
              ? build.sha
              : undefined;
        evaluatorBuild =
          sha !== undefined && typeof build.version === 'string' && build.version.trim()
            ? { sha, version: build.version }
            : null;
      } else {
        evaluatorBuild = null;
      }
    }
    const evaluatorRevision =
      Number.isInteger(recipe.evaluatorRevision) && Number(recipe.evaluatorRevision) > 0
        ? Number(recipe.evaluatorRevision)
        : hasEvaluatorRevision
          ? null
          : undefined;
    const rawSelection = recipe.selection;
    const rawCurrent = recipe.current;
    const rawDerivation = recipe.derivation;
    const selection =
      rawSelection && typeof rawSelection === 'object' && !Array.isArray(rawSelection)
        ? (rawSelection as Record<string, unknown>)
        : null;
    const current =
      rawCurrent && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)
        ? (rawCurrent as Record<string, unknown>)
        : null;
    const derivation =
      rawDerivation && typeof rawDerivation === 'object' && !Array.isArray(rawDerivation)
        ? (rawDerivation as Record<string, unknown>)
        : null;
    const rawEvidence = selection?.evidence;
    const evidence = Array.isArray(rawEvidence)
      ? rawEvidence.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const e = entry as Record<string, unknown>;
          return typeof e.evidenceKind === 'string' &&
            e.evidenceKind.trim() &&
            typeof e.evidenceRef === 'string' &&
            e.evidenceRef.trim()
            ? { evidenceKind: e.evidenceKind, evidenceRef: e.evidenceRef }
            : null;
        })
      : null;
    const rawFingerprints = current?.fingerprints;
    const fingerprints = Array.isArray(rawFingerprints)
      ? rawFingerprints.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const e = entry as Record<string, unknown>;
          const hasScopedIdentity = ['planSlug', 'specId', 'specRevision', 'specFingerprint'].some((key) =>
            Object.prototype.hasOwnProperty.call(e, key),
          );
          const planSlug = typeof e.planSlug === 'string' && e.planSlug.trim() ? e.planSlug : undefined;
          const specId = typeof e.specId === 'string' && e.specId.trim() ? e.specId : undefined;
          const specRevision = Number.isInteger(e.specRevision) && Number(e.specRevision) > 0
            ? Number(e.specRevision)
            : undefined;
          const specFingerprint =
            typeof e.specFingerprint === 'string' && e.specFingerprint.trim() ? e.specFingerprint : undefined;
          const hasCompleteScopedIdentity =
            planSlug !== undefined &&
            specId !== undefined &&
            specRevision !== undefined &&
            specFingerprint !== undefined;
          const nullable = (key: string): string | null | undefined => {
            const value = e[key];
            if (value === null || value === undefined) return null;
            return typeof value === 'string' && value.trim() ? value : undefined;
          };
          const testFingerprint = nullable('testFingerprint');
          const fixtureFingerprint = nullable('fixtureFingerprint');
          const rubricFingerprint = nullable('rubricFingerprint');
          const environmentFingerprint = nullable('environmentFingerprint');
          return typeof e.evidenceKind === 'string' &&
            e.evidenceKind.trim() &&
            typeof e.evidenceRef === 'string' &&
            e.evidenceRef.trim() &&
            typeof e.sourceFingerprint === 'string' &&
            e.sourceFingerprint.trim() &&
            testFingerprint !== undefined &&
            fixtureFingerprint !== undefined &&
            rubricFingerprint !== undefined &&
            environmentFingerprint !== undefined &&
            (!hasScopedIdentity || hasCompleteScopedIdentity)
            ? {
                ...(hasCompleteScopedIdentity
                  ? { planSlug, specId, specRevision, specFingerprint }
                  : {}),
                evidenceKind: e.evidenceKind,
                evidenceRef: e.evidenceRef,
                sourceFingerprint: e.sourceFingerprint,
                testFingerprint,
                fixtureFingerprint,
                rubricFingerprint,
                environmentFingerprint,
              }
            : null;
        })
      : null;
    const rawArgs =
      recipe.args && typeof recipe.args === 'object' && !Array.isArray(recipe.args)
        ? (recipe.args as Record<string, unknown>)
        : null;
    const optionalSelector = (
      value: unknown,
      maxItems: number,
      maxLength: number,
      pattern?: RegExp,
    ): string[] | null | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return null;
      const parsed = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
      return parsed.some((entry) => !entry || entry.length > maxLength || (pattern ? !pattern.test(entry) : false))
        ? null
        : parsed;
    };
    // Optional population selectors are fail-closed: a malformed persisted value
    // drops the recipe instead of silently widening its replay.
    const workItemIds = optionalSelector(rawArgs?.workItemIds, 500, 200);
    const evidenceRefs = optionalSelector(rawArgs?.evidenceRefs, 500, 2000);
    const planItemIds = optionalSelector(rawArgs?.planItemIds, 200, 200, /^P-\d{3,}$/);
    const specRevision =
      rawArgs?.specRevision === undefined
        ? undefined
        : Number.isInteger(rawArgs.specRevision) && Number(rawArgs.specRevision) > 0
          ? Number(rawArgs.specRevision)
          : null;
    const specFingerprint =
      rawArgs?.specFingerprint === undefined
        ? undefined
        : typeof rawArgs.specFingerprint === 'string' && rawArgs.specFingerprint.trim()
          ? rawArgs.specFingerprint
          : null;
    const replaySnapshot =
      rawArgs?.replaySnapshot === undefined ? undefined : rawArgs.replaySnapshot === true ? true : null;
    // Historical cards omitted args.harness even though the scorecard itself
    // carries sourceHive. Prefer an explicitly recorded evaluator arg, then use
    // sourceHive as the lossless fallback needed to replay those cards.
    const recipeHarness =
      typeof rawArgs?.harness === 'string' && rawArgs.harness.trim()
        ? rawArgs.harness
        : out.sourceHive;
    if (
      recipe.schemaVersion === 1 &&
      recipe.evaluator === 'plans:evaluate-spec-test-adequacy' &&
      (!hasEvaluatorBuild || evaluatorBuild !== null) &&
      (!hasEvaluatorRevision || evaluatorRevision !== null) &&
      // A recipe that does not record classRef is NOT re-runnable: the evaluator
      // requires it, and a re-runner guessing among four values silently moves
      // plan-class-risk-floor. Legacy rows that predate this field therefore fail
      // this predicate and surface no rerunRecipe at all, rather than a submittable-
      // looking one that its own evaluator rejects.
      typeof recipe.classRef === 'string' &&
      (recipe.classRef as string).trim() &&
      selection &&
      typeof selection.planSlug === 'string' &&
      selection.planSlug.trim() &&
      typeof selection.specId === 'string' &&
      selection.specId.trim() &&
      Number.isInteger(selection.specRevision) &&
      Number(selection.specRevision) > 0 &&
      typeof selection.specFingerprint === 'string' &&
      selection.specFingerprint.trim() &&
      evidence !== null &&
      evidence.every((entry): entry is { evidenceKind: string; evidenceRef: string } => entry !== null) &&
      current &&
      typeof current.supplied === 'boolean' &&
      fingerprints !== null &&
      fingerprints.every((entry): entry is SpecTestAdequacyCurrentFingerprint => entry !== null) &&
      workItemIds !== null &&
      evidenceRefs !== null &&
      planItemIds !== null &&
      specRevision !== null &&
      specFingerprint !== null &&
      replaySnapshot !== null &&
      (replaySnapshot !== true || (specRevision !== undefined && specFingerprint !== undefined)) &&
      derivation?.kind === 'listSpecEvidence.currentness' &&
      derivation.classifier === 'classifySpecEvidenceCurrentness' &&
      derivation.unknownWhenMissing === true
    ) {
      out.rerunRecipe = {
        schemaVersion: 1,
        evaluator: 'plans:evaluate-spec-test-adequacy',
        ...(evaluatorBuild ? { evaluatorBuild } : {}),
        ...(typeof evaluatorRevision === 'number' ? { evaluatorRevision } : {}),
        classRef: recipe.classRef as string,
        // Reconstruct from the validated selection AND currentness inputs, never
        // from stored args, so readback preserves the original evidence cohort.
        args: {
          ...(recipeHarness ? { harness: recipeHarness } : {}),
          slug: selection.planSlug,
          classRef: recipe.classRef as string,
          ...(evaluatorBuild ? { evaluatorBuild } : {}),
          specIds: [selection.specId],
          ...(workItemIds ? { workItemIds } : {}),
          ...(evidenceRefs ? { evidenceRefs } : {}),
          ...(planItemIds ? { planItemIds } : {}),
          ...(specRevision !== undefined ? { specRevision } : {}),
          ...(specFingerprint !== undefined ? { specFingerprint } : {}),
          ...(replaySnapshot === true ? { replaySnapshot: true as const } : {}),
          includeDraft: true,
          ...(current.supplied ? { current: fingerprints } : {}),
        },
        selection: {
          planSlug: selection.planSlug,
          specId: selection.specId,
          specRevision: Number(selection.specRevision),
          specFingerprint: selection.specFingerprint,
          evidence,
        },
        current: { supplied: current.supplied, fingerprints },
        derivation: {
          kind: 'listSpecEvidence.currentness',
          classifier: 'classifySpecEvidenceCurrentness',
          unknownWhenMissing: true,
        },
      };
    }
  }
  if (typeof o.evidenceFingerprint === 'string' && o.evidenceFingerprint.trim()) {
    out.evidenceFingerprint = o.evidenceFingerprint;
  }
  if (typeof o.supersedes === 'string' && o.supersedes.trim()) {
    out.supersedes = o.supersedes;
  }
  if (o.retracted && typeof o.retracted === 'object' && !Array.isArray(o.retracted)) {
    const r = o.retracted as Record<string, unknown>;
    if (
      typeof r.at === 'string' &&
      r.at.trim() &&
      typeof r.by === 'string' &&
      r.by.trim() &&
      typeof r.reason === 'string' &&
      r.reason.trim()
    ) {
      out.retracted = { at: r.at, by: r.by, reason: r.reason };
    }
  }
  if (o.instrumentSnapshots && typeof o.instrumentSnapshots === 'object' && !Array.isArray(o.instrumentSnapshots)) {
    out.instrumentSnapshots = o.instrumentSnapshots as Record<string, unknown>;
  }
  // P-008: the provisional stamp. violatableKeys is load-bearing (an empty stamp says
  // nothing was provisional), so a malformed block is discarded rather than half-kept.
  if (o.provisional && typeof o.provisional === 'object' && !Array.isArray(o.provisional)) {
    const p = o.provisional as Record<string, unknown>;
    const keys = Array.isArray(p.violatableKeys)
      ? p.violatableKeys.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    if (keys.length > 0 && typeof p.stampedAt === 'string' && p.stampedAt.trim()) {
      out.provisional = { violatableKeys: keys, stampedAt: p.stampedAt };
    }
  }
  // P-013: the grade-the-grader audit stamp. state + metaRubricRef + stampedAt are
  // load-bearing (a stamp that cannot say WHAT state or AGAINST WHICH meta-rubric is
  // meaningless), so a malformed block is discarded rather than half-kept — same
  // discipline as `provisional` above.
  if (o.gradingAudit && typeof o.gradingAudit === 'object' && !Array.isArray(o.gradingAudit)) {
    const g = o.gradingAudit as Record<string, unknown>;
    if (
      (g.state === 'pending' || g.state === 'passed' || g.state === 'failed' || g.state === 'cancelled') &&
      typeof g.metaRubricRef === 'string' &&
      g.metaRubricRef.trim() &&
      typeof g.stampedAt === 'string' &&
      g.stampedAt.trim()
    ) {
      const dispatchReservation =
        g.dispatchReservation && typeof g.dispatchReservation === 'object' && !Array.isArray(g.dispatchReservation)
          ? (g.dispatchReservation as Record<string, unknown>)
          : undefined;
      const reservationKey = typeof dispatchReservation?.key === 'string' ? dispatchReservation.key : undefined;
      const reservationTimestamp =
        typeof dispatchReservation?.reservedAt === 'string' ? dispatchReservation.reservedAt : undefined;
      out.gradingAudit = {
        state: g.state,
        metaRubricRef: g.metaRubricRef,
        stampedAt: g.stampedAt,
        ...(typeof g.rubricRevision === 'number' && Number.isFinite(g.rubricRevision)
          ? { rubricRevision: g.rubricRevision }
          : {}),
        ...(typeof g.criteriaHash === 'string' && g.criteriaHash.trim()
          ? { criteriaHash: g.criteriaHash }
          : {}),
        ...(reservationKey &&
        reservationKey.trim() &&
        reservationTimestamp &&
        reservationTimestamp.trim()
          ? {
              dispatchReservation: {
                key: reservationKey,
                reservedAt: reservationTimestamp,
              },
            }
          : {}),
        ...(typeof g.auditIssueId === 'string' && g.auditIssueId.trim() ? { auditIssueId: g.auditIssueId } : {}),
        ...(typeof g.auditor === 'string' && g.auditor.trim() ? { auditor: g.auditor } : {}),
        ...(typeof g.auditedAt === 'string' && g.auditedAt.trim() ? { auditedAt: g.auditedAt } : {}),
      };
    }
  }
  // P-009: the graded subject. This parse is an explicit ALLOWLIST — a key absent
  // here is silently dropped on READ even though it persisted fine on write, so
  // the field is invisible to every reader that goes through this narrowing
  // (listScorecards included). `ref` is load-bearing: a subject block without it
  // cannot say what it graded, so it is discarded rather than half-kept.
  if (o.subject && typeof o.subject === 'object' && !Array.isArray(o.subject)) {
    const s = o.subject as Record<string, unknown>;
    if (typeof s.ref === 'string' && s.ref.trim()) {
      out.subject = {
        ref: s.ref,
        ...(typeof s.kind === 'string' && s.kind.trim() ? { kind: s.kind as ObservationSubjectKind } : {}),
        ...(typeof s.windowStart === 'string' && s.windowStart.trim() ? { windowStart: s.windowStart } : {}),
        ...(typeof s.windowEnd === 'string' && s.windowEnd.trim() ? { windowEnd: s.windowEnd } : {}),
      };
    }
  }
  // P-004 (consult-min-max-and-rubric-vetting-2026-08-17): the vetting stamp.
  // Exactly ONE critique-channel link is load-bearing: `consultId` for a routed
  // consult, or `workItemId` for a launched reviewer's durable comments (WI-41477).
  // A block with neither or both is ambiguous/unlinked, so discard it rather than
  // half-keeping an attestation the acceptance gate must not trust.
  if (o.vetting && typeof o.vetting === 'object' && !Array.isArray(o.vetting)) {
    const vet = o.vetting as Record<string, unknown>;
    const consultId = typeof vet.consultId === 'string' && vet.consultId.trim() ? vet.consultId.trim() : null;
    const workItemId = typeof vet.workItemId === 'string' && vet.workItemId.trim() ? vet.workItemId.trim() : null;
    if (Boolean(consultId) !== Boolean(workItemId)) {
      const seat = asAcceptanceSeatSuccession(vet.seat);
      const critics = Array.isArray(vet.critics)
        ? vet.critics.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      const unansweredReason =
        consultId && typeof vet.unansweredReason === 'string' && vet.unansweredReason.trim()
          ? vet.unansweredReason.trim()
          : null;
      out.vetting = {
        ...(consultId ? { consultId } : { workItemId: workItemId! }),
        ...(seat ? { seat } : {}),
        ...(typeof vet.rubricRevision === 'number' && Number.isFinite(vet.rubricRevision)
          ? { rubricRevision: vet.rubricRevision }
          : {}),
        ...(typeof vet.rubricMeaningRevision === 'number' &&
        Number.isInteger(vet.rubricMeaningRevision) &&
        vet.rubricMeaningRevision > 0
          ? { rubricMeaningRevision: vet.rubricMeaningRevision }
          : {}),
        ...(typeof vet.criteriaHash === 'string' && vet.criteriaHash.trim() ? { criteriaHash: vet.criteriaHash } : {}),
        ...(typeof vet.critiquePosts === 'number' && Number.isInteger(vet.critiquePosts) && vet.critiquePosts >= 0
          ? { critiquePosts: vet.critiquePosts }
          : {}),
        ...(critics.length > 0 ? { critics } : {}),
        // Only the consult channel admits the explicit unanswered waiver, and its
        // reason is required. A malformed partial waiver stays invisible instead of
        // accidentally weakening the non-vacuity gate on read.
        ...(consultId && vet.unanswered === true && unansweredReason
          ? { unanswered: true as const, unansweredReason }
          : {}),
      };
    }
  }
  // P-011 (D-006): the deterministic check-run stamps. This parse is the same explicit
  // ALLOWLIST as `subject` above — a key absent here is silently dropped on READ even
  // though it persisted fine on write. verdict + files are load-bearing (a run record
  // that cannot say what it judged or how it came out detects nothing), so a malformed
  // entry is discarded rather than half-kept.
  if (o.checkRuns && typeof o.checkRuns === 'object' && !Array.isArray(o.checkRuns)) {
    const runs: Record<string, ScorecardCheckRun> = {};
    for (const [key, raw] of Object.entries(o.checkRuns as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const files = Array.isArray(r.files)
        ? r.files.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      if (
        r.kind === 'probe' &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        (r.status === 'fresh' || r.status === 'stale') &&
        r.executed === true &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        // Historical cards must remain readable even after a projected tool's
        // live contract changes, so the READ path checks only the durable probe
        // shape (not its current registry revision). A malformed shape is
        // discarded rather than silently surfacing as executable evidence.
        const probe = continuityProbeShapeSchema.safeParse(r.probe);
        if (!probe.success) continue;
        // `observed` is intentionally scalar: runContinuityProbeBatch redacts
        // and bounds it before persistence. Drop malformed richer values rather
        // than letting arbitrary payloads ride through the observation reader.
        const observed =
          r.observed === null ||
          typeof r.observed === 'string' ||
          typeof r.observed === 'number' ||
          typeof r.observed === 'boolean'
            ? r.observed
            : undefined;
        const verdictMatchesStatus =
          (r.status === 'fresh' && r.verdict === 'pass') || (r.status === 'stale' && r.verdict === 'fail');
        if (!verdictMatchesStatus) continue;
        runs[key] = {
          kind: 'probe',
          probe: probe.data,
          verdict: r.verdict,
          status: r.status,
          executed: true,
          ...(observed !== undefined ? { observed } : {}),
          measuredAt: r.measuredAt,
        };
      } else if (
        r.kind === 'tests' &&
        files.length > 0 &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        typeof r.passed === 'number' &&
        typeof r.failed === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        const testRunIds = Array.isArray(r.testRunIds)
          ? r.testRunIds.filter((x): x is number => Number.isSafeInteger(x) && x > 0)
          : undefined;
        runs[key] = {
          kind: 'tests',
          files,
          verdict: r.verdict,
          passed: r.passed,
          failed: r.failed,
          runId: typeof r.runId === 'string' && r.runId.trim() ? r.runId : null,
          ...(testRunIds !== undefined ? { testRunIds } : {}),
          measuredAt: r.measuredAt,
          ...(Array.isArray(r.failures)
            ? { failures: r.failures.filter((x): x is string => typeof x === 'string') }
            : {}),
        };
      } else if (
        r.kind === 'cargo' &&
        typeof r.manifestPath === 'string' &&
        r.manifestPath.trim() !== '' &&
        Array.isArray(r.sourceFiles) &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        typeof r.passed === 'number' &&
        typeof r.failed === 'number' &&
        typeof r.ignored === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        const sourceFiles = r.sourceFiles.filter(
          (x): x is string => typeof x === 'string' && x.trim() !== '',
        );
        if (sourceFiles.length === 0) continue;
        runs[key] = {
          kind: 'cargo',
          manifestPath: r.manifestPath,
          sourceFiles,
          ...(typeof r.test === 'string' && r.test.trim() ? { test: r.test } : {}),
          verdict: r.verdict,
          passed: r.passed,
          failed: r.failed,
          ignored: r.ignored,
          runId: typeof r.runId === 'string' && r.runId.trim() ? r.runId : null,
          measuredAt: r.measuredAt,
          ...(Array.isArray(r.failures)
            ? { failures: r.failures.filter((x): x is string => typeof x === 'string') }
            : {}),
        };
      } else if (
        r.kind === 'coverage' &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        (r.floor === 'l1' || r.floor === 'l2' || r.floor === 'l3' || r.floor === 'l4') &&
        typeof r.surfaces === 'number' &&
        typeof r.meets === 'number' &&
        typeof r.belowUnwaived === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        // Load-bearing on READ: verdict + floor + the three counts. Without them the
        // record cannot say what it judged or how it came out, so a malformed entry is
        // discarded rather than half-kept — the same posture as the tests arm above.
        const rawScope = (
          r.scope && typeof r.scope === 'object' && !Array.isArray(r.scope) ? (r.scope as Record<string, unknown>) : {}
        ) as Record<string, unknown>;
        const rawFid = (
          r.fidelity && typeof r.fidelity === 'object' && !Array.isArray(r.fidelity)
            ? (r.fidelity as Record<string, unknown>)
            : {}
        ) as Record<string, unknown>;
        runs[key] = {
          kind: 'coverage',
          scope: {
            ...(typeof rawScope.surfaceKind === 'string' && rawScope.surfaceKind.trim()
              ? { surfaceKind: rawScope.surfaceKind }
              : {}),
            ...(Array.isArray(rawScope.sourceFiles)
              ? {
                  sourceFiles: rawScope.sourceFiles.filter(
                    (x): x is string => typeof x === 'string' && x.trim() !== '',
                  ),
                }
              : {}),
            ...(rawScope.planTouched === true ? { planTouched: true as const } : {}),
          },
          floor: r.floor,
          verdict: r.verdict,
          surfaces: r.surfaces,
          meets: r.meets,
          belowUnwaived: r.belowUnwaived,
          pct: typeof r.pct === 'number' && Number.isFinite(r.pct) ? r.pct : null,
          fidelity: {
            weakest: typeof rawFid.weakest === 'string' && rawFid.weakest.trim() ? rawFid.weakest : null,
            declaredPct:
              typeof rawFid.declaredPct === 'number' && Number.isFinite(rawFid.declaredPct) ? rawFid.declaredPct : null,
          },
          ...(Array.isArray(r.belowSurfaces)
            ? { belowSurfaces: r.belowSurfaces.filter((x): x is string => typeof x === 'string') }
            : {}),
          measuredAt: r.measuredAt,
        };
      } else if (
        r.kind === 'requirements' &&
        (r.verdict === 'pass' || r.verdict === 'fail') &&
        typeof r.mappingsJudged === 'number' &&
        typeof r.checkedTargets === 'number' &&
        typeof r.unrealized === 'number' &&
        typeof r.measuredAt === 'string' &&
        r.measuredAt.trim() !== ''
      ) {
        // Load-bearing on READ: verdict plus the denominator and the failure count.
        // Without them the record cannot say what it judged or how it came out, so a
        // malformed entry is discarded rather than half-kept — the same posture as the
        // two arms above.
        //
        // The REPORTED-not-violation counts default to 0 when absent rather than
        // discarding the record: a card written before those fields existed carries a
        // real verdict, and dropping it would lose the judgement to gain a field nobody
        // wrote. `unrealizedEntries` falls back to `unrealized`, which is exactly right
        // for a single-target mapping and never overstates the entry count.
        runs[key] = {
          kind: 'requirements',
          verdict: r.verdict,
          mappingsJudged: r.mappingsJudged,
          checkedTargets: r.checkedTargets,
          unrealized: r.unrealized,
          unrealizedEntries:
            typeof r.unrealizedEntries === 'number' ? r.unrealizedEntries : r.unrealized,
          exemptMappings: typeof r.exemptMappings === 'number' ? r.exemptMappings : 0,
          droppedTargets: typeof r.droppedTargets === 'number' ? r.droppedTargets : 0,
          droppedTargetsVouchedByStaleAudit:
            typeof r.droppedTargetsVouchedByStaleAudit === 'number' ? r.droppedTargetsVouchedByStaleAudit : 0,
          ...(Array.isArray(r.unrealizedRequirements)
            ? {
                unrealizedRequirements: r.unrealizedRequirements.filter(
                  (x): x is string => typeof x === 'string',
                ),
              }
            : {}),
          measuredAt: r.measuredAt,
        };
      }
    }
    if (Object.keys(runs).length > 0) out.checkRuns = runs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
