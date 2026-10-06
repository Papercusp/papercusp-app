/**
 * Acceptance BAR contract snapshot — one bounded, versioned read model over the
 * existing plan/rubric/spec/evidence/grading authorities.
 *
 * The snapshot is deliberately NOT a table and NOT a second validator. Writers keep
 * owning their canonical rows; this module reads each source once, records exact
 * revisions/boundedness, and projects a deterministic contract that lifecycle gates
 * can evaluate without rebuilding their own partial joins.
 */
import { createHash } from 'node:crypto';
import type { SelectionVia } from '@papercusp/ranked-selection';
import { getOrgPg } from '@papercusp/db-org';
import {
  classifyRubricEvidenceCurrentness,
  computeAcceptanceBarHash,
  computeAcceptanceBarSetHash,
  diffAcceptanceBarHashInputs,
  effectiveCriterionInstrumentKey,
  getAcceptanceRubricsForPlan,
  type AcceptanceBarHashInput,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import {
  isEnforceableSpecLifecycle,
  listSpecClauses,
  type SpecBehaviorClass,
  type SpecClauseRevision,
  type SpecLifecycleStatus,
} from './agent-tools/plans/spec-clauses-store';
import { listSpecEvidence, type EvidenceCurrentInput } from './agent-tools/plans/spec-evidence-store';
import { activeSpecEvidence, evaluateSpecTestAdequacy, PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './agent-tools/plans/spec-test-adequacy';
import { listScorecardPage, type ScorecardRow } from './scorecards';
import { activeWorkspaceId } from './workspace-registry';
import { lineagePartyKeys } from './acceptance-author-identity';
import { gradingViaOf, pickAuthoritativeGrading, readGraderSelectionVia } from './acceptance-grading-authority';
import { parseWorkedByHistory } from './work-item-prior-work';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';
import { requirementSections } from './requirement-contract';
import {
  evidenceRecordsAbsent,
  evidenceRuntimeOf,
  resolveBarEvidenceRuntime,
  type BarEvidenceRuntime,
} from './acceptance-bar-evidence-runtime';
import {
  ACCEPTANCE_BAR_CONTRACT_EPOCH,
  MAX_BAR_PROJECTION_EDGES,
  MAX_REQUIREMENT_BARS,
  acceptanceBarBehaviorClass,
  type AcceptanceBarCohort,
} from './acceptance-bar-seed';
import type { AcceptanceEvidencePlane } from './agent-tools/plans/rubric-template';

export const ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION = 1 as const;
export const ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT = 2;
export const ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT = 500;
export const ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT = 2_000;
export const ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT = 50;
export const ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT = 1_000;

export type AcceptanceBarSnapshotSource =
  | 'plan'
  | 'rubric'
  | 'plan-items'
  | 'clauses'
  | 'work-contracts'
  | 'evidence'
  | 'lineage'
  | 'lineage-parties'
  | 'grading'
  | 'vetting';

export type AcceptanceBarSnapshotCode =
  | 'bar_snapshot_source_unavailable'
  | 'bar_snapshot_source_truncated'
  | 'bar_snapshot_plan_missing'
  | 'bar_snapshot_plan_ambiguous'
  | 'bar_snapshot_cohort_incomplete'
  | 'bar_snapshot_rubric_missing'
  /**
   * P-002 / D-002: the subject plan PINS an acceptance rubric that this read did not
   * return. That is a failed resolve, not an absence — the pin is in-band evidence
   * the author did write one — so it must never surface as `rubric_missing`, which
   * asserts a fact about the author. Mirrors `state:read`'s resolver-failed vs absent.
   */
  | 'bar_snapshot_rubric_unresolved'
  | 'bar_snapshot_rubric_ambiguous'
  | 'bar_snapshot_rubric_revision_mismatch'
  | 'bar_snapshot_bar_set_empty'
  | 'bar_snapshot_bar_set_too_large'
  | 'bar_snapshot_bar_key_duplicate'
  | 'bar_snapshot_bar_hash_missing'
  | 'bar_snapshot_bar_hash_mismatch'
  | 'bar_snapshot_bar_set_hash_mismatch'
  | 'bar_snapshot_bar_provenance_missing'
  | 'bar_snapshot_mapping_missing'
  | 'bar_snapshot_mapping_dropped_only'
  | 'bar_snapshot_projection_stale'
  /**
   * WI-10003187: the BAR IS mapped, but no mapped clause is enforceable (every one is
   * `draft`/`exempt`/`superseded`/`retired`, never promoted to `accepted`/`active`). AUTO-BAR
   * clauses are seeded `draft`, so this is the normal state of a freshly seeded or amended
   * BAR. Proof is only ever counted against enforceable clauses, so this state used to
   * surface as `proof_stale` + `proof_inadequate` with a "re-prove" repair that could never
   * clear it — the bound proof was current all along; the clause was simply never accepted.
   */
  | 'bar_snapshot_clause_not_accepted'
  | 'bar_snapshot_method_missing'
  | 'bar_snapshot_work_contract_missing'
  | 'bar_snapshot_work_contract_stale'
  | 'bar_snapshot_proof_missing'
  | 'bar_snapshot_proof_stale'
  | 'bar_snapshot_grading_missing'
  | 'bar_snapshot_grading_stale'
  | 'bar_snapshot_grading_not_pass'
  | 'bar_snapshot_vetting_missing'
  | 'bar_snapshot_vetting_stale'
  | 'bar_snapshot_author_verdict_missing'
  | 'bar_snapshot_author_verdict_stale'
  | 'bar_snapshot_author_rejected'
  /**
   * The author ACCEPTED the graded work and is holding delivery open: every
   * reachable obligation is met, and what remains is evidence on a delivery
   * plane the author cannot reach (a `deployed`/`live` BAR behind a gate or a
   * deploy someone else owns).
   *
   * This is a DISCLOSURE, not a defect. Without it such a plan has no
   * representable verdict at all — `accept` overclaims delivery that has not
   * happened and `reject` is simply false — so the honest move was to record
   * nothing, and the ceremony stalled indefinitely on an action its author was
   * never able to perform. Recording the split makes the judgment durable and
   * machine-readable while keeping the delivery fact separately true.
   */
  | 'bar_snapshot_author_accepted_pending_delivery'
  // P-003 lifecycle contract checks. These are deliberately separate from the
  // phase evaluator: the snapshot remains an explainable read model while the
  // evaluator decides which of these become blocking at each door.
  | 'bar_snapshot_falsifier_missing'
  | 'bar_snapshot_role_invalid'
  | 'bar_snapshot_mandatory_invalid'
  | 'bar_snapshot_scope_invalid'
  | 'bar_snapshot_pass_ratings_invalid'
  | 'bar_snapshot_coverage_invalid'
  | 'bar_snapshot_check_missing'
  | 'bar_snapshot_check_invalid'
  | 'bar_snapshot_proof_uncertain'
  | 'bar_snapshot_proof_depth_missing'
  | 'bar_snapshot_proof_inadequate'
  | 'bar_snapshot_evidence_plane_unmet'
  /**
   * acceptance-runtime-plane P-002: a deployed/live BAR DECLARES the runtime its evidence
   * must be measured on, and no current evidence was measured there (or the evidence
   * measured there records the change as absent). Inferred/unresolved runtimes never
   * raise this — they are review flags on `evidenceRuntime`, not promises.
   */
  | 'bar_snapshot_evidence_runtime_unmet';

export interface BoundedAcceptanceBarRows<T> {
  rows: T[];
  limit: number;
  truncated: boolean;
}

export interface AcceptanceBarSubjectPlanSource {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  status: string | null;
  revision: number;
  contentHash: string | null;
  adoptionEpoch: number | null;
  cohort: AcceptanceBarCohort | null;
  barSetHash: string | null;
  rubricSlug: string | null;
  rubricRevision: number | null;
  seededAt: string | null;
  seededBy: string | null;
  /**
   * WI-10004146: the LOCAL plan revision at which a federated receiver verified its
   * BAR state against the federated rubric. Non-null only on a receiver, where the
   * rubric's `subjectPlanRevision` names the author's local counter; there this pin,
   * not the rubric's, must equal `revision`. Absent/null = the rubric pin governs.
   */
  verifiedRevision?: number | null;
}

export interface AcceptanceBarPlanItemSource {
  itemId: string;
  status: string;
}

export interface AcceptanceBarWorkContractSource {
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
}

export type AcceptanceBarEvidenceSource = Awaited<ReturnType<typeof listSpecEvidence>>[number];

export interface AcceptanceBarLineageSource {
  identities: string[];
  workItemRowsRead: number;
  auditRowsRead: number;
  rowLimit: number;
  truncated: boolean;
}

export interface AcceptanceBarSnapshotProblem {
  code: AcceptanceBarSnapshotCode;
  source: AcceptanceBarSnapshotSource;
  severity: 'error' | 'warning';
  detail: string;
  barKey?: string;
}

export interface AcceptanceBarContractSnapshotInput {
  planRows: BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>;
  rubrics: BoundedAcceptanceBarRows<Rubric>;
  planItems: BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>;
  clauses: BoundedAcceptanceBarRows<SpecClauseRevision>;
  workContracts: BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>;
  evidence: BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>;
  scorecards: BoundedAcceptanceBarRows<ScorecardRow>;
  vettingScorecards: BoundedAcceptanceBarRows<ScorecardRow>;
  lineage: AcceptanceBarLineageSource;
  partyByIdentity: ReadonlyMap<string, string>;
  graderSelectionVia: ReadonlyMap<string, SelectionVia>;
  readFailures?: Partial<Record<AcceptanceBarSnapshotSource, string>>;
}

export interface AcceptanceBarTrace {
  barKey: string;
  criterionKey: string;
  /** Additive read fields; older cached snapshots may omit them. */
  title?: string;
  requirement?: ReturnType<typeof requirementSections>;
  barHash: string | null;
  model: string;
  method: string;
  /** Structured verification contract, when declared. Required from pre-vetting onward. */
  check: RubricCriterion['check'] | null;
  /** Explicit manual replication procedure, when the check uses instrument:'none'. */
  replication: string | null;
  falsifier: string;
  role: RubricCriterion['role'] | null;
  mandatory: boolean | null;
  requiredScope: string[];
  evidencePlane: 'tree' | 'deployed' | 'live' | null;
  /**
   * acceptance-runtime-plane P-002: WHICH runtime a deployed/live BAR is measured on —
   * declared, inferred from its source paths (flagged for review), or unresolved (flagged).
   * Absent on snapshots written before this field existed.
   */
  evidenceRuntime?: BarEvidenceRuntime;
  /** The projected clause class; absent on snapshots written before this field existed. */
  behaviorClass?: SpecBehaviorClass | null;
  /** Additive trace of the clause mutation obligation. */
  mutationRequired?: boolean;
  /**
   * Whether this BAR carries an automated proof obligation, as computed by the projection
   * that can see the rubric criterion (its `check`/instrument declaration), not just the
   * clause class. Consumers MUST prefer this when present: a BAR the author explicitly
   * declared manual projects `behaviorClass: 'happy-path'` on the `tree` plane, so
   * re-deriving the floor from the clause class alone reinstates a floor this projection
   * deliberately lifted. Absent on snapshots written before this field existed, where
   * consumers keep failing closed to the historic automated behavior.
   */
  automatedProofRequired?: boolean;
  requiredTestLayers?: string[];
  passRatings: string[];
  coversBarKeys: string[];
  provenance: RubricCriterion['barProvenance'] | null;
  mappings: Array<{
    planItemId: string;
    planItemStatus: string | null;
    specId: string;
    sourceValId?: string | null;
    specRevision: number;
    specContentHash: string;
    sourceBarHash: string | null;
    sourceBarSetHash: string | null;
    sourceRubricRevision: number | null;
    evidencePlane: 'tree' | 'deployed' | 'live' | null;
    /**
     * The mapped clause's lifecycle (WI-10003864). `mappings` lists EVERY clause row keyed
     * to this BAR, including draft and retired ones, while every proof judgement on this
     * trace counts only enforceable clauses (`isEnforceableSpecLifecycle`). Consumers that
     * judge per mapping must skip a non-enforceable one, or a clause the snapshot never
     * proves blocks its item forever. Absent on snapshots written before this field
     * existed; consumers treat absence as enforceable (fail closed).
     */
    lifecycleStatus?: SpecLifecycleStatus;
  }>;
  workContracts: Array<{
    workItemId: string;
    specId: string;
    specRevision: number;
    specFingerprint: string;
    current: boolean;
  }>;
  proof: {
    state: 'current' | 'stale' | 'missing' | 'truncated';
    history?: Array<Pick<AcceptanceBarEvidenceSource,
      'id' | 'workItemId' | 'specId' | 'specRevision' | 'specFingerprint' | 'evidenceKind' |
      'evidenceRef' | 'testRunId' | 'observedAt' | 'createdBy' | 'details' | 'currentness'> & {
        currentRevision?: number;
        matchesCurrentSpec: boolean;
        activeAttempt?: boolean;
      }>;
    currentEvidence: number;
    staleEvidence: number;
    supersededEvidence?: number;
    kinds: string[];
    evidenceRefs: string[];
    /** Evidence rows whose currentness could not be established. */
    uncertainEvidence: number;
    /** Explicit planes recorded by evidence details, when producers supplied one. */
    evidencePlanes: string[];
    /** P-002: runtimes current evidence says it was measured on (details.runtime). */
    evidenceRuntimes?: string[];
    /** P-002: runtimes whose current evidence recorded the change ABSENT (details.containsChange:false). */
    runtimeAbsent?: string[];
    adequacy?: {
      state: 'pass' | 'fail' | 'unknown' | 'undeclared';
      checks: Array<{ specId: string; revision: number; verdict: 'pass' | 'fail' | 'unknown'; wouldBlock: string[]; evidenceRefs: string[] }>;
    };
  };
  grading: {
    state: 'pass' | 'not-pass' | 'stale' | 'missing' | 'truncated';
    history?: Array<{
      scorecardId: string; createdAt: string; createdBy: string | null; rubricRevision: number | null;
      criteriaHash?: string | null;
      role: 'author' | 'implementer' | 'independent' | 'unattributed';
      authoritative: boolean; currentRevision: boolean; complete: boolean; retracted: boolean;
      supersedes: string | null; supersededBy: string | null; selectedVia: SelectionVia | null;
      rating: string | null; evidence: string | null; authorVerdict: string | null; reasoning: string | null;
    }>;
    scorecardId: string | null;
    rubricRevision: number | null;
    criteriaHash?: string | null;
    gradedBy: string | null;
    selectedVia: SelectionVia | null;
    rating: string | null;
    evidence: string | null;
  };
  readiness: {
    state: 'ready' | 'blocked';
    codes: AcceptanceBarSnapshotCode[];
    mapping: 'live' | 'dropped-only' | 'missing';
    method: 'declared' | 'missing';
    workContract: 'current' | 'stale' | 'missing';
    /**
     * WI-10003187: whether any mapped clause is enforceable. `not-accepted` means proof
     * cannot be judged yet, so readers must not render the stale/inadequate proof codes for
     * it. Absent on snapshots written before this field existed.
     */
    clauseAcceptance?: 'accepted' | 'not-accepted' | 'unmapped';
  };
}

/**
 * THE reader for {@link AcceptanceBarTrace.automatedProofRequired} — one definition, every gate.
 *
 * Three gates ask "does this BAR owe automated proof?": contract readiness (this module), the
 * lifecycle evaluator, and non-code requirement realization. The predicate previously lived
 * PRIVATELY inside the lifecycle evaluator, so realization never learned about the explicitly
 * manual case and rejected a manual BAR on the exact values the manual escape hatch produces
 * — zero declared layers and adequacy `undeclared` (WI-10002089).
 *
 * It lives HERE because this module owns the field it reads, and both consumers already import
 * from it, so neither needs an import cycle to reach it. A fourth copy of this predicate would
 * be a fourth definition of "manual", free to drift silently — each copy individually correct.
 *
 * Fails closed: a snapshot written before the field existed keeps the historic automated
 * behavior until a fresh projection proves the clause is non-automated.
 */
export function barRequiresAutomatedProof(bar: AcceptanceBarTrace): boolean {
  // Prefer the projection's own verdict. Only it can see the rubric criterion's instrument
  // declaration, so only it can tell an EXPLICITLY manual BAR from an automated one: a manual
  // BAR still projects `behaviorClass: 'happy-path'` on the `tree` plane, and re-deriving the
  // floor from the clause class below would reinstate a floor the projection deliberately lifted.
  if (typeof bar.automatedProofRequired === 'boolean') return bar.automatedProofRequired;
  return bar.behaviorClass !== 'non-automated' ||
    (bar.requiredTestLayers?.length ?? 0) > 0 || bar.mutationRequired === true;
}

/** The per-clause inputs of {@link projectedAutomatedProofRequired}. */
export interface ProjectedClauseProofObligation {
  behaviorClass: SpecBehaviorClass | null;
  requiredTestLayers: readonly string[];
  mutationRequired: boolean;
}

/**
 * THE writer of {@link AcceptanceBarTrace.automatedProofRequired}: the projection's rule for
 * whether a BAR owes automated proof, given its criterion and its enforceable clauses.
 *
 * A BAR whose author EXPLICITLY declared it manual (`check: {kind:'instrument',
 * instrumentKey:'none'}`) carries no automated proof obligation, whichever plane its record
 * lives on. Deliberately narrow, and fails closed: the criterion must itself declare no layers,
 * any clauses already projected may declare no layer or mutation obligation. Before
 * plans:start projects clauses, an empty clause set cannot contradict the explicit
 * manual declaration. Otherwise
 * any automated clause class, explicit layer or mutation keeps the automated floor.
 *
 * P-039 (review-system-rework-reduction-2026-09-23, R-9): extracted so the amendment dry run
 * can predict the POST-amendment verdict with the same rule the projection will apply after
 * the write, instead of carrying the pre-amendment verdict forward (see
 * {@link predictAmendedBarProofFloor}).
 */
export function projectedAutomatedProofRequired(input: {
  instrumentKey: string | null;
  structuredTestsCheck: boolean;
  criterionTestLayers: readonly string[] | null | undefined;
  clauses: readonly ProjectedClauseProofObligation[];
}): boolean {
  const explicitlyManual =
    input.instrumentKey === 'none' &&
    (input.criterionTestLayers?.length ?? 0) === 0 &&
    input.clauses.every((clause) => clause.requiredTestLayers.length === 0 && !clause.mutationRequired);
  // A tests check is an authored automated obligation even on a live/deployed
  // plane, whose generated clauses otherwise have the non-automated class.
  return input.structuredTestsCheck || (!explicitlyManual && (input.clauses.length === 0 || input.clauses.some((clause) =>
    clause.behaviorClass !== 'non-automated' || clause.requiredTestLayers.length > 0 || clause.mutationRequired,
  )));
}

/**
 * P-039 (review-system-rework-reduction-2026-09-23, R-9): re-derive each amended BAR's
 * automated-proof verdict for the amendment CANDIDATE.
 *
 * The candidate is built by spreading the pre-amendment trace, so without this it carried the
 * OLD `automatedProofRequired`: a dry run that gave a manual (`instrumentKey:'none'`) BAR a tests
 * check still predicted "manual, no automated proof owed", and the proof floor the apply would
 * raise was invisible until the next gate probe. Measured 2026-09-23 (Avi #302): a 14-criterion
 * amendment on consult-expert-routing-2026-09-22 would have flipped 13 manual BARs to automated.
 *
 * A BAR whose hash is unchanged keeps its projected verdict (its clauses keep their revision,
 * P-001). A changed or new BAR is re-projected from the NEXT criterion: each mapped clause takes
 * the class the re-projection derives (`acceptanceBarBehaviorClass` of plane and layers), the
 * criterion's layers, and its current mutation obligation. Where an author hand-refined a clause
 * class the prediction can read stricter than the apply — a false alarm in the preview, never a
 * missed obligation.
 */
export function predictAmendedBarProofFloor(
  prior: AcceptanceBarContractSnapshot,
  candidate: AcceptanceBarContractSnapshot,
  nextCriteria: readonly RubricCriterion[],
): AcceptanceBarContractSnapshot {
  const priorByKey = new Map(prior.bars.map((bar) => [bar.barKey, bar]));
  const criterionByKey = new Map(nextCriteria.map((criterion) => [criterion.barKey ?? criterion.key, criterion]));
  return {
    ...candidate,
    bars: candidate.bars.map((bar) => {
      const before = priorByKey.get(bar.barKey);
      const criterion = criterionByKey.get(bar.barKey);
      // A requirement patch can carry a stale criterion.barHash read alias even
      // while the candidate's check has changed. Compare the candidate and the
      // proof-floor inputs too, so a manual → tests transition is re-predicted
      // before approval instead of inheriting the old manual verdict.
      if (!criterion || (before && before.barHash === bar.barHash &&
        effectiveCriterionInstrumentKey({ model: before.model, check: before.check ?? undefined }) ===
          effectiveCriterionInstrumentKey(criterion) &&
        (before.requiredTestLayers?.length ?? 0) === (criterion.requiredTestLayers?.length ?? 0) &&
        (before.evidencePlane ?? 'tree') === (criterion.evidencePlane ?? 'tree'))) return bar;
      const plane = (criterion.evidencePlane ?? before?.evidencePlane ?? 'tree') as AcceptanceEvidencePlane;
      const layers = criterion.requiredTestLayers ?? [];
      const clause: ProjectedClauseProofObligation = {
        behaviorClass: before?.mutationRequired === true ? 'happy-path' : acceptanceBarBehaviorClass(plane, layers, criterion.check),
        requiredTestLayers: layers,
        mutationRequired: before?.mutationRequired === true,
      };
      return {
        ...bar,
        automatedProofRequired: projectedAutomatedProofRequired({
          instrumentKey: effectiveCriterionInstrumentKey(criterion),
          structuredTestsCheck: criterion.check?.kind === 'tests',
          criterionTestLayers: layers,
          clauses: bar.mappings.map(() => clause),
        }),
      };
    }),
  };
}

export interface AcceptanceBarContractSnapshot {
  schemaVersion: typeof ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION;
  contentHash: string;
  planSlug: string;
  applicable: boolean;
  plan: AcceptanceBarSubjectPlanSource | null;
  rubric: {
    rubricId: string;
    revision: number | null;
    criteriaHash: string | null;
    barSetHash: string | null;
    contract: Rubric['barContract'] | null;
    createdBy: string | null;
    ratingScale: string[];
    classRef: string | null;
  } | null;
  sourceRevisions: {
    subjectPlan: number | null;
    rubricPlan: number | null;
    clauses: Array<{ specId: string; revision: number; contentHash: string }>;
    workContracts: Array<{ workItemId: string; specId: string; revision: number; fingerprint: string }>;
    scorecardIds: string[];
  };
  bounded: Record<
    'plans' | 'rubrics' | 'planItems' | 'clauses' | 'workContracts' | 'evidence' | 'scorecards' | 'vetting' | 'lineage',
    { rowsRead: number; limit: number; truncated: boolean }
  >;
  completeness: {
    complete: boolean;
    truncated: boolean;
    problems: AcceptanceBarSnapshotProblem[];
  };
  lineage: {
    identities: string[];
    parties: Array<{ identity: string; party: string }>;
    complete: boolean;
  };
  grading: {
    authoritativeScorecardId: string | null;
    gradedBy: string | null;
    selectedVia: SelectionVia | null;
    rubricRevision: number | null;
    criteriaHash?: string | null;
    vetting: {
      state: 'current' | 'stale' | 'missing' | 'truncated';
      scorecardId: string | null;
      rubricRevision: number | null;
      criteriaHash?: string | null;
    };
    authorVerdict: {
      state: 'accepted' | 'accepted-pending-delivery' | 'rejected' | 'stale' | 'missing';
      scorecardId: string | null;
      verdict: string | null;
      createdBy?: string | null;
      rubricRevision?: number | null;
      criteriaHash?: string | null;
      supersedes?: string | null;
      reasoning?: string | null;
    };
  };
  bars: AcceptanceBarTrace[];
  readiness: {
    state: 'ready' | 'blocked' | 'not-applicable';
    codes: AcceptanceBarSnapshotCode[];
    nextRepair: { code: AcceptanceBarSnapshotCode; barKey: string | null; action: string } | null;
  };
}

export interface AcceptanceBarSnapshotDeps {
  readPlans: (planSlug: string, scope?: { harnessSlug: string }) => Promise<BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>>;
  readRubrics: (planSlug: string, scope?: { harnessSlug: string }) => Promise<BoundedAcceptanceBarRows<Rubric>>;
  readPlanItems: (
    plan: AcceptanceBarSubjectPlanSource,
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>>;
  readClauses: (plan: AcceptanceBarSubjectPlanSource) => Promise<BoundedAcceptanceBarRows<SpecClauseRevision>>;
  readWorkContracts: (
    plan: AcceptanceBarSubjectPlanSource,
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>>;
  readEvidence: (
    plan: AcceptanceBarSubjectPlanSource,
    current?: EvidenceCurrentInput[],
  ) => Promise<BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>>;
  readLineage: (plan: AcceptanceBarSubjectPlanSource) => Promise<AcceptanceBarLineageSource>;
  readScorecards: (rubric: Rubric) => Promise<BoundedAcceptanceBarRows<ScorecardRow>>;
  readVettingScorecards: (rubric: Rubric) => Promise<BoundedAcceptanceBarRows<ScorecardRow>>;
  readParties: (identities: string[], workspaceId: string) => Promise<Map<string, string>>;
  readGraderSelectionVia: (workspaceId: string, rubricId: string) => Promise<Map<string, SelectionVia>>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function bounded<T>(rows: T[], limit: number): BoundedAcceptanceBarRows<T> {
  return { rows: rows.slice(0, limit), limit, truncated: rows.length > limit };
}

function emptyBounded<T>(limit: number): BoundedAcceptanceBarRows<T> {
  return { rows: [], limit, truncated: false };
}

function normalized(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function problemKey(problem: AcceptanceBarSnapshotProblem): string {
  return `${problem.code}\0${problem.source}\0${problem.barKey ?? ''}\0${problem.detail}`;
}

function addProblem(problems: AcceptanceBarSnapshotProblem[], problem: AcceptanceBarSnapshotProblem): void {
  const key = problemKey(problem);
  if (!problems.some((candidate) => problemKey(candidate) === key)) problems.push(problem);
}

function scorecardAcceptance(card: ScorecardRow): {
  verdict?: string;
  reasoning?: string;
  seat?: { succeededFrom?: string };
} | null {
  const value = card.acceptance;
  return value && typeof value === 'object'
    ? (value as { verdict?: string; reasoning?: string; seat?: { succeededFrom?: string } })
    : null;
}

function completeScorecard(card: ScorecardRow): boolean {
  return card.rubricResolved && card.missingKeys.length === 0 && !card.synthesized && !card.retracted;
}

function partyOf(identity: string | null | undefined, parties: ReadonlyMap<string, string>): string | null {
  const id = identity?.trim() ?? '';
  return id ? (parties.get(id) ?? id) : null;
}

function authoritativeGrading(input: AcceptanceBarContractSnapshotInput, rubric: Rubric | null) {
  if (!rubric) return { card: undefined, via: null as SelectionVia | null, authorVerdict: undefined,
    roleOf: (_card: ScorecardRow) => 'unattributed' as const };
  const allComplete = input.scorecards.rows.filter(completeScorecard);
  const author = rubric.createdBy ?? rubric.proposedBy ?? null;
  const authorParty = partyOf(author, input.partyByIdentity);
  const principalParties = new Set(
    input.lineage.identities.map((id) => partyOf(id, input.partyByIdentity)).filter(Boolean),
  );
  const holdsAuthorAuthority = (card: ScorecardRow): boolean => {
    if (partyOf(card.createdBy, input.partyByIdentity) === authorParty && authorParty !== null) return true;
    return scorecardAcceptance(card)?.seat?.succeededFrom === author;
  };
  const isPrincipal = (card: ScorecardRow): boolean => {
    const party = partyOf(card.createdBy, input.partyByIdentity);
    return party !== null && principalParties.has(party);
  };
  const standingAuthorVerdicts = new Map(
    allComplete
      .filter((card) => !card.supersededBy && holdsAuthorAuthority(card) && card.acceptance && card.supersedes)
      .map((card) => [card.issueId, card.supersedes!] as const),
  );
  const standing = allComplete.filter(
    (card) =>
      !card.supersededBy ||
      (standingAuthorVerdicts.get(card.supersededBy) === card.issueId &&
        !holdsAuthorAuthority(card) &&
        !isPrincipal(card)),
  );
  const independent = standing.filter((card) => !holdsAuthorAuthority(card) && !isPrincipal(card));
  const card = pickAuthoritativeGrading(independent, (candidate) => gradingViaOf(candidate, input.graderSelectionVia));
  const authorVerdict = standing
    .filter((candidate) => holdsAuthorAuthority(candidate) && scorecardAcceptance(candidate))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return {
    card,
    via: card ? gradingViaOf(card, input.graderSelectionVia) : null,
    authorVerdict,
    roleOf: (candidate: ScorecardRow) => !candidate.createdBy ? 'unattributed' as const
      : holdsAuthorAuthority(candidate) ? 'author' as const
        : isPrincipal(candidate) ? 'implementer' as const : 'independent' as const,
  };
}

/**
 * The repair order `nextRepair` ranks by. Exported so tests (and any reader of a
 * refusal) can assert the sequence instead of re-deriving it from prose.
 */
export const ACCEPTANCE_BAR_REPAIR_ORDER = [
    'bar_snapshot_source_unavailable',
    'bar_snapshot_source_truncated',
    'bar_snapshot_plan_missing',
    'bar_snapshot_plan_ambiguous',
    'bar_snapshot_cohort_incomplete',
    // P-002: unresolved outranks missing — a read that could not see the rubric must
    // never hand the caller a repair that presumes the author omitted one.
    'bar_snapshot_rubric_unresolved',
    'bar_snapshot_rubric_missing',
    'bar_snapshot_rubric_ambiguous',
    'bar_snapshot_rubric_revision_mismatch',
    'bar_snapshot_bar_set_empty',
    'bar_snapshot_bar_set_too_large',
    'bar_snapshot_bar_key_duplicate',
    'bar_snapshot_bar_hash_missing',
    'bar_snapshot_bar_hash_mismatch',
    'bar_snapshot_bar_set_hash_mismatch',
    'bar_snapshot_bar_provenance_missing',
    'bar_snapshot_mapping_missing',
    'bar_snapshot_mapping_dropped_only',
    'bar_snapshot_projection_stale',
    // P-004 (review-system-rework-reduction-2026-09-23): the repair order IS the runbook
    // order — amend → vet → attest → bind → cards → grade. Contract TEXT first (every
    // repair here is a rubrics:amend), then VETTING, and only then work contracts, proof,
    // adequacy and grading. Vetting used to rank after proof AND grading, so the gate
    // nudged authors to bind proof and commission grading on a revision the vetting
    // critique then amended — measured as a whole "vetting after proof" re-proof cycle in
    // docs/evidence/review-system-time-audit-2026-09-23.md. (Grading on an unvetted
    // revision is refused by scorecards:emit anyway, so that nudge could never succeed.)
    // The contract-text codes below method_missing were absent from this list entirely, so
    // a BAR failing only on them got nextRepair:null — no NEXT REPAIR line at all.
    'bar_snapshot_method_missing',
    'bar_snapshot_falsifier_missing',
    'bar_snapshot_role_invalid',
    'bar_snapshot_mandatory_invalid',
    'bar_snapshot_scope_invalid',
    'bar_snapshot_pass_ratings_invalid',
    'bar_snapshot_coverage_invalid',
    'bar_snapshot_check_missing',
    'bar_snapshot_check_invalid',
    'bar_snapshot_vetting_missing',
    'bar_snapshot_vetting_stale',
    // WI-10003187: accept the vetted clause projection before any proof/grading repair.
    // After vetting because a vetting critique usually amends, and an amendment re-seeds
    // the changed BAR's clause as draft, so accepting earlier would be spent twice.
    // Before proof because every proof code is meaningless until a clause is enforceable.
    'bar_snapshot_clause_not_accepted',
    'bar_snapshot_work_contract_missing',
    'bar_snapshot_work_contract_stale',
    'bar_snapshot_proof_missing',
    'bar_snapshot_proof_stale',
    'bar_snapshot_proof_uncertain',
    'bar_snapshot_proof_depth_missing',
    'bar_snapshot_proof_inadequate',
    'bar_snapshot_evidence_plane_unmet',
    'bar_snapshot_evidence_runtime_unmet',
    'bar_snapshot_grading_missing',
    'bar_snapshot_grading_stale',
    'bar_snapshot_grading_not_pass',
    'bar_snapshot_author_verdict_missing',
    'bar_snapshot_author_verdict_stale',
    'bar_snapshot_author_rejected',
    // LAST in the repair order on purpose: it is a disclosure of a held-open
    // delivery, not a defect the author can repair. Ranking it above a real
    // blocker would point the reader at the one thing they cannot act on.
    'bar_snapshot_author_accepted_pending_delivery',
] as const satisfies readonly AcceptanceBarSnapshotCode[];

/**
 * Compile-time completeness: a code missing from the order is never ranked, so a
 * BAR blocked only by it got `nextRepair: null` and a refusal with no NEXT REPAIR
 * line (nine contract/proof codes were in that state until P-004). Adding a code to
 * the union without placing it in the order now fails the typecheck here.
 */
type UnrankedRepairCode = Exclude<AcceptanceBarSnapshotCode, (typeof ACCEPTANCE_BAR_REPAIR_ORDER)[number]>;
const everyRepairCodeIsRanked: [UnrankedRepairCode] extends [never] ? true : UnrankedRepairCode = true;
void everyRepairCodeIsRanked;

export function nextRepair(
  codes: readonly AcceptanceBarSnapshotCode[],
  // Structural, not AcceptanceBarTrace: the lifecycle evaluator re-derives per-phase
  // codes and ranks THOSE, so it passes { barKey, readiness:{ codes } } views.
  bars: ReadonlyArray<{ barKey: string; readiness: { codes: readonly AcceptanceBarSnapshotCode[] } }>,
): AcceptanceBarContractSnapshot['readiness']['nextRepair'] {
  const code = ACCEPTANCE_BAR_REPAIR_ORDER.find((candidate) => codes.includes(candidate));
  if (!code) return null;
  const bar = bars.find((candidate) => candidate.readiness.codes.includes(code));
  const actions: Record<AcceptanceBarSnapshotCode, string> = {
    bar_snapshot_source_unavailable: 'Repair or retry the named canonical source read; unreadable is not empty.',
    bar_snapshot_source_truncated:
      'Reduce the contract population or use the bounded continuation before evaluating it.',
    bar_snapshot_plan_missing: 'Restore or identify the canonical subject plan row.',
    bar_snapshot_plan_ambiguous: 'Resolve the duplicate subject-plan identity before evaluating a contract.',
    bar_snapshot_cohort_incomplete: 'Repair the server-owned adoption epoch/cohort seed on the subject plan.',
    bar_snapshot_rubric_unresolved:
      'Retry the acceptance-rubric read, or re-route to a process that can see it — the subject PINS a rubric this read '
      + 'could not resolve, so its absence here is UNMEASURED, not established. Do NOT amend or re-seed the rubric on this '
      + 'evidence: as far as this read knows it is intact, and amending it would destroy any in-flight grading card.',
    bar_snapshot_rubric_missing: "Seed or restore the plan's canonical acceptance rubric.",
    bar_snapshot_rubric_ambiguous: 'Retire the competing active acceptance rubric before continuing.',
    bar_snapshot_rubric_revision_mismatch:
      'Before mutating BAR state, run dev:pipeline_position { path: ' +
      '"packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts", ' +
      'marker: "synchronizeAcceptanceBarSubjectRevision" } to distinguish a stale serving build ' +
      'from a live guard. If the synchronizer is not deployed, land/redeploy it first; otherwise ' +
      're-seed or amend atomically so subject and rubric revision pins agree.',
    bar_snapshot_bar_set_empty: 'Declare at least one canonical outcome BAR for this post-epoch plan.',
    bar_snapshot_bar_set_too_large: 'Reduce the BAR set to the declared bounded contract limit.',
    bar_snapshot_bar_key_duplicate: 'Give every BAR one unique stable barKey.',
    bar_snapshot_bar_hash_missing: 'Run the canonical rubric writer so every BAR receives a server-derived hash.',
    bar_snapshot_bar_hash_mismatch: 'Amend through the canonical writer; stored BAR meaning and hash diverge.',
    bar_snapshot_bar_set_hash_mismatch: 'Reconcile the complete BAR set and its subject/rubric hash pins atomically.',
    bar_snapshot_bar_provenance_missing: 'Backfill server-owned BAR provenance for the adopted cohort.',
    bar_snapshot_mapping_missing: 'Map the BAR to at least one live P-NNN projection.',
    bar_snapshot_mapping_dropped_only: 'Map the outstanding BAR to a live replacement item or amend the BAR.',
    bar_snapshot_projection_stale: 'Regenerate the clause projection from the current BAR revision.',
    bar_snapshot_clause_not_accepted:
      'Accept the mapped clause: plans:get-specs, then plans:set-specs with lifecycleStatus:"active", '
      + 'expectedRevision set to its current revision, and every other field unchanged (keep the sourceBar pin '
      + 'and acceptanceRef; omitting either rides the prior value forward). That provenance-only promotion carries '
      + 'the bound proof and work-item contracts forward: confirm the result reports evidenceCarriedForward > 0 on '
      + 'a clause that had proof. If it is absent, another field changed and the proof must be re-bound at the new '
      + 'revision. Do NOT re-prove or amend the rubric on this code: the proof is not stale, the clause was never accepted.',
    bar_snapshot_method_missing: 'Fill the BAR METHOD/check contract before vetting or grading.',
    bar_snapshot_work_contract_missing: 'Promote the BAR/spec revision into the relevant work-item contract.',
    bar_snapshot_work_contract_stale: 'Rebind the open work-item contract to the current spec revision.',
    bar_snapshot_proof_missing: 'Bind evidence at the current spec revision on the declared evidence plane.',
    bar_snapshot_proof_stale: 'Re-prove the current spec revision; superseded proof does not cover it.',
    bar_snapshot_grading_missing: 'Record a complete independent grading against the current rubric criteria.',
    bar_snapshot_grading_stale: 'Re-grade against the current rubric criteria.',
    bar_snapshot_grading_not_pass: 'Satisfy the BAR and record a pass-equivalent independent rating.',
    bar_snapshot_vetting_missing:
      'Vet the current acceptance-rubric criteria BEFORE binding proof or emitting adequacy cards '
      + '(amend → vet → attest → bind → cards → grade): a vetting critique usually becomes an amendment, '
      + 'and proof bound first must then be re-bound.',
    bar_snapshot_vetting_stale:
      'Re-vet the current acceptance-rubric criteria before binding more proof or commissioning grading '
      + '(amend → vet → attest → bind → cards → grade).',
    bar_snapshot_author_verdict_missing: 'Record the author-side verdict after reading the independent grading.',
    bar_snapshot_author_verdict_stale: 'Record a new author verdict for the authoritative grading.',
    bar_snapshot_author_rejected: 'Address the rejected grading before recording a newer verdict.',
    bar_snapshot_author_accepted_pending_delivery:
      'No author action: the acceptance judgment is recorded and delivery is held open. ' +
      'Supply the outstanding delivery-plane evidence (or have its owner do so), then record ' +
      'the final accept. Do NOT amend the rubric or re-grade on this code.',
    bar_snapshot_falsifier_missing: 'Declare a concrete falsifier/drift marker for the BAR.',
    bar_snapshot_role_invalid: 'Make each BAR an outcome or make a disclosure explicitly cover outcome BARs.',
    bar_snapshot_mandatory_invalid: 'Mark every BAR outcome mandatory; disclosures must not satisfy the ship floor.',
    bar_snapshot_scope_invalid: 'Declare a non-empty tree, deployed, or live evidence scope.',
    bar_snapshot_pass_ratings_invalid:
      'Use non-empty positive pass ratings from the rubric scale for mandatory outcomes.',
    bar_snapshot_coverage_invalid: 'Repair disclosure coverage so it references existing outcome BAR keys only.',
    bar_snapshot_check_missing: 'Add a runnable structured check or explicit manual instrument contract.',
    bar_snapshot_check_invalid: 'Repair the structured check or provide an explicit manual replication contract.',
    bar_snapshot_proof_uncertain: 'Re-bind evidence with complete currentness/fingerprint metadata.',
    bar_snapshot_proof_depth_missing:
      'Declare requiredTestLayers through rubrics:amend AND bind evidence carrying a matching details.adequacy.testLayer. '
      + 'Declaring layers alone does not clear this — it trades it for the strictly harder bar_snapshot_proof_inadequate, '
      + 'and a top-level details.testLayer is not read (only the nested details.adequacy is). '
      + 'The required BAR amendment advances the rubric meaning revision and can invalidate an existing independent '
      + 'grading card and vetting attestation; batch this change before commissioning those artifacts, or expect to re-grade and re-vet.',
    bar_snapshot_proof_inadequate:
      'Run plans:evaluate-spec-test-adequacy for the mapped outcome with current fingerprints; fix every fail/unknown proof obligation before ship. '
      + 'A read-only shipReadiness probe supplies no current fingerprints, so freshness rates unknown and this code can persist however good the evidence is — '
      + 'supply current fingerprints before concluding the evidence itself is at fault.',
    bar_snapshot_evidence_plane_unmet: "Record current evidence on the BAR's declared evidence plane.",
    bar_snapshot_evidence_runtime_unmet:
      "Measure on the BAR's declared evidenceRuntime (dev:pipeline_position servingRuntimes names its build) and bind evidence with details.runtime set to it — green main is only required when that runtime IS release-operator.",
  };
  return { code, barKey: bar?.barKey ?? null, action: actions[code] };
}

/** Pure projection. The same source rows always produce byte-identical contentHash. */
export function projectAcceptanceBarContractSnapshot(
  input: AcceptanceBarContractSnapshotInput,
): AcceptanceBarContractSnapshot {
  const problems: AcceptanceBarSnapshotProblem[] = [];
  for (const [source, detail] of Object.entries(input.readFailures ?? {}) as Array<
    [AcceptanceBarSnapshotSource, string]
  >) {
    if (!detail) continue;
    addProblem(problems, {
      code: 'bar_snapshot_source_unavailable',
      source,
      severity: 'error',
      detail,
    });
  }

  const boundedInputs = [
    ['plan', input.planRows],
    ['rubric', input.rubrics],
    ['plan-items', input.planItems],
    ['clauses', input.clauses],
    ['work-contracts', input.workContracts],
    ['evidence', input.evidence],
    ['grading', input.scorecards],
    ['vetting', input.vettingScorecards],
  ] as const;
  for (const [source, read] of boundedInputs) {
    if (!read.truncated) continue;
    addProblem(problems, {
      code: 'bar_snapshot_source_truncated',
      source,
      severity: 'error',
      detail: `${source} read reached its ${read.limit}-row contract limit`,
    });
  }
  if (input.lineage.truncated) {
    addProblem(problems, {
      code: 'bar_snapshot_source_truncated',
      source: 'lineage',
      severity: 'error',
      detail: `lineage read reached its ${input.lineage.rowLimit}-row contract limit`,
    });
  }

  const plan = input.planRows.rows[0] ?? null;
  if (!plan) {
    addProblem(problems, {
      code: 'bar_snapshot_plan_missing',
      source: 'plan',
      severity: 'error',
      detail: 'canonical subject plan row is absent',
    });
  }
  if (input.planRows.truncated || input.planRows.rows.length > 1) {
    addProblem(problems, {
      code: 'bar_snapshot_plan_ambiguous',
      source: 'plan',
      severity: 'error',
      detail: 'more than one subject plan row matched the slug',
    });
  }
  const applicable = plan?.adoptionEpoch != null;
  if (
    applicable &&
    (plan?.adoptionEpoch !== ACCEPTANCE_BAR_CONTRACT_EPOCH || !plan.cohort || !plan.seededAt || !plan.seededBy)
  ) {
    addProblem(problems, {
      code: 'bar_snapshot_cohort_incomplete',
      source: 'plan',
      severity: 'error',
      detail: 'post-epoch subject plan lacks a complete server-owned cohort/seed identity',
    });
  }

  // P-002 / D-002. Two different facts used to collapse into one accusatory code.
  // `rubric_missing` says the author never wrote a rubric; the resolver only ever
  // knows that its read produced nothing. When the plan itself PINS a rubric slug,
  // or the rubric read failed outright, the honest report is UNRESOLVED — carrying
  // the pin so the reader can re-route instead of blaming the author.
  const rubricPin = plan?.rubricSlug?.trim() ? plan.rubricSlug.trim() : null;
  const rubricReadFailed = Boolean(input.readFailures?.rubric);
  const rubricUnresolved = applicable && input.rubrics.rows.length === 0 && (Boolean(rubricPin) || rubricReadFailed);
  if (rubricUnresolved) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_unresolved',
      source: 'rubric',
      severity: 'error',
      detail: rubricPin
        ? `subject plan pins acceptance rubric '${rubricPin}'` +
          `${plan?.rubricRevision == null ? '' : ` at revision ${plan.rubricRevision}`}` +
          ' but this read returned no rubric rows — the rubric could not be RESOLVED here, ' +
          'which is not evidence that none exists'
        : 'the acceptance-rubric read failed, so whether a rubric exists is UNKNOWN, not absent',
    });
  } else if (input.rubrics.rows.length === 0 && applicable) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_missing',
      source: 'rubric',
      severity: 'error',
      detail: 'post-epoch subject plan has no active acceptance rubric and pins none',
    });
  }
  if (input.rubrics.rows.length > 1 || input.rubrics.truncated) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_ambiguous',
      source: 'rubric',
      severity: 'error',
      detail: `subject plan has ${input.rubrics.rows.length}${input.rubrics.truncated ? '+' : ''} active acceptance rubrics`,
    });
  }
  const rubric = input.rubrics.rows.length === 1 && !input.rubrics.truncated ? input.rubrics.rows[0]! : null;
  if (
    applicable &&
    plan &&
    rubric &&
    (plan.rubricSlug !== rubric.rubricId ||
      plan.rubricRevision !== (rubric.revision ?? null) ||
      // A federated receiver's own verification pin replaces the author's local one.
      (plan.verifiedRevision ?? rubric.barContract?.subjectPlanRevision) !== plan.revision)
  ) {
    addProblem(problems, {
      code: 'bar_snapshot_rubric_revision_mismatch',
      source: 'rubric',
      severity: 'error',
      detail: 'subject-plan pins and current rubric/subject revisions do not agree',
    });
  }

  const rawCriteria = rubric?.criteria ?? [];
  const barCriteria = rawCriteria.filter((criterion) => criterion.barKey || criterion.barHash);
  // P-002: an unresolved rubric has an UNKNOWN bar set, not an empty one. Emitting
  // `bar_set_empty` here is the second half of the same false accusation — measured
  // together as `bar_set_empty, rubric_missing` against a rubric that was active
  // with six criteria at the time.
  if (applicable && barCriteria.length === 0 && !rubricUnresolved) {
    addProblem(problems, {
      code: 'bar_snapshot_bar_set_empty',
      source: 'rubric',
      severity: 'error',
      detail: 'post-epoch acceptance rubric contains zero BAR criteria',
    });
  }
  if (barCriteria.length > MAX_REQUIREMENT_BARS) {
    addProblem(problems, {
      code: 'bar_snapshot_bar_set_too_large',
      source: 'rubric',
      severity: 'error',
      detail: `rubric contains ${barCriteria.length} BARs; maximum is ${MAX_REQUIREMENT_BARS}`,
    });
  }
  const boundedCriteria = barCriteria.slice(0, MAX_REQUIREMENT_BARS);
  const seenBarKeys = new Set<string>();
  for (const criterion of boundedCriteria) {
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    if (seenBarKeys.has(barKey)) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_key_duplicate',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: `duplicate BAR key '${barKey}'`,
      });
    }
    seenBarKeys.add(barKey);
    if (!criterion.barHash) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_hash_missing',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: `BAR '${barKey}' has no server-derived hash`,
      });
      continue;
    }
    try {
      if (computeAcceptanceBarHash(criterion) !== criterion.barHash) {
        addProblem(problems, {
          code: 'bar_snapshot_bar_hash_mismatch',
          source: 'rubric',
          severity: 'error',
          barKey,
          detail: `BAR '${barKey}' meaning no longer matches its stored hash`,
        });
      }
    } catch (error) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_hash_mismatch',
        source: 'rubric',
        severity: 'error',
        barKey,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (applicable && boundedCriteria.length > 0 && boundedCriteria.every((criterion) => criterion.barHash)) {
    try {
      const computed = computeAcceptanceBarSetHash(boundedCriteria);
      if (computed !== plan?.barSetHash || computed !== rubric?.barSetHash) {
        addProblem(problems, {
          code: 'bar_snapshot_bar_set_hash_mismatch',
          source: 'rubric',
          severity: 'error',
          detail: 'recomputed BAR-set hash does not match both subject-plan and rubric pins',
        });
      }
    } catch (error) {
      addProblem(problems, {
        code: 'bar_snapshot_bar_set_hash_mismatch',
        source: 'rubric',
        severity: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const itemStatus = new Map(input.planItems.rows.map((item) => [item.itemId, item.status]));
  const grading = authoritativeGrading(input, rubric);
  const rubricRevision = rubric?.revision ?? null;
  const rubricCriteriaHash = rubric?.criteriaHash ?? null;
  const bars: AcceptanceBarTrace[] = [];
  for (const criterion of boundedCriteria
    .slice()
    .sort((a, b) => (a.barKey ?? a.key).localeCompare(b.barKey ?? b.key))) {
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    const clauses = input.clauses.rows
      .filter((clause) => clause.sourceBar?.barKey === barKey)
      .sort((a, b) => a.specId.localeCompare(b.specId));
    const enforceableClauses = clauses.filter((clause) => isEnforceableSpecLifecycle(clause.lifecycleStatus));
    // WI-10003187: mapped, but nothing enforceable yet. Every proof judgement below counts
    // only enforceable clauses, so for this BAR `currentEvidence` is empty by construction
    // and the adequacy checks have nothing to evaluate. Name the actual gap instead.
    const clauseAcceptance: NonNullable<AcceptanceBarTrace['readiness']['clauseAcceptance']> =
      clauses.length === 0 ? 'unmapped' : enforceableClauses.length > 0 ? 'accepted' : 'not-accepted';
    const clauseBehaviorClasses = [...new Set(enforceableClauses.map((clause) => clause.behaviorClass))];
    const behaviorClass: SpecBehaviorClass | null = clauseBehaviorClasses.length === 1
      ? clauseBehaviorClasses[0]!
      : null;
    // A generated delivery-plane BAR with no declared layers is a manual/operational
    // obligation. Any automated class, explicit layer, or mutation keeps the normal
    // adequacy floor in force; mixed projections fail closed rather than weakening it.
    //
    // A BAR whose author EXPLICITLY declared it manual (`check: {kind:'instrument',
    // instrumentKey:'none'}`) carries no automated proof obligation, whichever plane its
    // record lives on. Without this, `acceptanceBarBehaviorClass` projects every
    // `evidencePlane:'tree'` clause as `happy-path`, so a manual BAR could never satisfy
    // the adequacy floor: `adequacyState` is `undeclared` while `requiredTestLayers` is
    // empty, and the only escapes were to declare test layers a document-census criterion
    // does not have, or to demote a mandatory outcome to `disclosure`. Both are false
    // statements about the BAR, so the criterion was unshippable by construction.
    // Deliberately narrow, and fails closed: the criterion must itself declare no layers,
    // it must have clauses, and NO clause may declare a layer or a mutation obligation.
    const automatedProofRequired = projectedAutomatedProofRequired({
      instrumentKey: effectiveCriterionInstrumentKey(criterion),
      structuredTestsCheck: criterion.check?.kind === 'tests',
      criterionTestLayers: criterion.requiredTestLayers,
      clauses: enforceableClauses,
    });
    const mappings = clauses.map((clause) => ({
      planItemId: clause.planItemId,
      planItemStatus: itemStatus.get(clause.planItemId) ?? null,
      specId: clause.specId,
      sourceValId: clause.sourceValId ?? null,
      specRevision: clause.revision,
      specContentHash: clause.contentHash,
      sourceBarHash: clause.sourceBar?.barHash ?? null,
      sourceBarSetHash: clause.sourceBar?.barSetHash ?? null,
      sourceRubricRevision: clause.sourceBar?.rubricRevision ?? null,
      evidencePlane: clause.sourceBar?.evidencePlane ?? null,
      lifecycleStatus: clause.lifecycleStatus,
    }));
    const contracts = clauses
      .flatMap((clause) =>
        input.workContracts.rows
          .filter((edge) => edge.planSlug === clause.planSlug && edge.specId === clause.specId)
          .map((edge) => ({
            workItemId: edge.workItemId,
            specId: edge.specId,
            specRevision: edge.specRevision,
            specFingerprint: edge.specFingerprint,
            current: edge.specRevision === clause.revision && edge.specFingerprint === clause.contentHash,
          })),
      )
      .sort((a, b) => `${a.workItemId}\0${a.specId}`.localeCompare(`${b.workItemId}\0${b.specId}`));
    const evidence = clauses.flatMap((clause) =>
      input.evidence.rows.filter((row) => row.planSlug === clause.planSlug && row.specId === clause.specId),
    );
    const activeEvidence = activeSpecEvidence(evidence);
    const currentEvidence = activeEvidence.filter((row) =>
      enforceableClauses.some(
        (clause) =>
          clause.specId === row.specId &&
          row.specRevision === clause.revision &&
          row.currentRevision === clause.revision &&
          row.specFingerprint === clause.contentHash &&
          row.currentness.overall !== 'stale',
      ),
    );
    const staleEvidence = activeEvidence.filter((row) => !currentEvidence.includes(row));
    const requiredTestLayers = normalized(criterion.requiredTestLayers);
    // The declared evidence plane is a separate lifecycle obligation. Adequacy
    // must inspect every current exact-cohort row because a BAR can require
    // mixed test layers (for example, tree/unit plus live/e2e). Filtering here
    // would drop the tree row before the evaluator can satisfy the full layer
    // contract; the ship-phase plane check below still requires current proof
    // on the BAR's declared plane.
    const classRef: PlanClassRubricRef = PLAN_CLASS_RUBRIC_REFS.includes(rubric?.classRef as PlanClassRubricRef)
      ? rubric!.classRef as PlanClassRubricRef : 'plan-class-feature-ship';
    const adequacyChecks = requiredTestLayers.length === 0 ? [] : enforceableClauses.map((clause) => {
      // A clause may add proof obligations above its BAR's minimum. Keep those
      // obligations when grading instead of replacing them with the BAR floor.
      const clauseTestLayers = normalized([...requiredTestLayers, ...clause.requiredTestLayers]);
      const result = evaluateSpecTestAdequacy({ clause: { ...clause, requiredTestLayers: clauseTestLayers },
        // Selection precedes freshness: a newer stale/unknown registered attempt
        // must not vanish and leave a passing counterexample to stand in for it.
        evidence, classRef, harness: plan.harnessSlug });
      return { specId: clause.specId, revision: clause.revision, verdict: result.verdict,
        wouldBlock: result.wouldBlock, evidenceRefs: result.evidenceRefs };
    });
    const adequacyState = requiredTestLayers.length === 0 ? 'undeclared' as const
      : adequacyChecks.some((check) => check.verdict === 'pass') ? 'pass' as const
        : adequacyChecks.some((check) => check.verdict === 'unknown') ? 'unknown' as const : 'fail' as const;
    const ratingEntry = grading.card?.ratings[criterion.key] as { rating?: string; evidence?: string } | undefined;
    const rating = ratingEntry?.rating?.trim() || null;
    const passRatings = normalized(criterion.passRatings).map((value) => value.toLowerCase());
    const gradingCurrent = classifyRubricEvidenceCurrentness(
      {
        revision: grading.card?.rubricRevision,
        criteriaHash: grading.card?.criteriaHash,
        meaningRevision: grading.card?.rubricMeaningRevision,
      },
      {
        revision: rubricRevision,
        criteriaHash: rubricCriteriaHash,
        meaningRevision: rubric?.barContract?.meaningRevision,
      },
    ).state === 'current';
    // D-030: a rating is a judgment about (rubric, evidence), but `gradingCurrent` above
    // tracks only the rubric half. So a NOT-PASS card whose cited basis was evidence
    // defects survives the repair of those defects forever: the rubric is untouched, so
    // the card stays `current`, so it stays `not-pass`, and plan-acceptance-gate.ts's
    // `if (!gradingMissing && !gradingStale) return refusal` returns BEFORE the recruiter
    // can summon the re-grade the BAR lifecycle explicitly asks for. That is a structural
    // dead end: satisfying the BAR cannot help either, because BAR satisfaction is not an
    // input here. Treat a not-pass card that never saw the current cohort as STALE — the
    // semantic the recruiter already honours ('Re-grade against the current rubric').
    //
    // WHY NOT-PASS AND NOT PASS. The asymmetry is defeasibility, not convenience: a
    // not-pass states a DEFEATER ("this evidence does not establish the outcome"), and new
    // evidence can FALSIFY that stated basis — the cited defect is gone, so the reason no
    // longer holds. A pass states the outcome WAS established, and later evidence does not
    // retract an establishment that already happened. Same code either way; do not
    // re-justify this by "only not-pass blocks", which argues from the fact that it unblocks
    // the implementer. NAMED GAP, deliberately out of scope: evidence that SUPERSEDES a
    // pass's basis (rather than adding to it) is a real hole this does not close.
    //
    // The trigger is COHORT IDENTITY, never a timestamp. `spec_evidence_bindings` is
    // append-only — enforced by the `spec_evidence_bindings_immutable` trigger, which raises
    // on DELETE and permits only a complete one-way retraction stamp — so the cohort a card
    // could have seen is reconstructible from `created_at` alone, retroactively and with no
    // schema change. Keying on "any row newer than the card" instead over-triggers ~3:1
    // (measured: 55 rebinds across two specs, one agent, one afternoon, of which only 19
    // moved the artifact set), because honest metadata repair rebinds the SAME artifact
    // repeatedly. That is the default behaviour of a careful implementer, not an attack, so
    // no cap can separate the two — comparing what a grader actually inspects does.
    // BOUNDED BY D-011, NOT AN OVERSIGHT — DO NOT "CLOSE" THIS BY FLIPPING `includeRetracted`.
    // `defaultReadEvidence` does not request retracted rows, so a retraction-only cohort
    // change is invisible here and will NOT stale. That fails CLOSED (the bar stays stuck, as
    // it does today) rather than open, which is the safe direction — but the reason it must
    // STAY closed AT THIS CALL SITE is stronger than "safe". `listSpecEvidence`'s
    // `includeRetracted` is documented "pass true only for an AUDIT read ... never from an
    // evaluator, a gate, or anything that counts evidence" (spec-evidence-store.ts, migration
    // 1174 / D-011). This read IS such a caller — MEASURED, not assumed: the very `evidence`
    // array fingerprinted below also feeds `activeEvidence`, `currentEvidence`, `staleEvidence`,
    // `proofState`, and the `supersededEvidence` COUNT. Re-admitting withdrawn bindings there
    // would re-brick exactly the clauses retraction exists to repair (one malformed binding
    // permanently fails its clause, and an appended correction cannot outrank it because this
    // loader has no DISTINCT ON) — trading a stuck bar for the mirror image of the gate evasion
    // D-011 forbids. A reviewer has already proposed a "retraction-aware refinement" here, so
    // the flag flip is a live temptation, not a hypothetical one.
    // The ONLY D-011-compatible route is a SEPARATE audit-scoped read feeding the cohort
    // fingerprint ALONE, with its rows provably unable to reach any counting path above — a
    // real change carrying its own test burden (including a guard that FAILS if retracted rows
    // ever reach the counting set), never a flag flip.
    // The identity tracks what a GRADER WOULD SEE, not what the writer DID — which is why
    // `createdAt` and `details` (writer-state) are out while the artifact is in. Execution
    // is the field where that rule is easiest to misapply, because a raw `testRunId` LOOKS
    // like evidence identity when it is really execution bookkeeping:
    //   - EXCLUDING execution entirely rebuilds the D-030 dead end one level down. Judges
    //     cite missing execution as the defect ("executable binding(s) attest execution
    //     details but have NO testRunId or coverageEvidenceRef ... author-attested booleans
    //     cannot establish execution-integrity"), so an implementer who finally RUNS the
    //     test — the one repair the gate asked for — would fingerprint identical to the
    //     unexecuted cohort and still not recruit.
    //   - INCLUDING the raw id re-opens the over-trigger: every idempotent re-run mints a
    //     new id, so re-running a green suite N times would re-roll a grader N times.
    // So normalize to the grader-visible bit: executed or not.
    // NAMED GAP (bounded follow-up): the fuller state is (hasExecution, verdict), so a
    // fail→pass or pass→fail flip on the SAME binding is not yet material here. The verdict
    // is not on the binding row (only testRunId/coverageEvidenceRef are) and needs a join
    // into the execution ledger; `hasExecution` alone already closes the dead end above and
    // is strictly better than excluding execution, so it ships without the verdict half.
    const cohortIdentity = (rows: readonly AcceptanceBarEvidenceSource[]): string => {
      const keys = new Set<string>();
      for (const row of rows) {
        const executed = row.testRunId !== null || row.coverageEvidenceRef !== null;
        // A path locates the evidence but does not identify its content. Operational
        // artifact hashes and repo-files source/test measurements are bound on this row.
        // Keep execution normalized to a boolean: rerunning unchanged content must not
        // repeatedly stale a non-pass grade just because testRunId changed.
        keys.add(JSON.stringify([
          row.specId,
          row.evidenceKind,
          row.evidenceRef,
          executed ? 'executed' : 'unexecuted',
          row.fingerprints.sourceFingerprint,
          row.fingerprints.testFingerprint ?? null,
        ]));
      }
      return [...keys].sort().join('\x01');
    };
    // Both sides are reconstructed from the RAW append-only rows, never from
    // `activeEvidence`: that set is already reduced to the newest row per identity, so
    // filtering IT by time drops a superseded row entirely and makes an ordinary
    // metadata-only rebind look like an emptied cohort. Same population, same reduction,
    // differing only in the time cut — so the two fingerprints are actually comparable.
    const gradedAt = grading.card ? Date.parse(grading.card.createdAt) : Number.NaN;
    const cohortWhenGraded = Number.isFinite(gradedAt)
      ? evidence.filter((row) => {
          const boundAt = Date.parse(row.createdAt);
          return Number.isFinite(boundAt) && boundAt <= gradedAt;
        })
      : [];
    const cohortChangedSinceGrading =
      Number.isFinite(gradedAt) && cohortIdentity(cohortWhenGraded) !== cohortIdentity(evidence);
    const gradingState: AcceptanceBarTrace['grading']['state'] = input.scorecards.truncated
      ? 'truncated'
      : !grading.card || !rating
        ? 'missing'
        : !gradingCurrent
          ? 'stale'
          : passRatings.includes(rating.toLowerCase())
            ? 'pass'
            : cohortChangedSinceGrading
              ? 'stale'
              : 'not-pass';
    const mappingState: AcceptanceBarTrace['readiness']['mapping'] =
      mappings.length === 0
        ? 'missing'
        : mappings.every((mapping) => mapping.planItemStatus === 'dropped')
          ? 'dropped-only'
          : 'live';
    const workContractState: AcceptanceBarTrace['readiness']['workContract'] =
      contracts.length === 0 ? 'missing' : contracts.some((contract) => contract.current) ? 'current' : 'stale';
    const proofState: AcceptanceBarTrace['proof']['state'] = input.evidence.truncated
      ? 'truncated'
      : currentEvidence.length > 0
        ? 'current'
        : staleEvidence.length > 0
          ? 'stale'
          : 'missing';
    const evidencePlanes = normalized(
      currentEvidence.flatMap((row) => {
        const details = row.details && typeof row.details === 'object'
          ? row.details as Record<string, unknown>
          : {};
        const plane = details.evidencePlane ?? details.evidence_plane ?? details.plane;
        return typeof plane === 'string' ? [plane] : [];
      }),
    );
    const codes: AcceptanceBarSnapshotCode[] = [];
    const addCode = (code: AcceptanceBarSnapshotCode) => {
      if (!codes.includes(code)) codes.push(code);
    };
    // EI-23525318282609167: the BAR-scoped integrity checks (hash missing/mismatch,
    // duplicate key) run in the source-completeness pass above and record a barKey
    // on every problem they emit. This per-BAR derivation used to be computed
    // INDEPENDENTLY of `problems`, so those codes reached the contract level and
    // never reached the BAR they name. Two consequences: nextRepair's
    // `bars.find(...)` matched nothing and reported barKey:null, and — worse — a BAR
    // whose meaning no longer matched its stored hash reported state:'ready'.
    // Measured live on acceptance-unified-requirement-contract-2026-09-05: six
    // mismatching BARs all read clean while the contract said "0 of 6 blocking".
    // Join by barKey instead of re-deriving the checks here, so a second source of
    // truth cannot drift from the first and any future barKey-carrying problem is
    // attributed without another hand-written copy.
    for (const problem of problems) {
      if (problem.barKey === barKey) addCode(problem.code);
    }
    if (!criterion.barProvenance) addCode('bar_snapshot_bar_provenance_missing');
    if (mappingState === 'missing') addCode('bar_snapshot_mapping_missing');
    if (mappingState === 'dropped-only') addCode('bar_snapshot_mapping_dropped_only');
    if (
      criterion.evidencePlane !== 'tree' &&
      !evidencePlanes.some((plane) => plane.toLowerCase() === criterion.evidencePlane)
    )
      addCode('bar_snapshot_evidence_plane_unmet');
    // P-001: a clause is stale when ITS OWN bar moved (bar hash, rubric, plane, layers),
    // never merely because the rubric-wide BAR set changed. An amendment deliberately
    // keeps an unchanged bar's clause at its revision, so that clause keeps the set hash
    // it was projected under; requiring it to equal the plan's current set hash would
    // re-create the exact churn P-001 removes. The set itself is still pinned: the
    // plan/rubric set-hash integrity check above (`bar_snapshot_bar_set_hash_mismatch`).
    if (
      enforceableClauses.some(
        (clause) =>
          clause.sourceBar?.barHash !== criterion.barHash ||
          clause.sourceBar?.rubricSlug !== rubric?.rubricId ||
          clause.sourceBar?.evidencePlane !== criterion.evidencePlane ||
          requiredTestLayers.some((layer) => !normalized(clause.requiredTestLayers).includes(layer)),
      )
    )
      addCode('bar_snapshot_projection_stale');
    if (!criterion.method?.trim()) addCode('bar_snapshot_method_missing');
    if (workContractState === 'missing') addCode('bar_snapshot_work_contract_missing');
    if (workContractState === 'stale') addCode('bar_snapshot_work_contract_stale');
    // A never-accepted clause REPLACES the stale/depth/adequacy verdicts rather than joining
    // them: those are judged against enforceable clauses only, so here they describe the
    // lifecycle gap, not the proof. `proof_missing` stays (no evidence at all is a real
    // obligation, and a lifecycle-only promotion carries whatever is bound), as does
    // truncation (an incomplete read is never a lifecycle fact).
    if (clauseAcceptance === 'not-accepted') addCode('bar_snapshot_clause_not_accepted');
    if (proofState === 'missing') addCode('bar_snapshot_proof_missing');
    if (proofState === 'truncated' || (proofState === 'stale' && clauseAcceptance !== 'not-accepted'))
      addCode('bar_snapshot_proof_stale');
    if (criterion.role === 'outcome' && automatedProofRequired && clauseAcceptance !== 'not-accepted') {
      if (adequacyState === 'undeclared') addCode('bar_snapshot_proof_depth_missing');
      else if (adequacyState !== 'pass') addCode('bar_snapshot_proof_inadequate');
    }
    // Disclosure criteria remain visible in the grading trace, but they do not
    // satisfy (or block) the ship floor. Requiring a pass-equivalent rating for a
    // non-mandatory disclosure is impossible when its authored passRatings is
    // deliberately empty, and contradicts the BAR validator's rule that only
    // mandatory outcomes carry the acceptance floor.
    const gatesShipping = criterion.role === 'outcome' && criterion.mandatory === true;
    if (gatesShipping && (gradingState === 'missing' || gradingState === 'truncated'))
      addCode('bar_snapshot_grading_missing');
    if (gatesShipping && gradingState === 'stale') addCode('bar_snapshot_grading_stale');
    if (gatesShipping && gradingState === 'not-pass') addCode('bar_snapshot_grading_not_pass');

    bars.push({
      barKey,
      criterionKey: criterion.key,
      title: criterion.title,
      requirement: requirementSections(criterion),
      barHash: criterion.barHash ?? null,
      model: criterion.model ?? criterion.bar ?? '',
      method: criterion.method ?? '',
      check: criterion.check ?? null,
      replication: criterion.replication ?? null,
      falsifier: criterion.driftMarkers ?? '',
      role: criterion.role ?? null,
      mandatory: criterion.mandatory ?? null,
      requiredScope: normalized(criterion.requiredScope),
      evidencePlane: criterion.evidencePlane ?? null,
      evidenceRuntime: resolveBarEvidenceRuntime(criterion),
      behaviorClass,
      mutationRequired: enforceableClauses.some((clause) => clause.mutationRequired),
      automatedProofRequired,
      requiredTestLayers,
      passRatings: normalized(criterion.passRatings),
      coversBarKeys: normalized(criterion.coversBarKeys),
      provenance: criterion.barProvenance ?? null,
      mappings,
      workContracts: contracts,
      proof: {
        state: proofState,
        history: evidence.slice().sort((a, b) =>
          `${a.observedAt}\0${a.id}`.localeCompare(`${b.observedAt}\0${b.id}`)).map((row) => ({
          id: row.id, workItemId: row.workItemId, specId: row.specId, specRevision: row.specRevision,
          currentRevision: row.currentRevision,
          specFingerprint: row.specFingerprint, evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
          testRunId: row.testRunId, observedAt: row.observedAt, createdBy: row.createdBy,
          details: row.details, currentness: row.currentness,
          activeAttempt: activeEvidence.includes(row),
          matchesCurrentSpec: clauses.some((clause) => clause.specId === row.specId &&
            clause.revision === row.specRevision && clause.contentHash === row.specFingerprint),
        })),
        currentEvidence: currentEvidence.length,
        staleEvidence: staleEvidence.length,
        supersededEvidence: evidence.length - activeEvidence.length,
        kinds: normalized(evidence.map((row) => row.evidenceKind)),
        evidenceRefs: normalized(evidence.map((row) => row.evidenceRef)),
        adequacy: { state: adequacyState, checks: adequacyChecks },
        // WI-2146375: `unknown` is what the classifier returns when the READER supplied no
        // current-fingerprint input, not a property of the evidence. `source_fingerprint` is
        // NOT NULL, and `defaultReadEvidence` passes no `current`, so counting bare `unknown`
        // here made `bar_snapshot_proof_uncertain` fire on EVERY bound row — which, since the
        // empty-evidence case already raises `bar_snapshot_proof_missing`, left the ship gate
        // with no satisfiable state at all. Only a reader that actually ASKED can be uncertain.
        // Only evidence for the current exact spec cohort can make the current proof
        // uncertain. Historical rows remain in `history`, but a superseded revision
        // with an unmeasurable legacy dimension must not poison newer complete proof.
        uncertainEvidence: currentEvidence.filter((row) => {
          const currentness = (
            row as {
              currentness?: { overall?: string; dimensions?: Record<string, string>; comparisonSupplied?: boolean };
            }
          ).currentness;
          if (currentness?.comparisonSupplied !== true) return false;
          return (
            currentness.overall === 'unknown' ||
            Object.values(currentness.dimensions ?? {}).some((value) => value === 'unknown')
          );
        }).length,
        evidencePlanes,
        evidenceRuntimes: normalized(
          currentEvidence.flatMap((row) => {
            const runtime = evidenceRuntimeOf(
              row.details && typeof row.details === 'object' ? (row.details as Record<string, unknown>) : null,
            );
            return runtime ? [runtime] : [];
          }),
        ),
        runtimeAbsent: normalized(
          currentEvidence.flatMap((row) => {
            const details =
              row.details && typeof row.details === 'object' ? (row.details as Record<string, unknown>) : null;
            const runtime = evidenceRuntimeOf(details);
            return runtime && evidenceRecordsAbsent(details) ? [runtime] : [];
          }),
        ),
      },
      grading: {
        state: gradingState,
        history: input.scorecards.rows
          .filter((card) => card.ratings[criterion.key] || scorecardAcceptance(card))
          .slice().sort((a, b) => `${a.createdAt}\0${a.issueId}`.localeCompare(`${b.createdAt}\0${b.issueId}`))
          .map((card) => {
            const entry = card.ratings[criterion.key];
            const acceptance = scorecardAcceptance(card);
            return {
              scorecardId: card.issueId, createdAt: card.createdAt, createdBy: card.createdBy,
              rubricRevision: card.rubricRevision ?? null, criteriaHash: card.criteriaHash ?? null,
              role: grading.roleOf(card),
              authoritative: card.issueId === grading.card?.issueId || card.issueId === grading.authorVerdict?.issueId,
              currentRevision: classifyRubricEvidenceCurrentness(
                {
                  revision: card.rubricRevision,
                  criteriaHash: card.criteriaHash,
                  meaningRevision: card.rubricMeaningRevision,
                },
                {
                  revision: rubricRevision,
                  criteriaHash: rubricCriteriaHash,
                  meaningRevision: rubric?.barContract?.meaningRevision,
                },
              ).state === 'current', complete: completeScorecard(card),
              retracted: Boolean(card.retracted), supersedes: card.supersedes ?? null,
              supersededBy: card.supersededBy ?? null, selectedVia: gradingViaOf(card, input.graderSelectionVia),
              rating: entry?.rating ?? null, evidence: entry?.evidence ?? null,
              authorVerdict: acceptance?.verdict ?? null, reasoning: acceptance?.reasoning ?? null,
            };
          }),
        scorecardId: grading.card?.issueId ?? null,
        rubricRevision: grading.card?.rubricRevision ?? null,
        criteriaHash: grading.card?.criteriaHash ?? null,
        gradedBy: grading.card?.createdBy ?? null,
        selectedVia: grading.via,
        rating,
        evidence: ratingEntry?.evidence ?? null,
      },
      readiness: {
        state: codes.length === 0 ? 'ready' : 'blocked',
        codes,
        mapping: mappingState,
        method: criterion.method?.trim() ? 'declared' : 'missing',
        workContract: workContractState,
        clauseAcceptance,
      },
    });
  }

  const currentVetting = input.vettingScorecards.rows
    .filter(
      (card) =>
        completeScorecard(card) &&
        Boolean(card.vetting?.consultId || card.vetting?.workItemId) &&
        classifyRubricEvidenceCurrentness(
          {
            revision: card.vetting?.rubricRevision,
            criteriaHash: card.vetting?.criteriaHash,
            meaningRevision: card.vetting?.rubricMeaningRevision,
          },
          {
            revision: rubricRevision,
            criteriaHash: rubricCriteriaHash,
            meaningRevision: rubric?.barContract?.meaningRevision,
          },
        ).state === 'current' &&
        !card.supersededBy,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const anyVetting = input.vettingScorecards.rows
    .filter((card) => completeScorecard(card) && Boolean(card.vetting?.consultId || card.vetting?.workItemId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const vettingState: AcceptanceBarContractSnapshot['grading']['vetting']['state'] = input.vettingScorecards.truncated
    ? 'truncated'
    : currentVetting
      ? 'current'
      : anyVetting
        ? 'stale'
        : 'missing';
  const authorAcceptance = grading.authorVerdict ? scorecardAcceptance(grading.authorVerdict) : null;
  const authorVerdictState: AcceptanceBarContractSnapshot['grading']['authorVerdict']['state'] = !grading.authorVerdict
    ? 'missing'
    : grading.card && Date.parse(grading.authorVerdict.createdAt) < Date.parse(grading.card.createdAt)
      ? 'stale'
      : authorAcceptance?.verdict === 'reject'
        ? 'rejected'
        : authorAcceptance?.verdict === 'accept'
          ? 'accepted'
          : authorAcceptance?.verdict === 'accept-pending-delivery'
            ? 'accepted-pending-delivery'
            : 'missing';

  const allCodes = [
    ...problems.map((problem) => problem.code),
    ...bars.flatMap((bar) => bar.readiness.codes),
    ...(rubric && rubric.criteria.length > 0
      ? [
          ...(vettingState === 'missing' || vettingState === 'truncated'
            ? ['bar_snapshot_vetting_missing' as const]
            : []),
          ...(vettingState === 'stale' ? ['bar_snapshot_vetting_stale' as const] : []),
        ]
      : []),
    ...(grading.card
      ? [
          ...(authorVerdictState === 'missing' ? ['bar_snapshot_author_verdict_missing' as const] : []),
          ...(authorVerdictState === 'stale' ? ['bar_snapshot_author_verdict_stale' as const] : []),
          ...(authorVerdictState === 'rejected' ? ['bar_snapshot_author_rejected' as const] : []),
          ...(authorVerdictState === 'accepted-pending-delivery'
            ? ['bar_snapshot_author_accepted_pending_delivery' as const]
            : []),
        ]
      : []),
  ];
  const codes = [...new Set(allCodes)];
  const truncated =
    barCriteria.length > MAX_REQUIREMENT_BARS ||
    problems.some((problem) => problem.code === 'bar_snapshot_source_truncated');
  const base = {
    schemaVersion: ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
    planSlug: plan?.planSlug ?? '',
    applicable,
    plan,
    rubric: rubric
      ? {
          rubricId: rubric.rubricId,
          revision: rubric.revision ?? null,
          criteriaHash: rubric.criteriaHash ?? null,
          barSetHash: rubric.barSetHash ?? null,
          contract: rubric.barContract ?? null,
          createdBy: rubric.createdBy ?? rubric.proposedBy ?? null,
          ratingScale: [...rubric.ratingScale],
          classRef: rubric.classRef ?? null,
        }
      : null,
    sourceRevisions: {
      subjectPlan: plan?.revision ?? null,
      rubricPlan: rubric?.revision ?? null,
      clauses: input.clauses.rows
        .map((clause) => ({ specId: clause.specId, revision: clause.revision, contentHash: clause.contentHash }))
        .sort((a, b) => a.specId.localeCompare(b.specId)),
      workContracts: input.workContracts.rows
        .map((edge) => ({
          workItemId: edge.workItemId,
          specId: edge.specId,
          revision: edge.specRevision,
          fingerprint: edge.specFingerprint,
        }))
        .sort((a, b) => `${a.workItemId}\0${a.specId}`.localeCompare(`${b.workItemId}\0${b.specId}`)),
      scorecardIds: input.scorecards.rows.map((card) => card.issueId).sort(),
    },
    bounded: {
      plans: { rowsRead: input.planRows.rows.length, limit: input.planRows.limit, truncated: input.planRows.truncated },
      rubrics: { rowsRead: input.rubrics.rows.length, limit: input.rubrics.limit, truncated: input.rubrics.truncated },
      planItems: {
        rowsRead: input.planItems.rows.length,
        limit: input.planItems.limit,
        truncated: input.planItems.truncated,
      },
      clauses: { rowsRead: input.clauses.rows.length, limit: input.clauses.limit, truncated: input.clauses.truncated },
      workContracts: {
        rowsRead: input.workContracts.rows.length,
        limit: input.workContracts.limit,
        truncated: input.workContracts.truncated,
      },
      evidence: {
        rowsRead: input.evidence.rows.length,
        limit: input.evidence.limit,
        truncated: input.evidence.truncated,
      },
      scorecards: {
        rowsRead: input.scorecards.rows.length,
        limit: input.scorecards.limit,
        truncated: input.scorecards.truncated,
      },
      vetting: {
        rowsRead: input.vettingScorecards.rows.length,
        limit: input.vettingScorecards.limit,
        truncated: input.vettingScorecards.truncated,
      },
      lineage: {
        rowsRead: input.lineage.workItemRowsRead + input.lineage.auditRowsRead,
        limit: input.lineage.rowLimit,
        truncated: input.lineage.truncated,
      },
    },
    completeness: {
      complete: problems.every((problem) => problem.severity !== 'error'),
      truncated,
      problems: problems.sort((a, b) =>
        `${a.source}\0${a.barKey ?? ''}\0${a.code}`.localeCompare(`${b.source}\0${b.barKey ?? ''}\0${b.code}`),
      ),
    },
    lineage: {
      identities: [...input.lineage.identities].sort(),
      parties: [...input.partyByIdentity.entries()]
        .map(([identity, party]) => ({ identity, party }))
        .sort((a, b) => a.identity.localeCompare(b.identity)),
      complete: !input.lineage.truncated && !input.readFailures?.lineage && !input.readFailures?.['lineage-parties'],
    },
    grading: {
      authoritativeScorecardId: grading.card?.issueId ?? null,
      gradedBy: grading.card?.createdBy ?? null,
      selectedVia: grading.via,
      rubricRevision: grading.card?.rubricRevision ?? null,
      criteriaHash: grading.card?.criteriaHash ?? null,
      vetting: {
        state: vettingState,
        scorecardId: currentVetting?.issueId ?? anyVetting?.issueId ?? null,
        rubricRevision: currentVetting?.vetting?.rubricRevision ?? anyVetting?.vetting?.rubricRevision ?? null,
        criteriaHash: currentVetting?.vetting?.criteriaHash ?? anyVetting?.vetting?.criteriaHash ?? null,
      },
      authorVerdict: {
        state: authorVerdictState,
        scorecardId: grading.authorVerdict?.issueId ?? null,
        verdict: authorAcceptance?.verdict ?? null,
        createdBy: grading.authorVerdict?.createdBy ?? null,
        rubricRevision: grading.authorVerdict?.rubricRevision ?? null,
        criteriaHash: grading.authorVerdict?.criteriaHash ?? null,
        supersedes: grading.authorVerdict?.supersedes ?? null,
        reasoning: authorAcceptance?.reasoning ?? null,
      },
    },
    bars,
    readiness: {
      state: !applicable ? ('not-applicable' as const) : codes.length === 0 ? ('ready' as const) : ('blocked' as const),
      codes,
      nextRepair: nextRepair(codes, bars),
    },
  };
  return { ...base, contentHash: contentHash(base) };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function captured<T>(
  source: AcceptanceBarSnapshotSource,
  read: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; failure?: [AcceptanceBarSnapshotSource, string] }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { value: fallback, failure: [source, errorText(error)] };
  }
}

async function defaultReadPlans(planSlug: string, scope?: { harnessSlug: string }): Promise<BoundedAcceptanceBarRows<AcceptanceBarSubjectPlanSource>> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const rows = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      plan_slug: string;
      status: string | null;
      version: number | string;
      content_hash: string | null;
      acceptance_bar_epoch: number | string | null;
      acceptance_bar_cohort: AcceptanceBarCohort | null;
      acceptance_bar_set_hash: string | null;
      acceptance_bar_rubric_slug: string | null;
      acceptance_bar_rubric_revision: number | string | null;
      acceptance_bar_seeded_at: Date | string | null;
      acceptance_bar_seeded_by: string | null;
      acceptance_bar_verified_revision: number | string | null;
    }>
  >`
    SELECT workspace_id, harness_slug, plan_slug, status, version, content_hash,
           acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_set_hash,
           acceptance_bar_rubric_slug, acceptance_bar_rubric_revision,
           acceptance_bar_seeded_at, acceptance_bar_seeded_by, acceptance_bar_verified_revision
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${planSlug}
       AND ${scope ? sql`harness_slug = ${scope.harnessSlug}` : sql`TRUE`}
     ORDER BY updated_at DESC NULLS LAST, harness_slug
     LIMIT ${2}`;
  return bounded(
    rows.map((row) => ({
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
      planSlug: row.plan_slug,
      status: row.status,
      revision: Number(row.version),
      contentHash: row.content_hash,
      adoptionEpoch: row.acceptance_bar_epoch == null ? null : Number(row.acceptance_bar_epoch),
      cohort: row.acceptance_bar_cohort,
      barSetHash: row.acceptance_bar_set_hash,
      rubricSlug: row.acceptance_bar_rubric_slug,
      rubricRevision: row.acceptance_bar_rubric_revision == null ? null : Number(row.acceptance_bar_rubric_revision),
      seededAt: pgTimestampToIsoOrNull(row.acceptance_bar_seeded_at),
      seededBy: row.acceptance_bar_seeded_by,
      verifiedRevision:
        row.acceptance_bar_verified_revision == null ? null : Number(row.acceptance_bar_verified_revision),
    })),
    1,
  );
}

async function defaultReadRubrics(planSlug: string, scope?: { harnessSlug: string }): Promise<BoundedAcceptanceBarRows<Rubric>> {
  const rows = await getAcceptanceRubricsForPlan(planSlug, {
    limit: ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT + 1,
    strict: true,
    ...(scope ? { harnessSlug: scope.harnessSlug } : {}),
  });
  return bounded(rows, ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
}

async function defaultReadPlanItems(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<AcceptanceBarPlanItemSource>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ item_id: string; status: string }>>`
    SELECT item_id, status
      FROM harness_shared.plan_items
     WHERE workspace_id = ${plan.workspaceId}
       AND harness_slug = ${plan.harnessSlug}
       AND plan_slug = ${plan.planSlug}
     ORDER BY seq
     LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT + 1}`;
  return bounded(
    rows.map((row) => ({ itemId: row.item_id, status: row.status })),
    ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT,
  );
}

async function defaultReadClauses(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<SpecClauseRevision>> {
  // Scope to the subject row's OWN workspace, like every other reader here. Without it the
  // operator-home harness resolves to PAPERCUSP_WORKSPACE_ID and a plan stored elsewhere
  // reads zero clauses, so every BAR reports bar_snapshot_mapping_missing (WI-10005140).
  const rows = await listSpecClauses({
    workspaceId: plan.workspaceId,
    harnessSlug: plan.harnessSlug,
    planSlug: plan.planSlug,
    limit: MAX_BAR_PROJECTION_EDGES + 1,
  });
  return bounded(rows, MAX_BAR_PROJECTION_EDGES);
}

async function defaultReadWorkContracts(
  plan: AcceptanceBarSubjectPlanSource,
): Promise<BoundedAcceptanceBarRows<AcceptanceBarWorkContractSource>> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      work_item_id: string;
      plan_slug: string;
      spec_id: string;
      spec_revision: number | string;
      spec_fingerprint: string;
    }>
  >`
    SELECT work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint
      FROM harness_shared.work_item_spec_revision_edges
     WHERE workspace_id = ${plan.workspaceId}
       AND harness_slug = ${plan.harnessSlug}
       AND plan_slug = ${plan.planSlug}
     ORDER BY work_item_id, spec_id, spec_revision
     LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
  return bounded(
    rows.map((row) => ({
      workItemId: row.work_item_id,
      planSlug: row.plan_slug,
      specId: row.spec_id,
      specRevision: Number(row.spec_revision),
      specFingerprint: row.spec_fingerprint,
    })),
    MAX_BAR_PROJECTION_EDGES,
  );
}

async function defaultReadEvidence(
  plan: AcceptanceBarSubjectPlanSource,
  current?: EvidenceCurrentInput[],
): Promise<BoundedAcceptanceBarRows<AcceptanceBarEvidenceSource>> {
  const rows = await listSpecEvidence({
    harnessSlug: plan.harnessSlug,
    planSlugs: [plan.planSlug],
    current,
    limit: ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT + 1,
  });
  return bounded(rows, ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT);
}

async function defaultReadLineage(plan: AcceptanceBarSubjectPlanSource): Promise<AcceptanceBarLineageSource> {
  const { sql } = getOrgPg();
  const [workItems, audits] = await Promise.all([
    sql<
      Array<{
        terminal_owner: string | null;
        taken_by: string | null;
        last_released_by: string | null;
        worked_by_history: unknown;
      }>
    >`
      SELECT terminal_owner, taken_by, last_released_by, worked_by_history
        FROM harness_shared.work_items
       WHERE workspace_id = ${plan.workspaceId}
         AND source_plan_slug = ${plan.planSlug}
       ORDER BY feature_id
       LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT + 1}`,
    sql<Array<{ created_by: string | null }>>`
      SELECT created_by
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${plan.workspaceId}
         AND plan_slug = ${plan.planSlug}
         AND audit_kind IN ('activation', 'completion')
       ORDER BY audit_seq
       LIMIT ${ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT + 1}`,
  ]);
  const identities = new Set<string>();
  const add = (value: string | null | undefined) => {
    const id = value?.trim() ?? '';
    if (id) identities.add(id);
  };
  for (const row of workItems.slice(0, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT)) {
    add(row.terminal_owner);
    add(row.taken_by);
    add(row.last_released_by);
    if (row.worked_by_history != null && !Array.isArray(row.worked_by_history)) {
      throw new Error(`acceptance_lineage_unreadable: work item history for '${plan.planSlug}' is not an array`);
    }
    for (const owner of parseWorkedByHistory(row.worked_by_history)) add(owner);
  }
  for (const row of audits.slice(0, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT)) add(row.created_by);
  return {
    identities: [...identities].sort(),
    workItemRowsRead: Math.min(workItems.length, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT),
    auditRowsRead: Math.min(audits.length, ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT),
    rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
    truncated:
      workItems.length > ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT ||
      audits.length > ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
  };
}

async function defaultReadScorecards(rubric: Rubric): Promise<BoundedAcceptanceBarRows<ScorecardRow>> {
  const page = await listScorecardPage({
    rubricRef: rubric.rubricId,
    includeSuperseded: true,
    includeRetracted: true,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  });
  return {
    rows: page.rows,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
    truncated: page.hasMore,
  };
}

async function defaultReadVettingScorecards(rubric: Rubric): Promise<BoundedAcceptanceBarRows<ScorecardRow>> {
  const page = await listScorecardPage({
    rubricRef: 'meta-acceptance-rubric',
    subjectRef: rubric.rubricId,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  });
  return {
    rows: page.rows,
    limit: ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
    truncated: page.hasMore,
  };
}

const DEFAULT_DEPS: AcceptanceBarSnapshotDeps = {
  readPlans: defaultReadPlans,
  readRubrics: defaultReadRubrics,
  readPlanItems: defaultReadPlanItems,
  readClauses: defaultReadClauses,
  readWorkContracts: defaultReadWorkContracts,
  readEvidence: defaultReadEvidence,
  readLineage: defaultReadLineage,
  readScorecards: defaultReadScorecards,
  readVettingScorecards: defaultReadVettingScorecards,
  readParties: (identities, workspaceId) => lineagePartyKeys(identities, { workspaceId }),
  readGraderSelectionVia,
};

/**
 * Read every source in two fixed batches (identity, then rubric-addressed rows) and
 * build the pure snapshot. No reader is called per BAR; every collection is capped
 * with an over-fetch row so truncation is data, never inference.
 */
export async function readAcceptanceBarContractSnapshot(
  planSlug: string,
  deps: Partial<AcceptanceBarSnapshotDeps> = {},
  options: { current?: EvidenceCurrentInput[]; harnessSlug?: string } = {},
): Promise<AcceptanceBarContractSnapshot> {
  const d: AcceptanceBarSnapshotDeps = { ...DEFAULT_DEPS, ...deps };
  const failures: Partial<Record<AcceptanceBarSnapshotSource, string>> = {};
  const [planRead, rubricRead] = await Promise.all([
    captured('plan', () => options.harnessSlug ? d.readPlans(planSlug, { harnessSlug: options.harnessSlug }) : d.readPlans(planSlug), emptyBounded<AcceptanceBarSubjectPlanSource>(1)),
    captured(
      'rubric',
      () => options.harnessSlug ? d.readRubrics(planSlug, { harnessSlug: options.harnessSlug }) : d.readRubrics(planSlug),
      emptyBounded<Rubric>(ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT),
    ),
  ]);
  if (planRead.failure) failures[planRead.failure[0]] = planRead.failure[1];
  if (rubricRead.failure) failures[rubricRead.failure[0]] = rubricRead.failure[1];
  const plan = planRead.value.rows[0] ?? null;
  const rubric = rubricRead.value.rows.length === 1 && !rubricRead.value.truncated ? rubricRead.value.rows[0]! : null;

  const emptyPlanItems = emptyBounded<AcceptanceBarPlanItemSource>(ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT);
  const emptyClauses = emptyBounded<SpecClauseRevision>(MAX_BAR_PROJECTION_EDGES);
  const emptyContracts = emptyBounded<AcceptanceBarWorkContractSource>(MAX_BAR_PROJECTION_EDGES);
  const emptyEvidence = emptyBounded<AcceptanceBarEvidenceSource>(ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT);
  const emptyScorecards = emptyBounded<ScorecardRow>(ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT);
  const emptyLineage: AcceptanceBarLineageSource = {
    identities: [],
    workItemRowsRead: 0,
    auditRowsRead: 0,
    rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
    truncated: false,
  };
  const [planItems, clauses, workContracts, evidence, lineage, scorecards, vetting] = await Promise.all([
    captured('plan-items', () => (plan ? d.readPlanItems(plan) : Promise.resolve(emptyPlanItems)), emptyPlanItems),
    captured('clauses', () => (plan ? d.readClauses(plan) : Promise.resolve(emptyClauses)), emptyClauses),
    captured(
      'work-contracts',
      () => (plan ? d.readWorkContracts(plan) : Promise.resolve(emptyContracts)),
      emptyContracts,
    ),
    captured('evidence', () => (plan ? d.readEvidence(plan, options.current) : Promise.resolve(emptyEvidence)), emptyEvidence),
    captured('lineage', () => (plan ? d.readLineage(plan) : Promise.resolve(emptyLineage)), emptyLineage),
    captured('grading', () => (rubric ? d.readScorecards(rubric) : Promise.resolve(emptyScorecards)), emptyScorecards),
    captured(
      'vetting',
      () => (rubric ? d.readVettingScorecards(rubric) : Promise.resolve(emptyScorecards)),
      emptyScorecards,
    ),
  ]);
  for (const result of [planItems, clauses, workContracts, evidence, lineage, scorecards, vetting]) {
    if (result.failure) failures[result.failure[0]] = result.failure[1];
  }

  const partyIds = [
    ...(rubric ? [rubric.createdBy, rubric.proposedBy] : []),
    ...lineage.value.identities,
    ...scorecards.value.rows.map((card) => card.createdBy),
  ].filter((value): value is string => Boolean(value?.trim()));
  const [parties, selectionVia] = await Promise.all([
    captured(
      'lineage-parties',
      () => (plan ? d.readParties(partyIds, plan.workspaceId) : Promise.resolve(new Map<string, string>())),
      new Map<string, string>(),
    ),
    captured(
      'grading',
      () => (rubric ? d.readGraderSelectionVia(rubric.workspaceId, rubric.rubricId) : Promise.resolve(new Map())),
      new Map<string, SelectionVia>(),
    ),
  ]);
  if (parties.failure) failures[parties.failure[0]] = parties.failure[1];
  if (selectionVia.failure) failures[selectionVia.failure[0]] = selectionVia.failure[1];

  const snapshot = projectAcceptanceBarContractSnapshot({
    planRows: planRead.value,
    rubrics: rubricRead.value,
    planItems: planItems.value,
    clauses: clauses.value,
    workContracts: workContracts.value,
    evidence: evidence.value,
    scorecards: scorecards.value,
    vettingScorecards: vetting.value,
    lineage: lineage.value,
    partyByIdentity: parties.value,
    graderSelectionVia: selectionVia.value,
    readFailures: failures,
  });
  return snapshot.planSlug ? snapshot : { ...snapshot, planSlug };
}

export type AcceptanceBarDiffKind =
  | 'added'
  | 'removed'
  | 'bar-meaning'
  | 'method-only'
  | 'mapping'
  | 'evidence-plane'
  | 'provenance-cohort';

export interface AcceptanceBarContractDiff {
  schemaVersion: 1;
  operation: 'compare' | 'seed' | 'amend' | 'migration';
  beforeHash: string | null;
  afterHash: string;
  changed: boolean;
  requiresAmendment: boolean;
  changes: Array<{
    barKey: string;
    kinds: AcceptanceBarDiffKind[];
    fields: string[];
  }>;
  contentHash: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Pure semantic diff used by seed/amend/migration dry-runs. */
export type AcceptanceBarContractDiffView = Pick<AcceptanceBarContractSnapshot, 'contentHash'> & {
  plan: Pick<AcceptanceBarSubjectPlanSource, 'cohort' | 'adoptionEpoch'> | null;
  bars: Array<Pick<AcceptanceBarTrace, 'barKey' | 'criterionKey' | 'barHash' | 'model' | 'check' | 'requirement' |
    'method' | 'falsifier' | 'role' | 'mandatory' | 'requiredScope' | 'evidencePlane' | 'requiredTestLayers' |
    'passRatings' | 'coversBarKeys' | 'provenance'> & {
      mappings: Array<{ planItemId: string; specId: string }>;
    }>;
};

function acceptanceBarHashInputFromTrace(
  bar: AcceptanceBarContractDiffView['bars'][number],
): AcceptanceBarHashInput & Record<keyof AcceptanceBarHashInput, unknown> {
  return {
    key: bar.criterionKey,
    intent: bar.requirement?.intent ?? undefined,
    model: bar.model,
    bar: bar.model,
    barKey: bar.barKey,
    driftMarkers: bar.falsifier,
    requiredScope: bar.requiredScope,
    evidencePlane: bar.evidencePlane ?? undefined,
    evidenceRuntime: bar.requirement?.acceptance.evidenceRuntime ?? undefined,
    requiredTestLayers: bar.requiredTestLayers,
    check: bar.check ?? undefined,
    role: bar.role ?? undefined,
    mandatory: bar.mandatory ?? undefined,
    passRatings: bar.passRatings,
    coversBarKeys: bar.coversBarKeys,
  };
}

// The comparable subset also admits the canonical seed compiler's pre-write
// view, before execution proof exists. It is never a separate gate authority.
export function diffAcceptanceBarContractSnapshots(
  before: AcceptanceBarContractDiffView | null,
  after: AcceptanceBarContractDiffView,
  operation: AcceptanceBarContractDiff['operation'] = 'compare',
): AcceptanceBarContractDiff {
  const prior = new Map((before?.bars ?? []).map((bar) => [bar.barKey, bar]));
  const next = new Map(after.bars.map((bar) => [bar.barKey, bar]));
  const keys = [...new Set([...prior.keys(), ...next.keys()])].sort();
  const changes: AcceptanceBarContractDiff['changes'] = [];
  for (const barKey of keys) {
    const a = prior.get(barKey);
    const b = next.get(barKey);
    if (!a) {
      changes.push({ barKey, kinds: ['added'], fields: ['bar'] });
      continue;
    }
    if (!b) {
      changes.push({ barKey, kinds: ['removed'], fields: ['bar'] });
      continue;
    }
    const kinds: AcceptanceBarDiffKind[] = [];
    const fields: string[] = [];
    const changedMeaningFields = diffAcceptanceBarHashInputs(
      acceptanceBarHashInputFromTrace(a),
      acceptanceBarHashInputFromTrace(b),
    ).filter((field) => field !== 'evidencePlane');
    if (changedMeaningFields.length > 0 || a.barHash !== b.barHash) kinds.push('bar-meaning');
    fields.push(...changedMeaningFields);
    if (a.barHash !== b.barHash && changedMeaningFields.length === 0) fields.push('barHash');
    if (a.evidencePlane !== b.evidencePlane) {
      kinds.push('evidence-plane');
      fields.push('evidencePlane');
    }
    if (a.method !== b.method) {
      kinds.push('method-only');
      fields.push('method');
    }
    const mappingOf = (bar: AcceptanceBarContractDiffView['bars'][number]) =>
      bar.mappings.map((mapping) => `${mapping.planItemId}\0${mapping.specId}`).sort();
    if (!sameValue(mappingOf(a), mappingOf(b))) {
      kinds.push('mapping');
      fields.push('mappings');
    }
    if (
      !sameValue(a.provenance, b.provenance) ||
      before?.plan?.cohort !== after.plan?.cohort ||
      before?.plan?.adoptionEpoch !== after.plan?.adoptionEpoch
    ) {
      kinds.push('provenance-cohort');
      fields.push('provenance');
    }
    if (kinds.length > 0) {
      changes.push({ barKey, kinds: [...new Set(kinds)], fields: [...new Set(fields)].sort() });
    }
  }
  const base = {
    schemaVersion: 1 as const,
    operation,
    beforeHash: before?.contentHash ?? null,
    afterHash: after.contentHash,
    changed: changes.length > 0,
    requiresAmendment: changes.some((change) =>
      change.kinds.some((kind) => ['added', 'removed', 'bar-meaning', 'mapping', 'evidence-plane'].includes(kind)),
    ),
    changes,
  };
  return { ...base, contentHash: contentHash(base) };
}

// Public vocabulary aliases. Keeping the explicit `project/read/diff` names above
// makes call sites describe whether they are pure or I/O-bearing; these aliases let
// lifecycle writers refer to the domain contract without inventing a second API.
export const buildAcceptanceBarContractSnapshot = projectAcceptanceBarContractSnapshot;
export const getAcceptanceBarContractSnapshot = readAcceptanceBarContractSnapshot;
export const diffAcceptanceBarContract = diffAcceptanceBarContractSnapshots;
