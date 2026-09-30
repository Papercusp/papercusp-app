import {
  computePlanSpecCoverage,
  type BehaviorClassCoverage,
  type PlanSpecCoverageAggregate,
  type PlanSpecCoverageDeps,
} from './plan-spec-coverage-gate';
import type { SpecBehaviorClass } from './spec-clauses-store';
import type { SpecEvidenceKind } from './spec-evidence-store';
import {
  enforcementEligibility,
  type AdoptionState,
  type EnforcementEligibility,
  type PlanAdoptionRow,
  type ReconciliationLane,
} from './spec-enforcement-eligibility';

/**
 * P-012 — the spec reconciliation ledger.
 *
 * P-013 will make an uncovered clause REFUSE a ship. This module is the report that has
 * to exist first, and its whole job is to answer one question honestly: *what would
 * enforcement actually be enforcing over?*
 *
 * THE MEASUREMENT THAT SHAPED THIS MODULE. Live census of the papercusp workspace at
 * 2026-08-24: 1,306 plans, of which exactly ONE has adopted first-class spec clauses, and
 * it carries TWO of them. Four other plans still mention VAL-* / coversVALs in their text
 * and have ZERO clauses. That is the entire corpus.
 *
 * So the danger here is the exact inverse of the one you would expect. There is no large
 * migration backlog to grind through. The danger is that enforcement reads GREEN across
 * ~1,287 plans — not because they are compliant, but because they never declared a
 * behavior for anything to be uncovered. A gate that refuses on "uncovered clause" is
 * trivially satisfied by a plan with no clauses, and that is a SILENT WAIVER at plan
 * scale: the strongest-looking possible result produced by the weakest possible input.
 *
 * The ledger therefore refuses to let "no clauses" render as "nothing to do". Every
 * non-historical plan lands in exactly one ADOPTION state, and the two that are not
 * `adopted` are reported as work, never as compliance:
 *
 *   · `adopted`              — has clauses; censused through P-008's gate.
 *   · `legacy-val-only`      — still carries VAL-* / coversVALs text, ZERO clauses. Backfill.
 *   · `no-behavior-declared` — neither. NOT a pass; a plan that promised nothing.
 *
 * WHAT THIS MODULE DOES NOT DO, deliberately:
 *
 *   1. It NEVER writes a second census. `computePlanSpecCoverage` is the aggregate the
 *      ship gate itself enforces (D-018); a parallel count here would drift from the one
 *      that refuses, and the drift would be invisible precisely because both look right.
 *   2. It NEVER invents a falsifier to fill a null (D-016). A null falsifier is an honest,
 *      gradeable gap that the census already COUNTS; synthesizing one manufactures a
 *      promise nobody made and is indistinguishable from a real one afterwards.
 *   3. It NEVER refuses. Report-only, per the P-012 rollout. Shipped/superseded plans are
 *      carried in a `historical` lane so they are visible without ever blocking.
 *
 * BOUNDEDNESS HAS TWO AXES HERE, AND THAT IS THE TRAP. A per-plan census can truncate
 * (evidence pages at a pinned limit), AND the plan population itself can truncate (there
 * are ~570 non-historical plans). Either one makes every roll-up count a FLOOR. They are
 * reported separately for diagnosis but composed into a single `countsAreFloor`, because
 * a caller that checks only one axis gets a floor it believes is a total — which is the
 * defect the whole `bounded` convention exists to prevent.
 */

/**
 * Detects a legacy VAL-* reference in a plan's prose or items.
 *
 * ⚠ THIS PATTERN IS LOAD-BEARING AND ITS OBVIOUS FORM IS WRONG IN BOTH DIRECTIONS.
 *
 * The first cut was `VAL-[0-9]`, which fails asymmetrically and silently:
 *
 *   · TOO NARROW — it requires a DIGIT after the dash, so it misses every plan-scoped id
 *     (`VAL-production-readiness-acceptance-2026-06-10-001`), whose next char is a letter.
 *     Measured 2026-08-24: that hid `universal-schema-2026-05-30` — an ACTIVE plan with
 *     zero clauses that DOES carry plan-scoped VAL text. It rendered as
 *     `no-behavior-declared` ("a plan that promised nothing") instead of as backfill work.
 *     That is precisely the silent waiver this module's header says it exists to prevent,
 *     reintroduced one layer down in the detector itself.
 *
 *   · TOO BROAD — a bare `VAL-` substring also matches inside `EVAL-`, `RETRIEVAL-`, and
 *     any other word ending in VAL, and it matches a bare `VAL-` token written in prose
 *     with no id after it. Measured over all 1,391 live plans (2026-08-24): the naive
 *     substring flags 16 plans where this pattern flags 9 — SEVEN false positives, one
 *     from the word-anchor (`bettor-evaluation-framework-2026-06-25`, via `EVAL-FRAMEWORK`)
 *     and six from requiring an id character after the dash (shipped plans that merely
 *     discuss the `VAL-` convention). Both guards are load-bearing; neither is theoretical.
 *
 * `\m` is a Postgres word-START anchor, so `VAL-` matches only where a word begins there:
 * it admits `VAL-028`, `VAL-007-01` and the plan-scoped ids, and rejects `EVAL-1` and
 * `RETRIEVAL-2`. Both directions are pinned in spec-reconciliation.test.ts — widen or
 * narrow this only with those cases updated alongside.
 */
export const LEGACY_VAL_TEXT_PATTERN = '\\mVAL-[A-Za-z0-9]';

/**
 * The lane/adoption vocabulary now lives in `spec-enforcement-eligibility.ts` (P-013),
 * because the completion gate and its sync-resolver view need the SAME classification to
 * decide what may refuse — and this file cannot be their source, since it imports the
 * coverage gate (`SpecReconciliationDeps extends PlanSpecCoverageDeps`) and would close a
 * cycle. Re-exported here so existing importers of these names keep working unchanged.
 */
export type { ReconciliationLane, AdoptionState, PlanAdoptionRow } from './spec-enforcement-eligibility';

export type ReconciliationActionKind =
  | 'backfill-val-clauses'
  | 'declare-behavior'
  | 'prove-at-current-revision'
  | 'bind-evidence'
  | 'grade-adequacy'
  | 'declare-falsifier';

export interface ReconciliationAction {
  kind: ReconciliationActionKind;
  detail: string;
  /** The exact clauses this action names, when it names any. */
  specIds?: string[];
}

/** The reason a plan's clauses may not refuse. Mirrors the gates' own reason vocabulary. */
export type NotEnforcingReason = Extract<EnforcementEligibility, { enforcing: false }>['reason'];

export interface SpecReconciliationRow {
  planSlug: string;
  status: string;
  lane: ReconciliationLane;
  adoption: AdoptionState;
  /**
   * P-013 — whether this plan's clauses may actually REFUSE right now, and if not, why.
   *
   * Not a third classification: it is `enforcementEligibility(lane, adoption)`, the exact
   * function both enforcement gates call, so a plan's reported enforcement status here
   * cannot disagree with what the gate does to it. That identity is the point — lane and
   * adoption used to be derived here by two separate calls and composed into a verdict by
   * each reader independently, which is how a ledger comes to describe an enforcement
   * regime the gates are no longer running.
   */
  eligibility: EnforcementEligibility;
  /** Populated only for `adopted` plans — the SHIP GATE's own census, never a re-count. */
  coverage: PlanSpecCoverageAggregate | null;
  /** Set when the census could not run. The plan still appears; it is never dropped. */
  coverageUnavailableReason: string | null;
  /** What to actually DO. Empty only when a censused plan is fully proven and graded. */
  actions: ReconciliationAction[];
}

export interface SpecReconciliationRollup {
  plansConsidered: number;
  byLane: Record<ReconciliationLane, number>;
  /** Adoption partition over NON-HISTORICAL plans only — the population enforcement hits. */
  byAdoption: Record<AdoptionState, number>;
  /**
   * P-013 instrumentation — GATE REASONS at census scope.
   *
   * The single most important number this ledger produces, and the one `byLane` and
   * `byAdoption` cannot state between them: how many plans can a clause gate actually
   * refuse for, and for each of the rest, WHY not. A reader has to cross-multiply two
   * partitions to get it otherwise, and cross-multiplying them wrongly is exactly how
   * "enforcement is on" gets asserted about a corpus where it refuses for nothing.
   *
   * `notEnforcing` is keyed by the gates' own reason vocabulary and is exhaustive over
   * it (`satisfies Record<NotEnforcingReason, number>`), so a newly added reason breaks
   * the build here rather than silently vanishing from the census — the same guarantee
   * NOT_ENFORCED_BECAUSE gives at the work-item gate.
   *
   * ⚠ Counted over ALL plans considered, historical included, because "enforcement does
   * not reach 1,290 plans" is the finding. Restricting it to the non-historical subset
   * the way `byAdoption` does would quietly drop the largest term.
   */
  byEnforcement: {
    enforcing: number;
    notEnforcing: Record<NotEnforcingReason, number>;
  };
  /**
   * P-013 — clause coverage partitioned by behavior class, summed over ADOPTED plans.
   *
   * Absent class ⇒ no plan in the corpus declares a clause of that class. On a corpus
   * this is a stronger statement than it is per-plan: it means the fleet has never
   * written down a promise about, say, concurrency anywhere. Read an absence here as an
   * un-surveyed area, never as a clean one.
   */
  byBehaviorClass: Partial<Record<SpecBehaviorClass, BehaviorClassCoverage>>;
  /** P-013 — evidence composition and worst-case staleness across ADOPTED plans. */
  evidence: {
    byKind: Partial<Record<SpecEvidenceKind, number>>;
    currentByKind: Partial<Record<SpecEvidenceKind, number>>;
    /** The WORST revision lag observed on any single clause in the corpus. */
    maxRevisionLag: number;
    /** The oldest evidence row anywhere still being counted as a current-revision proof. */
    oldestCurrentProofAt: string | null;
  };
  /** Totals over ADOPTED plans only. Zero here means "nothing adopted", not "all clean". */
  clauses: { total: number; enforceable: number; falsifierDeclared: number };
  coverage: { proven: number; staleProof: number; unproven: number };
  adequacy: { graded: number; ungraded: number };
  /** Plans whose census could not be read — never silently excluded from the denominator. */
  censusUnavailablePlanSlugs: string[];
  bounded: {
    /** AXIS 1 — the plan population itself. */
    planLimit: number;
    plansRead: number;
    truncatedByPlanLimit: boolean;
    /** AXIS 2 — an individual plan's evidence/adequacy census. */
    censusTruncatedPlanSlugs: string[];
    anyCensusTruncated: boolean;
    /**
     * EITHER axis ⇒ every count above is a FLOOR. Composed on purpose: a caller that
     * checks one axis and not the other reads a floor as a total.
     */
    countsAreFloor: boolean;
  };
}

export interface SpecReconciliationLedger {
  rows: SpecReconciliationRow[];
  rollup: SpecReconciliationRollup;
}

export interface SpecReconciliationDeps extends PlanSpecCoverageDeps {
  /** The plan population + its adoption inputs. Injected so this is testable without a DB. */
  listPlanAdoption?: (input: {
    harnessSlug?: string;
    limit: number;
  }) => Promise<PlanAdoptionRow[]>;
  computeCoverage?: typeof computePlanSpecCoverage;
}

export const RECONCILIATION_PLAN_LIMIT = 2_000;

// laneOf / adoptionOf are imported from ./spec-enforcement-eligibility — the ledger and the
// enforcement gates MUST classify identically, so there is exactly one implementation.

/**
 * Actions for a plan that has NOT adopted clauses. Both states are work, and neither is
 * ever emitted as an empty action list — an empty list is reserved for a censused plan
 * that is genuinely clean, so that "no actions" cannot be produced by absence of input.
 */
function actionsForUnadopted(adoption: Exclude<AdoptionState, 'adopted'>): ReconciliationAction[] {
  if (adoption === 'legacy-val-only') {
    return [
      {
        kind: 'backfill-val-clauses',
        detail:
          'Plan still carries VAL-* / coversVALs text but has zero first-class clauses. ' +
          'Promote the parseable assertions into clauses, preserving source_val_id provenance; ' +
          'classify anything unparseable rather than dropping it.',
      },
    ];
  }
  return [
    {
      kind: 'declare-behavior',
      detail:
        'Plan declares no behavior at all, so no clause can be uncovered and enforcement ' +
        'would read it as green. That is an absence of promises, NOT compliance.',
    },
  ];
}

/** Actions derived from a real census. Ordered most-blocking first. */
function actionsForCensus(aggregate: PlanSpecCoverageAggregate): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];

  if (aggregate.coverage.staleProof > 0) {
    actions.push({
      kind: 'prove-at-current-revision',
      detail:
        `${aggregate.coverage.staleProof} clause(s) have evidence, but none at the current ` +
        'revision. This is the one condition the ship gate actually refuses on (D-018).',
      specIds: aggregate.coverage.staleProofClauses.map((c) => c.specId),
    });
  }
  if (aggregate.coverage.unproven > 0) {
    actions.push({
      kind: 'bind-evidence',
      detail: `${aggregate.coverage.unproven} enforceable clause(s) have no evidence at all.`,
      specIds: [...aggregate.coverage.unprovenSpecIds],
    });
  }
  if (aggregate.adequacy.ungraded > 0) {
    actions.push({
      kind: 'grade-adequacy',
      detail: `${aggregate.adequacy.ungraded} enforceable clause(s) carry no adequacy scorecard.`,
      specIds: [...aggregate.adequacy.ungradedSpecIds],
    });
  }

  const undeclared = aggregate.clauses.enforceable - aggregate.clauses.falsifierDeclared;
  if (undeclared > 0) {
    actions.push({
      kind: 'declare-falsifier',
      detail:
        `${undeclared} of ${aggregate.clauses.enforceable} enforceable clause(s) do not declare ` +
        'what would falsify them (D-016). REPORT ONLY — never synthesize a falsifier to close ' +
        'this gap; a fabricated one is indistinguishable from a real one afterwards.',
    });
  }

  return actions;
}

/**
 * Build the ledger. Report-only by construction: it returns findings and never a verdict.
 */
export async function computeSpecReconciliationLedger(
  input: { harnessSlug?: string; planLimit?: number } = {},
  deps: SpecReconciliationDeps = {},
): Promise<SpecReconciliationLedger> {
  const planLimit = input.planLimit ?? RECONCILIATION_PLAN_LIMIT;
  const listPlanAdoption = deps.listPlanAdoption ?? defaultListPlanAdoption;
  const computeCoverage = deps.computeCoverage ?? computePlanSpecCoverage;

  // Ask for ONE MORE than the limit so truncation is OBSERVED rather than inferred from a
  // full page — a page that happens to be exactly `limit` long is otherwise ambiguous.
  const fetched = await listPlanAdoption({ harnessSlug: input.harnessSlug, limit: planLimit + 1 });
  const truncatedByPlanLimit = fetched.length > planLimit;
  const planRows = truncatedByPlanLimit ? fetched.slice(0, planLimit) : fetched;

  const rows: SpecReconciliationRow[] = [];
  const censusTruncatedPlanSlugs: string[] = [];
  const censusUnavailablePlanSlugs: string[] = [];

  const byLane: Record<ReconciliationLane, number> = {
    enforceable: 0,
    'pre-enforcement': 0,
    historical: 0,
  };
  const byAdoption: Record<AdoptionState, number> = {
    adopted: 0,
    'legacy-val-only': 0,
    'no-behavior-declared': 0,
  };
  const clauses = { total: 0, enforceable: 0, falsifierDeclared: 0 };
  const coverageTotals = { proven: 0, staleProof: 0, unproven: 0 };
  const adequacyTotals = { graded: 0, ungraded: 0 };
  // P-013 instrumentation accumulators.
  const notEnforcing = {
    historical: 0,
    'pre-enforcement': 0,
    'not-yet-reconciled': 0,
  } satisfies Record<NotEnforcingReason, number>;
  let enforcingCount = 0;
  const byBehaviorClass: Partial<Record<SpecBehaviorClass, BehaviorClassCoverage>> = {};
  const evidenceByKind: Partial<Record<SpecEvidenceKind, number>> = {};
  const evidenceCurrentByKind: Partial<Record<SpecEvidenceKind, number>> = {};
  let maxRevisionLag = 0;
  let oldestCurrentProofAt: string | null = null;

  for (const planRow of planRows) {
    // ONE classification call, whose result is both reported on the row and counted in the
    // rollup. Deriving lane and adoption separately here (as this loop used to) let a
    // reader compose them into an enforcement verdict that the gates did not share.
    const eligibility = enforcementEligibility(planRow);
    const lane = eligibility.lane;
    const adoption = eligibility.adoption;
    if (eligibility.enforcing) enforcingCount += 1;
    else notEnforcing[eligibility.reason] += 1;
    byLane[lane] += 1;
    // Historical plans are carried for visibility but excluded from the adoption partition:
    // enforcement never reaches them, so counting them would dilute the population that
    // enforcement DOES reach — the number this ledger exists to state honestly.
    if (lane !== 'historical') byAdoption[adoption] += 1;

    if (adoption !== 'adopted') {
      rows.push({
        planSlug: planRow.planSlug,
        status: planRow.status,
        lane,
        adoption,
        eligibility,
        coverage: null,
        coverageUnavailableReason: null,
        // A historical plan is visible but never actionable.
        actions: lane === 'historical' ? [] : actionsForUnadopted(adoption),
      });
      continue;
    }

    let aggregate: PlanSpecCoverageAggregate | null = null;
    let unavailable: string | null = null;
    try {
      aggregate = await computeCoverage({ harnessSlug: input.harnessSlug, planSlug: planRow.planSlug }, deps);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }

    if (!aggregate) {
      // A plan whose census failed STAYS in the ledger. Dropping it would shrink the
      // denominator silently and make the remaining coverage look better than it is.
      censusUnavailablePlanSlugs.push(planRow.planSlug);
      rows.push({
        planSlug: planRow.planSlug,
        status: planRow.status,
        lane,
        adoption,
        eligibility,
        coverage: null,
        coverageUnavailableReason: unavailable ?? 'census-returned-nothing',
        actions: [],
      });
      continue;
    }

    if (aggregate.bounded.truncatedByLimit || aggregate.bounded.adequacyTruncatedByLimit) {
      censusTruncatedPlanSlugs.push(planRow.planSlug);
    }

    clauses.total += aggregate.clauses.total;
    clauses.enforceable += aggregate.clauses.enforceable;
    clauses.falsifierDeclared += aggregate.clauses.falsifierDeclared;
    coverageTotals.proven += aggregate.coverage.proven;
    coverageTotals.staleProof += aggregate.coverage.staleProof;
    coverageTotals.unproven += aggregate.coverage.unproven;
    adequacyTotals.graded += aggregate.adequacy.graded;
    adequacyTotals.ungraded += aggregate.adequacy.ungraded;

    // P-013 — fold this plan's partitions into the corpus ones. Summed from the SAME
    // aggregate the flat totals above are summed from, so the two cannot disagree.
    for (const [behaviorClass, slice] of Object.entries(aggregate.byBehaviorClass)) {
      if (!slice) continue;
      const key = behaviorClass as SpecBehaviorClass;
      const target = (byBehaviorClass[key] ??= {
        total: 0,
        enforceable: 0,
        proven: 0,
        staleProof: 0,
        unproven: 0,
        falsifierDeclared: 0,
      });
      target.total += slice.total;
      target.enforceable += slice.enforceable;
      target.proven += slice.proven;
      target.staleProof += slice.staleProof;
      target.unproven += slice.unproven;
      target.falsifierDeclared += slice.falsifierDeclared;
    }
    for (const [kind, count] of Object.entries(aggregate.evidence.byKind)) {
      const key = kind as SpecEvidenceKind;
      evidenceByKind[key] = (evidenceByKind[key] ?? 0) + (count ?? 0);
    }
    for (const [kind, count] of Object.entries(aggregate.evidence.currentByKind)) {
      const key = kind as SpecEvidenceKind;
      evidenceCurrentByKind[key] = (evidenceCurrentByKind[key] ?? 0) + (count ?? 0);
    }
    maxRevisionLag = Math.max(maxRevisionLag, aggregate.evidence.staleness.maxRevisionLag);
    const planOldest = aggregate.evidence.staleness.oldestCurrentProofAt;
    if (planOldest && (oldestCurrentProofAt === null || planOldest < oldestCurrentProofAt)) {
      oldestCurrentProofAt = planOldest;
    }

    rows.push({
      planSlug: planRow.planSlug,
      status: planRow.status,
      lane,
      adoption,
      eligibility,
      coverage: aggregate,
      coverageUnavailableReason: null,
      actions: lane === 'historical' ? [] : actionsForCensus(aggregate),
    });
  }

  const anyCensusTruncated = censusTruncatedPlanSlugs.length > 0;

  return {
    rows,
    rollup: {
      plansConsidered: planRows.length,
      byLane,
      byAdoption,
      byEnforcement: { enforcing: enforcingCount, notEnforcing },
      byBehaviorClass,
      evidence: {
        byKind: evidenceByKind,
        currentByKind: evidenceCurrentByKind,
        maxRevisionLag,
        oldestCurrentProofAt,
      },
      clauses,
      coverage: coverageTotals,
      adequacy: adequacyTotals,
      censusUnavailablePlanSlugs,
      bounded: {
        planLimit,
        plansRead: planRows.length,
        truncatedByPlanLimit,
        censusTruncatedPlanSlugs,
        anyCensusTruncated,
        countsAreFloor: truncatedByPlanLimit || anyCensusTruncated,
      },
    },
  };
}

/**
 * Default population read: one query for every plan plus its adoption inputs. Kept in one
 * place so the ledger never fans out a per-plan probe across ~570 plans.
 */
/**
 * Exported so the work-item-axis latency census (`spec-enforcement-latency.ts`) partitions over
 * the SAME plan population this ledger censuses. A second copy of this query would be free to
 * drift on the archived filter or the legacy-VAL signal, and the two surfaces would then
 * disagree about which plans are enforcing while both looked authoritative.
 */
export async function defaultListPlanAdoption(input: {
  harnessSlug?: string;
  limit: number;
}): Promise<PlanAdoptionRow[]> {
  const { resolvePlanScope } = await import('./source');
  const { withWorkspace } = await import('@papercusp/db-org');
  const scope = await resolvePlanScope({ harnessSlug: input.harnessSlug });

  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<
      { plan_slug: string; status: string | null; clause_count: string; legacy_val: boolean }[]
    >`
      SELECT p.plan_slug,
             p.status,
             (SELECT count(*) FROM harness_shared.plan_spec_clauses c
               WHERE c.workspace_id = p.workspace_id
                 AND c.harness_slug = p.harness_slug
                 AND c.plan_slug    = p.plan_slug) AS clause_count,
             (p.content ~ ${LEGACY_VAL_TEXT_PATTERN}
                OR p.items::text ~ ${LEGACY_VAL_TEXT_PATTERN}
                OR p.items::text ~ 'coversVALs') AS legacy_val
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${scope.workspaceId}
         AND p.harness_slug = ${scope.harnessSlug}
         AND p.archived = false
       ORDER BY p.plan_slug
       LIMIT ${input.limit}
    `,
  );

  return rows.map((r) => ({
    planSlug: r.plan_slug,
    status: r.status ?? 'unknown',
    clauseCount: Number(r.clause_count ?? 0),
    legacyValSignal: Boolean(r.legacy_val),
  }));
}
