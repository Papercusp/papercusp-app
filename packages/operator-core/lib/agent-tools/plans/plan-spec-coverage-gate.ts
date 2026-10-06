/**
 * plan-spec-coverage-gate — the plan-ship spec-coverage aggregate and the
 * proof-freshness refusal
 * (first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-008).
 *
 * The plan acceptance gate already asks four independent questions at ship time: are
 * the items finished, does a code-truth audit still resolve against the tree, does a
 * vetted acceptance rubric exist, and did a non-implementer grade it. None of them
 * reads the plan's first-class spec clauses, so a plan could ship with a clause whose
 * only proof was recorded against a revision that has since been superseded — green
 * evidence for a promise nobody makes any more.
 *
 * This module adds the fifth question as a STRUCTURED AGGREGATE over the plan's
 * CURRENT clauses — coverage, adequacy scorecards, exemptions, and freshness — and
 * turns exactly one of its findings into a refusal:
 *
 *   A clause that HAS evidence, but none of it bound to the clause's CURRENT
 *   revision, is UNPROVEN AT ITS PRESENT MEANING. Shipping refuses until current
 *   proof exists.
 *
 * ⚠ SCOPE, and why it is drawn here (see this plan's D-018).
 *
 * `unproven` — an enforceable clause with NO evidence at all — is REPORTED and never
 * refused. That refusal is a widening of the enforced set, which D-013/D-017 assign to
 * P-013, and turning it on here would refuse plan ships fleet-wide for clauses authored
 * as documentation. The freshness refusal is a different claim: it does not widen WHICH
 * clauses are enforced, it only declines to accept a proof the author has already
 * invalidated by revising the clause. Every clause it reads is in the plan's OWN
 * namespace, so no cross-namespace applicability is enforced here either.
 *
 * ⚠ BOUNDEDNESS. The evidence census is a MEASUREMENT, and the repo rule is that a
 * count computed over a capped fetch must mark boundedness ON THE AGGREGATE, not just
 * on the row list. The census fetch is pinned to {@link SPEC_EVIDENCE_CENSUS_LIMIT}
 * independently of any caller's limit, and a truncated census degrades the whole gate
 * to report-only: a truncated read can miss the very row that proves a clause current,
 * so refusing on one would manufacture a false stale verdict.
 */
import { listScorecards, settledGradingAuditIsCurrent, type ScorecardRow } from '../../scorecards';
import {
  isEnforceableSpecLifecycle,
  listSpecClauses,
  type SpecBehaviorClass,
  type SpecClauseRevision,
} from './spec-clauses-store';
import { listSpecEvidence, type SpecEvidenceKind } from './spec-evidence-store';
import { SPEC_TEST_ADEQUACY_RUBRIC_REF } from './spec-test-adequacy';
import { enforcementEligibility } from './spec-enforcement-eligibility';
import { listPlanStatuses, type PlanStatusReader } from './plan-status-read';

/** Lifecycle states carrying an enforceable promise (D-012), mirrored from the resolver. */
/**
 * The evidence census cap, pinned independently of any caller-supplied limit.
 *
 * `listSpecEvidence` defaults to 200 rows ordered newest-first, which is a fine page
 * size for a reader and a silently wrong denominator for a census: the row that proves
 * a clause current can fall off the end. Pinning it here — and reporting truncation on
 * the aggregate — is what keeps the count a measurement rather than an impression.
 */
export const SPEC_EVIDENCE_CENSUS_LIMIT = 2_000;

/** How many clauses the adequacy leg will read scorecards for before it reports bounded. */
export const ADEQUACY_CENSUS_CLAUSE_LIMIT = 200;

export interface StaleProofClause {
  specId: string;
  planItemId: string;
  /** The clause revision that is currently in force. */
  currentRevision: number;
  /** The superseded revision(s) the existing evidence was bound to. */
  provenRevisions: number[];
}

/**
 * P-013 instrumentation — one behavior class's slice of a plan's coverage.
 *
 * WHY THIS PARTITION AND NOT ANOTHER. A single plan-wide "18 of 20 proven" is the
 * number most likely to be read as reassurance and most likely to be wrong about the
 * thing that matters: the two unproven clauses are not interchangeable with the
 * eighteen proven ones. `authorization`, `concurrency`, `lifecycle` and
 * `migration-data-integrity` are already singled out as high-risk by the adequacy
 * grader (HIGH_RISK_BEHAVIOR_CLASSES in spec-test-adequacy.ts), which raises their
 * required proof floor. Coverage that is 90% overall but 0% on the authorization
 * clauses is a materially different situation from the same 90% spread evenly, and
 * the flat count cannot tell those apart. This partition is what makes the difference
 * legible without a second census.
 *
 * Every field is a strict subset relationship with the flat aggregate: summing any
 * field across all present classes reproduces the corresponding flat total exactly.
 * That is asserted in the tests rather than merely intended — a partition that does
 * not reconcile with the total it partitions is a second, quietly diverging census,
 * which this module's header forbids.
 */
export interface BehaviorClassCoverage {
  /** Every CURRENT clause of this class, whatever its lifecycle status. */
  total: number;
  /** accepted | active — the enforceable promises of this class. */
  enforceable: number;
  /** Enforceable clauses of this class with evidence at the CURRENT revision. */
  proven: number;
  /** Enforceable clauses of this class with evidence, but none current. */
  staleProof: number;
  /** Enforceable clauses of this class with no evidence at all. */
  unproven: number;
  /** D-016: how many of this class's enforceable clauses declare a falsifier. */
  falsifierDeclared: number;
}

/**
 * P-013 instrumentation — how STALE this plan's proof is, beyond the binary
 * `staleProof` count the gate already refuses on.
 *
 * The count answers "is anything stale". These answer "how badly, and since when",
 * which is what distinguishes a clause revised an hour ago and not yet re-proven
 * (routine, self-correcting) from one whose only proof is eleven revisions and three
 * months behind (a promise whose meaning has drifted away from its evidence). Both
 * render identically as `staleProof: 1` today.
 *
 * ⚠ Ages are read from `observedAt` on the evidence row, NOT from any clock this
 * module keeps. A caller comparing them to "now" must use its own now — these are
 * timestamps, never durations, precisely so a stored value cannot silently age.
 */
export interface SpecCoverageStaleness {
  /**
   * Largest `currentRevision - provenRevision` gap over stale-proof clauses, using each
   * clause's NEWEST proven revision (its best case). 0 when nothing is stale.
   */
  maxRevisionLag: number;
  /**
   * The OLDEST evidence row backing a current-revision proof — the weakest link in what
   * currently reads as proven. null when nothing is proven at its current revision.
   */
  oldestCurrentProofAt: string | null;
  /** The newest evidence row read for this plan at all. null when there is no evidence. */
  newestProofAt: string | null;
}

export interface PlanSpecCoverageAggregate {
  planSlug: string;
  /** Every CURRENT clause, partitioned by the lifecycle role it plays (D-012). */
  clauses: {
    total: number;
    /** accepted | active — the enforceable promises. */
    enforceable: number;
    /** lifecycleStatus 'exempt' — a declared non-behavioral carve-out. */
    exempt: number;
    /** Candidate inputs, never enforceable until promotion (D-012). */
    draft: number;
    /** superseded | retired. */
    inactive: number;
    /** D-016: how many enforceable clauses declare what would falsify them. */
    falsifierDeclared: number;
  };
  coverage: {
    /** Enforceable clauses with at least one evidence row at the CURRENT revision. */
    proven: number;
    /** Enforceable clauses with evidence, but NONE at the current revision. Blocks. */
    staleProof: number;
    /** Enforceable clauses with no evidence at all. Reported, never refused here. */
    unproven: number;
    staleProofClauses: StaleProofClause[];
    unprovenSpecIds: string[];
  };
  adequacy: {
    /** Enforceable clauses carrying a complete adequacy scorecard at the current revision. */
    graded: number;
    ungraded: number;
    ungradedSpecIds: string[];
  };
  /**
   * P-013 — the same coverage, partitioned by behavior class.
   *
   * A class with ZERO clauses on this plan is ABSENT, not zero-filled. That is
   * deliberate and is the honest encoding: nine zero-filled rows on every plan would
   * make "this plan declares nothing about authorization" look identical to "this
   * plan's authorization clauses are all accounted for and there happen to be none" —
   * and the first of those is the silent waiver this whole module exists to surface.
   * Absence here means the plan never spoke to that class; read it as a gap to
   * investigate, never as coverage.
   */
  byBehaviorClass: Partial<Record<SpecBehaviorClass, BehaviorClassCoverage>>;
  /**
   * P-013 — evidence LEVEL: what KIND of proof is actually backing this plan.
   *
   * `proven` counts clauses, not proof strength, so eight clauses proven by a `manual`
   * attestation and eight proven by `mutation` evidence produce the identical number.
   * They are not the identical claim. This block reports the composition so the
   * difference is visible without inventing a strength ordering — deliberately NOT
   * collapsed into a single "level" score, because any such ranking would be a
   * curated judgement dressed as a derived measure, and readers would then compare
   * scores across plans as though the ranking were a fact.
   */
  evidence: {
    /** Evidence rows read for this plan, by kind. Absent kind ⇒ zero rows of it. */
    byKind: Partial<Record<SpecEvidenceKind, number>>;
    /** The subset of `byKind` bound to a clause's CURRENT revision — the proof that still counts. */
    currentByKind: Partial<Record<SpecEvidenceKind, number>>;
    /** How stale the proof is, beyond the binary count the gate refuses on. */
    staleness: SpecCoverageStaleness;
  };
  /**
   * Boundedness of the measurement itself, carried ON the aggregate so a floor can
   * never be read as a total.
   */
  bounded: {
    evidenceCensusLimit: number;
    evidenceRowsRead: number;
    /** True ⇒ every count above is a FLOOR, and the gate must not refuse on it. */
    truncatedByLimit: boolean;
    adequacyClauseLimit: number;
    adequacyTruncatedByLimit: boolean;
  };
}

export type PlanSpecCoverageGateCode =
  | 'spec_proof_stale'
  /** P-013: an enforceable clause with NO evidence at any revision — an unproven promise. */
  | 'spec_clause_unproven'
  | 'spec_coverage_unavailable';

export interface PlanSpecCoverageGateVerdict {
  satisfied: boolean;
  /** False ⇒ the plan has adopted no first-class clauses, so the gate has nothing to say. */
  applicable: boolean;
  mode: 'report-only' | 'enforced';
  planSlug: string;
  aggregate: PlanSpecCoverageAggregate | null;
  code?: PlanSpecCoverageGateCode;
  message?: string;
  /** Conditions that DID refuse (enforced) or WOULD refuse were the gate enforcing. */
  wouldBlock: string[];
  /** Findings this gate deliberately reports without refusing (see the scope note). */
  reports: string[];
}

/**
 * The census's view of the evidence reader — deliberately narrower than
 * `listSpecEvidence`'s full row.
 *
 * A census asks one question of each row: which clause revision does this prove? Typing
 * the dep to exactly that keeps the contract honest (a reader can see the census cannot
 * silently start depending on fingerprints or details) and keeps the real
 * `listSpecEvidence` assignable to it unchanged.
 */
export type SpecEvidenceCensusReader = (options: {
  harnessSlug?: string;
  /**
   * An array to stay assignable to `listSpecEvidence`, which widened to `planSlugs` in
   * P-013 so the work-item gate could scope evidence to every namespace it enforces. A
   * plan census still passes exactly one slug — the narrowing is in the CALL, not the
   * type, so the real reader remains substitutable here without a wrapper.
   */
  planSlugs: string[];
  limit?: number;
}) => Promise<ReadonlyArray<SpecEvidenceCensusRow>>;

/**
 * The evidence fields this census actually reads.
 *
 * ⚠ WIDENED IN P-013, AND THE WIDENING IS THE GUARD. This used to declare only
 * `{ specId, specRevision }` — enough for the proven/stale/unproven counts. The
 * instrumentation partitions need the KIND of each proof and WHEN it was observed, and
 * both are already on every row the real reader returns (NOT NULL columns), so nothing
 * new is queried.
 *
 * Declaring them here rather than reaching for them off a loosely-typed row is what
 * makes the test fixtures supply them. A stub returning the old two-field shape would
 * otherwise leave `evidenceKind` undefined at runtime and silently accumulate the
 * composition under an `undefined` key — a partition that looks populated, reconciles
 * against nothing, and is invisible to a typecheck. Same failure family as an
 * unstubbed enforcement dep: the shape compiles, and the measurement is vacuous.
 */
export interface SpecEvidenceCensusRow {
  specId: string;
  specRevision: number;
  evidenceKind: SpecEvidenceKind;
  /** ISO-8601. The real reader always sets it; declared non-null so a fixture must too. */
  observedAt: string;
}

export interface PlanSpecCoverageDeps {
  listClauses?: typeof listSpecClauses;
  listEvidence?: SpecEvidenceCensusReader;
  listCards?: typeof listScorecards;
  /**
   * P-013: reads the plan's own status so the gate can decide whether its clauses may
   * refuse at all. The SAME reader the work-item contract resolver uses — see
   * `plan-status-read.ts` for why this is shared rather than re-queried here.
   */
  readPlanStatuses?: PlanStatusReader;
}

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

/**
 * A usable adequacy grading for the clause revision named by `subjectRef`.
 *
 * Deliberately does NOT compare an evidence fingerprint the way the work-item adequacy
 * gate does: that gate holds one exact evaluation to compare against, and this one is
 * taking a census. The revision-pinned subject ref is what makes the count honest —
 * a clause revision changes the ref, so an old card cannot satisfy a new revision.
 */
function usableAdequacyCard(card: ScorecardRow, subjectRef: string): boolean {
  return (
    card.rubricRef === SPEC_TEST_ADEQUACY_RUBRIC_REF &&
    card.subject?.kind === 'plan' &&
    card.subject.ref === subjectRef &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    !card.synthesized &&
    !card.retracted &&
    !card.supersededBy &&
    card.provisional === undefined &&
    settledGradingAuditIsCurrent(card) &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

/** Newest adequacy cards consulted per subject — the window the per-clause read always used. */
const ADEQUACY_CARDS_PER_SUBJECT = 20;
/** listScorecards' own row cap; a batch that fills it may have dropped older cards. */
const ADEQUACY_BATCH_CARD_LIMIT = 500;

/**
 * Every clause's adequacy cards in ONE read, grouped by subject.
 *
 * One read per clause made the gate scan the rubric's whole card population once
 * per clause, in parallel (measured 2026-10-01: ~103ms and ~21k buffers each, 39
 * at once for one plan). That pushed the GOAL portfolio read, which runs this gate
 * for any plan that claims to be finished, past the obligation reader's 900ms budget.
 * The batch keeps the per-subject window (newest {@link ADEQUACY_CARDS_PER_SUBJECT},
 * newest-first) by grouping. A batch that fills its cap may have dropped older cards
 * of some subject, so it falls back to the per-subject reads instead of
 * guessing.
 */
async function readAdequacyCardsBySubject(
  listCards: typeof listScorecards,
  subjectRefs: readonly string[],
): Promise<Map<string, ScorecardRow[]>> {
  const bySubject = new Map<string, ScorecardRow[]>();
  if (subjectRefs.length === 0) return bySubject;
  const batch = await listCards({
    rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
    subjectRefs,
    limit: ADEQUACY_BATCH_CARD_LIMIT,
  });
  if (batch.length < ADEQUACY_BATCH_CARD_LIMIT) {
    for (const card of batch) {
      const ref = card.subject?.ref;
      if (!ref) continue;
      const cards = bySubject.get(ref) ?? [];
      if (cards.length < ADEQUACY_CARDS_PER_SUBJECT) cards.push(card);
      bySubject.set(ref, cards);
    }
    return bySubject;
  }
  await Promise.all(
    subjectRefs.map(async (subjectRef) => {
      bySubject.set(
        subjectRef,
        await listCards({ rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF, subjectRef, limit: ADEQUACY_CARDS_PER_SUBJECT }),
      );
    }),
  );
  return bySubject;
}

/** The revision-pinned adequacy subject ref, mirroring spec-test-adequacy's own. */
function adequacySubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

/**
 * Census the plan's current clauses against the evidence bound to them.
 *
 * Reads only the plan's OWN namespace — this is a plan-ship aggregate, not the
 * cross-namespace behavior contract that `resolveWorkItemBehaviorContract` resolves
 * for a work item.
 */
export async function computePlanSpecCoverage(
  input: { harnessSlug?: string; planSlug: string },
  deps: PlanSpecCoverageDeps = {},
): Promise<PlanSpecCoverageAggregate> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;

  const clauses = await listClauses({ harnessSlug: input.harnessSlug, planSlug: input.planSlug });
  const enforceable = clauses.filter((clause) => isEnforceableSpecLifecycle(clause.lifecycleStatus));

  // Genuinely single-plan: this is a census of ONE plan's own coverage, unlike the
  // work-item completion gate, whose contract spans namespaces.
  const evidence = await listEvidence({
    harnessSlug: input.harnessSlug,
    planSlugs: [input.planSlug],
    limit: SPEC_EVIDENCE_CENSUS_LIMIT,
  });
  const truncatedByLimit = evidence.length >= SPEC_EVIDENCE_CENSUS_LIMIT;

  // Fold the evidence into per-clause revision sets ONCE; a per-clause filter over the
  // whole array would be quadratic on plans with many clauses.
  const revisionsBySpecId = new Map<string, Set<number>>();
  for (const row of evidence) {
    const set = revisionsBySpecId.get(row.specId);
    if (set) set.add(row.specRevision);
    else revisionsBySpecId.set(row.specId, new Set([row.specRevision]));
  }

  const staleProofClauses: StaleProofClause[] = [];
  const unprovenSpecIds: string[] = [];
  let proven = 0;
  // P-013 instrumentation. Accumulated in the SAME pass as the flat counts above,
  // deliberately: a partition computed by a second walk (or a second query) is a
  // second census, and two censuses of one population drift precisely when they
  // disagree about something that matters. Sharing the loop makes the partition
  // reconcile with the total by construction rather than by assertion.
  const byBehaviorClass: Partial<Record<SpecBehaviorClass, BehaviorClassCoverage>> = {};
  const classSlot = (behaviorClass: SpecBehaviorClass): BehaviorClassCoverage => {
    const existing = byBehaviorClass[behaviorClass];
    if (existing) return existing;
    const fresh: BehaviorClassCoverage = {
      total: 0,
      enforceable: 0,
      proven: 0,
      staleProof: 0,
      unproven: 0,
      falsifierDeclared: 0,
    };
    byBehaviorClass[behaviorClass] = fresh;
    return fresh;
  };
  // `total` spans EVERY current clause, not just the enforceable ones, so a class whose
  // clauses are all draft or exempt still appears — with enforceable 0. That is the
  // reading the flat `clauses.total` already takes, and the partition must match it.
  for (const clause of clauses) classSlot(clause.behaviorClass).total += 1;

  for (const clause of enforceable) {
    const slot = classSlot(clause.behaviorClass);
    slot.enforceable += 1;
    if (clause.falsifier != null) slot.falsifierDeclared += 1;

    const revisions = revisionsBySpecId.get(clause.specId);
    if (!revisions || revisions.size === 0) {
      unprovenSpecIds.push(clause.specId);
      slot.unproven += 1;
      continue;
    }
    if (revisions.has(clause.revision)) {
      proven += 1;
      slot.proven += 1;
      continue;
    }
    slot.staleProof += 1;
    staleProofClauses.push({
      specId: clause.specId,
      planItemId: clause.planItemId,
      currentRevision: clause.revision,
      provenRevisions: [...revisions].sort((a, b) => a - b),
    });
  }

  // P-013 — evidence composition and staleness, derived from the rows the census has
  // ALREADY read. No extra query: the cost of this instrumentation is one pass over an
  // array that is in memory either way.
  const evidenceByKind: Partial<Record<SpecEvidenceKind, number>> = {};
  const evidenceCurrentByKind: Partial<Record<SpecEvidenceKind, number>> = {};
  const currentRevisionBySpecId = new Map(enforceable.map((c) => [c.specId, c.revision]));
  let oldestCurrentProofAt: string | null = null;
  let newestProofAt: string | null = null;
  for (const row of evidence) {
    const kind = row.evidenceKind as SpecEvidenceKind;
    evidenceByKind[kind] = (evidenceByKind[kind] ?? 0) + 1;
    if (row.observedAt && (newestProofAt === null || row.observedAt > newestProofAt)) {
      newestProofAt = row.observedAt;
    }
    // "Current" is judged against the clause's revision as THIS census read it, never
    // against the row's own `currentRevision` column: the two can disagree mid-write,
    // and the clause read is the one every other count in this aggregate is built on.
    if (currentRevisionBySpecId.get(row.specId) !== row.specRevision) continue;
    evidenceCurrentByKind[kind] = (evidenceCurrentByKind[kind] ?? 0) + 1;
    if (row.observedAt && (oldestCurrentProofAt === null || row.observedAt < oldestCurrentProofAt)) {
      oldestCurrentProofAt = row.observedAt;
    }
  }

  // Lag uses each stale clause's BEST (newest) proven revision — its most favourable
  // reading. A max over the worst case would inflate every gap by however many old
  // revisions happen to still be on file, which measures record-keeping, not staleness.
  const maxRevisionLag = staleProofClauses.reduce((worst, clause) => {
    const best = clause.provenRevisions[clause.provenRevisions.length - 1] ?? 0;
    return Math.max(worst, clause.currentRevision - best);
  }, 0);

  // The adequacy leg is a per-subject read, like every other adequacy consumer. Bounded
  // by clause count so a pathological plan cannot turn one gate into hundreds of reads.
  const adequacyScope = enforceable.slice(0, ADEQUACY_CENSUS_CLAUSE_LIMIT);
  const adequacyTruncatedByLimit = enforceable.length > ADEQUACY_CENSUS_CLAUSE_LIMIT;
  const ungradedSpecIds: string[] = [];
  let graded = 0;
  const subjectRefBySpecId = new Map(
    adequacyScope.map((clause) => [clause.specId, adequacySubjectRef(clause.planSlug, clause.specId, clause.revision)]),
  );
  const cardsBySubject = await readAdequacyCardsBySubject(listCards, [...new Set(subjectRefBySpecId.values())]);
  for (const clause of adequacyScope) {
    const subjectRef = subjectRefBySpecId.get(clause.specId) ?? '';
    if ((cardsBySubject.get(subjectRef) ?? []).some((card) => usableAdequacyCard(card, subjectRef))) graded += 1;
    else ungradedSpecIds.push(clause.specId);
  }

  return {
    planSlug: input.planSlug,
    clauses: {
      total: clauses.length,
      enforceable: enforceable.length,
      exempt: clauses.filter((c) => c.lifecycleStatus === 'exempt').length,
      draft: clauses.filter((c) => c.lifecycleStatus === 'draft').length,
      inactive: clauses.filter((c) => c.lifecycleStatus === 'superseded' || c.lifecycleStatus === 'retired').length,
      falsifierDeclared: enforceable.filter((c) => c.falsifier != null).length,
    },
    coverage: {
      proven,
      staleProof: staleProofClauses.length,
      unproven: unprovenSpecIds.length,
      staleProofClauses: staleProofClauses.sort((a, b) => a.specId.localeCompare(b.specId)),
      unprovenSpecIds: unprovenSpecIds.sort(),
    },
    adequacy: {
      graded,
      ungraded: ungradedSpecIds.length,
      ungradedSpecIds: ungradedSpecIds.sort(),
    },
    byBehaviorClass,
    evidence: {
      byKind: evidenceByKind,
      currentByKind: evidenceCurrentByKind,
      staleness: { maxRevisionLag, oldestCurrentProofAt, newestProofAt },
    },
    bounded: {
      evidenceCensusLimit: SPEC_EVIDENCE_CENSUS_LIMIT,
      evidenceRowsRead: evidence.length,
      truncatedByLimit,
      adequacyClauseLimit: ADEQUACY_CENSUS_CLAUSE_LIMIT,
      adequacyTruncatedByLimit,
    },
  };
}

/**
 * Evaluate the spec-coverage gate for a plan about to ship.
 *
 * Never throws: a read failure degrades to report-only rather than freezing every ship
 * on an infrastructure blip, matching the acceptance gate's stated posture and the
 * sibling spec-quality gate's clause-read leg. Four independent gates still enforce
 * alongside it, and the degradation is reported rather than silent.
 */
export async function evaluatePlanSpecCoverageGate(
  input: { harnessSlug?: string; planSlug: string },
  deps: PlanSpecCoverageDeps = {},
): Promise<PlanSpecCoverageGateVerdict> {
  let aggregate: PlanSpecCoverageAggregate;
  try {
    aggregate = await computePlanSpecCoverage(input, deps);
  } catch (error) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate: null,
      code: 'spec_coverage_unavailable',
      wouldBlock: [],
      reports: ['spec-coverage-read-unavailable'],
      message:
        `Spec-coverage census could not be read for plan '${input.planSlug}' ` +
        `(${error instanceof Error ? error.message : String(error)}). Reporting the gap rather than ` +
        `freezing the ship: the item, audit, rubric and vetting gates are unaffected.`,
    };
  }

  const reports: string[] = [];
  if (aggregate.coverage.unproven > 0) {
    reports.push(`${aggregate.coverage.unproven}-enforceable-clause(s)-with-no-evidence`);
  }
  if (aggregate.adequacy.ungraded > 0) {
    reports.push(`${aggregate.adequacy.ungraded}-enforceable-clause(s)-without-a-current-adequacy-scorecard`);
  }
  if (aggregate.clauses.enforceable > aggregate.clauses.falsifierDeclared) {
    reports.push(
      `${aggregate.clauses.enforceable - aggregate.clauses.falsifierDeclared}-enforceable-clause(s)-declare-no-falsifier`,
    );
  }

  if (aggregate.clauses.total === 0) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate,
      wouldBlock: [],
      reports: ['no-first-class-spec-clauses'],
      message:
        `Report-only: plan '${input.planSlug}' has adopted no first-class spec clauses, so there is no ` +
        `proof freshness to check. Adopting any clause makes this gate enforcing at ship time.`,
    };
  }

  // A truncated census is a FLOOR, not a total. Refusing on one would manufacture a
  // stale verdict from a row that simply fell off the end of the read.
  if (aggregate.bounded.truncatedByLimit) {
    return {
      satisfied: true,
      applicable: true,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate,
      wouldBlock: [],
      reports: [...reports, 'evidence-census-truncated'],
      message:
        `Report-only: plan '${input.planSlug}' returned ${aggregate.bounded.evidenceRowsRead} evidence rows at the ` +
        `${SPEC_EVIDENCE_CENSUS_LIMIT}-row census cap, so every coverage count is a FLOOR and a stale-proof ` +
        `verdict could not be distinguished from a truncated read. The freshness refusal is withheld rather ` +
        `than guessed.`,
    };
  }

  // ── P-013: is this plan ELIGIBLE to refuse at all? ──────────────────────────────────
  //
  // Read AFTER the two report-only degradations above, deliberately: a truncated census
  // or an unreadable one is report-only regardless of eligibility, so asking first would
  // spend a query on a verdict already decided.
  //
  // Adoption is not re-derived — `clauses.total === 0` returned above, so every plan
  // reaching this line has adopted clauses. What remains is the LANE: a shipped or
  // superseded plan stays non-blocking (D-018), and a draft's clauses are candidates until
  // promotion (D-012). The ship path itself is unaffected — a plan being marked shipped is
  // still `active` when this runs — but the same function backs the admin panel, where
  // rendering a ship blocker on an already-shipped plan would be exactly the fleet-wide
  // refusal the migration semantics exist to prevent.
  //
  // A read failure degrades to NON-enforcing, matching the resolver: refusing because we
  // could not read a plan's status would turn an infrastructure blip into a ship freeze.
  const readPlanStatuses = deps.readPlanStatuses ?? listPlanStatuses;
  const planStatus = await readPlanStatuses({
    ...(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {}),
    planSlugs: [input.planSlug],
  })
    .then((map) => map.get(input.planSlug) ?? null)
    .catch(() => null);
  const eligibility =
    planStatus === null
      ? ({ enforcing: false, reason: 'unreadable-plan-status' } as const)
      : enforcementEligibility({ status: planStatus, clauseCount: aggregate.clauses.total });

  if (aggregate.coverage.staleProof > 0 && eligibility.enforcing) {
    const listed = aggregate.coverage.staleProofClauses
      .slice(0, 5)
      .map((c) => `${c.specId} (proof at r${c.provenRevisions.join('/r')}, clause now r${c.currentRevision})`)
      .join('; ');
    const more =
      aggregate.coverage.staleProofClauses.length > 5
        ? ` (+${aggregate.coverage.staleProofClauses.length - 5} more)`
        : '';
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      aggregate,
      code: 'spec_proof_stale',
      wouldBlock: [`${aggregate.coverage.staleProof}-clause(s)-proven-only-at-a-superseded-revision`],
      reports,
      message:
        `plan '${input.planSlug}' cannot be marked shipped: ${aggregate.coverage.staleProof} spec clause(s) were ` +
        `REVISED after their evidence was recorded, so their only proof is against a promise that no longer ` +
        `applies — ${listed}${more}. Re-prove each at its current revision: run the covering test, then ` +
        `plans:set-spec-evidence { slug:'${input.planSlug}', specId:'<spec>', specRevision:<current>, ... }. ` +
        `A clause whose behavior genuinely did not change still needs the evidence rebound, because the ` +
        `revision is what records that someone re-checked it. To ship anyway, pass force:{ reason } — it is ` +
        `recorded on the plan.`,
    };
  }

  // ── P-013: the `unproven` leg becomes a REFUSAL ─────────────────────────────────────
  //
  // This is the widening D-018 scoped to this item. Until now an enforceable clause with
  // NO evidence at all was reported and shipped anyway — the gate refused a proof bound to
  // a superseded revision (`spec_proof_stale`) while accepting no proof whatsoever, which
  // is the weaker condition passing where the stronger one refuses.
  //
  // It is ordered AFTER the stale-proof leg so the more specific diagnosis wins: a clause
  // whose evidence merely went stale gets told to re-prove it, not that it has none.
  if (aggregate.coverage.unproven > 0 && eligibility.enforcing) {
    const listed = aggregate.coverage.unprovenSpecIds.slice(0, 5).join(', ');
    const more =
      aggregate.coverage.unprovenSpecIds.length > 5
        ? ` (+${aggregate.coverage.unprovenSpecIds.length - 5} more)`
        : '';
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      aggregate,
      code: 'spec_clause_unproven',
      wouldBlock: [`${aggregate.coverage.unproven}-enforceable-clause(s)-with-no-evidence`],
      reports,
      message:
        `plan '${input.planSlug}' cannot be marked shipped: ${aggregate.coverage.unproven} enforceable spec ` +
        `clause(s) have NO evidence bound at any revision — ${listed}${more}. A clause with no evidence is an ` +
        `unproven promise, not a passing one. Run the covering test for each, then bind it with ` +
        `plans:bind-spec-evidence { slug:'${input.planSlug}', specId:'<spec>', specRevision:<current>, ... }. ` +
        `If a clause is genuinely not automatable, declare that on the clause (behaviorClass 'non-automated') ` +
        `rather than shipping it unproven. To ship anyway, pass force:{ reason } — it is recorded on the plan.`,
    };
  }

  // NOT eligible: report what WOULD have refused, and say why it did not.
  //
  // ⚠ `wouldBlock` is populated here even though nothing refuses — that is its documented
  // job ("conditions that DID refuse, or WOULD were the gate enforcing"). Leaving it empty
  // would render an unreconciled plan as indistinguishable from a clean one, which is the
  // silent-exemption this plan exists to remove: a migration lane has to be VISIBLE to be
  // migrated.
  if (!eligibility.enforcing) {
    const wouldBlock: string[] = [];
    if (aggregate.coverage.staleProof > 0) {
      wouldBlock.push(`${aggregate.coverage.staleProof}-clause(s)-proven-only-at-a-superseded-revision`);
    }
    if (aggregate.coverage.unproven > 0) {
      wouldBlock.push(`${aggregate.coverage.unproven}-enforceable-clause(s)-with-no-evidence`);
    }
    return {
      satisfied: true,
      applicable: true,
      mode: 'report-only',
      planSlug: input.planSlug,
      aggregate,
      wouldBlock,
      reports: [...reports, `not-enforcing:${eligibility.reason}`],
      message:
        `Report-only: plan '${input.planSlug}'${planStatus ? ` (status '${planStatus}')` : ''} is not yet ` +
        `subject to spec-coverage enforcement (${eligibility.reason})` +
        (wouldBlock.length
          ? `. It WOULD refuse on: ${wouldBlock.join('; ')}.`
          : `, and nothing would refuse in any case.`),
    };
  }

  return {
    satisfied: true,
    applicable: true,
    mode: 'enforced',
    planSlug: input.planSlug,
    aggregate,
    wouldBlock: [],
    reports,
  };
}
