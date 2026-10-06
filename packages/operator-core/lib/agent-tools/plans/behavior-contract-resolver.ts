/**
 * The universal BehaviorContract resolver (P-016, D-012 / D-013).
 *
 * D-012 makes every enforceable promise a view over ONE graph — the existing
 * versioned spec-clause substrate — rather than a family of contract types. D-013
 * settles how applicability is resolved over that graph, and the two rulings
 * together are what this module implements:
 *
 *   plan_slug stays the clause's GROUPING/PROVENANCE namespace only. It is NOT a
 *   scope boundary for applicability. A work item — standalone bugs and changes
 *   included — may link through work_item_spec_revision_edges to any exact
 *   versioned clause regardless of its own source-plan provenance.
 *
 * So the resolution order is: read ALL explicit edges for the work item ACROSS plan
 * namespaces, group by plan_slug, load the exact CURRENT clauses per group, then
 * merge the plan-item-owned clauses named by the source-plan stamp for backward
 * compatibility. That merge is the back-compat leg, not the primary one — inverting
 * them is what confines a standalone item to its own plan and reintroduces the gap
 * this exists to close.
 *
 * ⚠ THIS MODULE REPORTS; IT NEVER ENFORCES. D-013 assigns the report to P-016 and
 * hard enforcement of the same reconciled condition to P-013. `impact.report` is
 * therefore advisory by construction: nothing here returns a refusal, and no caller
 * should treat a populated report as one until P-013 lands. Observation-lane items
 * and unpromoted ideas stay outside enforcement entirely — they are candidate
 * inputs until a promotion creates an active clause/edge (D-012).
 */
import type { SpecClauseRevision } from './spec-clauses-store';
import { listSpecClauses } from './spec-clauses-store';
import { enforcementEligibility, type EnforcementEligibility } from './spec-enforcement-eligibility';
import { listPlanStatuses } from './plan-status-read';
import type { WorkItemSpecRevisionEdge } from './spec-evidence-store';
import { listWorkItemSpecRevisionEdges } from './spec-evidence-store';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, adhocPlanItemIdFor } from './adhoc-spec-scope';

/** The clause lifecycle states that carry an enforceable promise (D-012). */
export const ENFORCEABLE_LIFECYCLE_STATUSES = ['accepted', 'active'] as const;

/**
 * Kinds whose completion can CHANGE observable behavior, and which D-012 therefore
 * requires to resolve affected clauses even with no plan provenance. `task` is
 * excluded deliberately: it is the repo's non-code kind.
 */
export const BEHAVIOR_CHANGING_KINDS = ['bug', 'change'] as const;

export interface WorkItemForContract {
  id: string;
  kind?: string | null;
  harness?: string | null;
  payload?: unknown;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  /** Observation-lane rows are candidate inputs, never enforceable (D-012). */
  lane?: string | null;
}

export interface PlanStamp {
  planSlug: string;
  harnessSlug: string;
  planItemIds: string[];
}

/**
 * The work item's source-plan provenance, or null when it is standalone.
 *
 * Lives here rather than in the completion gate because provenance is now one INPUT
 * to resolution instead of its precondition — the gate imports it from this module.
 */
export function planStampOf(workItem: WorkItemForContract): PlanStamp | null {
  const payload = workItem.payload;
  const raw =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { plan_item?: unknown }).plan_item
      : null;
  const stamp = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const stampedPlanSlug =
    typeof stamp?.plan_slug === 'string' && stamp.plan_slug.trim() ? stamp.plan_slug.trim() : null;
  const planSlug = stampedPlanSlug ?? workItem.sourcePlanSlug?.trim();
  if (!planSlug) return null;
  const harnessSlug =
    typeof stamp?.harness_slug === 'string' && stamp.harness_slug.trim()
      ? stamp.harness_slug.trim()
      : workItem.harness?.trim();
  if (!harnessSlug) return null;
  const stampedItemId =
    typeof stamp?.item_id === 'string' && /^P-\d{3,}$/.test(stamp.item_id) ? stamp.item_id : null;
  return {
    planSlug,
    harnessSlug,
    planItemIds: [
      ...new Set([
        ...(stampedItemId ? [stampedItemId] : []),
        ...(workItem.sourcePlanItemIds ?? []).filter((id) => /^P-\d{3,}$/.test(id)),
      ]),
    ],
  };
}

/** One plan namespace's slice of a work item's contract. */
export interface BehaviorContractGroup {
  planSlug: string;
  /** Why this namespace is in scope: an explicit edge, the source-plan stamp, or both. */
  via: 'edge' | 'plan-stamp' | 'edge+plan-stamp';
  edges: WorkItemSpecRevisionEdge[];
  /** Exact CURRENT clauses for this namespace, deduped by specId. */
  clauses: SpecClauseRevision[];
  /**
   * Edges naming a revision that is no longer current. Reported, never dropped: a
   * silently-ignored stale edge is a coverage claim against a promise that has since
   * been revised, which is exactly the case a reader must be able to see.
   */
  staleEdges: Array<{ specId: string; edgeRevision: number; currentRevision: number }>;
  /**
   * The namespace plan's own status. `null` when the plan could not be read — which is
   * NOT the same as a plan with an unknown status, and the two must not collapse: an
   * unreadable plan is treated as non-enforcing (see `eligibility`), because refusing a
   * completion on a plan we failed to read would turn an infrastructure blip into a
   * fleet-wide block.
   */
  planStatus: string | null;
  /**
   * P-013: whether THIS namespace's clauses may refuse, and why not when they may not.
   * Computed once here so the completion gate and the sync-resolver view that renders it
   * cannot drift — they previously each re-derived the enforced set independently.
   */
  eligibility: EnforcementEligibility;
}

export interface WorkItemBehaviorContract {
  workItemId: string;
  groups: BehaviorContractGroup[];
  /** Every enforceable clause across all namespaces, deduped by planSlug+specId. */
  enforceable: SpecClauseRevision[];
  impact: {
    /** Whether D-012 requires this item to resolve affected clauses at all. */
    required: boolean;
    resolved: boolean;
    /** Advisory only — P-013 owns turning this into a refusal. Null when nothing to report. */
    report: string | null;
    reason: 'observation-lane' | 'non-behavior-changing' | 'resolved' | 'unresolved';
  };
}

export interface ResolveBehaviorContractDeps {
  listEdges?: typeof listWorkItemSpecRevisionEdges;
  listClauses?: typeof listSpecClauses;
  /**
   * Batched plan-status read for the namespaces this contract touches. Injected for the
   * same reason as the other two: so the resolver is testable without a database.
   * Returns a slug->status map; a slug ABSENT from the map is an unreadable/unknown plan
   * and is treated as non-enforcing, never as a default status.
   */
  listPlanStatuses?: (input: {
    harnessSlug?: string;
    planSlugs: string[];
  }) => Promise<Map<string, string>>;
}

function isEnforceable(clause: SpecClauseRevision): boolean {
  return (ENFORCEABLE_LIFECYCLE_STATUSES as readonly string[]).includes(clause.lifecycleStatus);
}

/**
 * THE enforced set — the one definition of "which clauses may refuse this work item".
 *
 * ⚠ Read this before writing a `groups.filter(...)` anywhere else. Three surfaces need
 * this answer: the completion gate that refuses, the sync-resolver view that renders what
 * that gate will do, and any future census over the same population. They previously each
 * re-derived it (`groups.find(g => g.planSlug === stamp.planSlug)`, copied verbatim), and
 * two copies of a refusal rule is a defect with no failing test: a human is shown one
 * enforced set while a DIFFERENT one refuses their completion, and nothing anywhere
 * notices the divergence. Deriving both from this function is what makes that class
 * impossible rather than merely absent today.
 *
 * `planSlugs` is returned beside the clauses because the two must travel together: the
 * evidence read has to be scoped to exactly the namespaces being enforced, or a clause
 * gets refused for lack of evidence the query was never allowed to see.
 */
export function enforcedClausesOf(contract: WorkItemBehaviorContract): {
  planSlugs: string[];
  clauses: SpecClauseRevision[];
} {
  const enforcing = contract.groups.filter((group) => group.eligibility.enforcing);
  return {
    planSlugs: enforcing.map((group) => group.planSlug),
    clauses: enforcing.flatMap((group) => group.clauses).filter(isEnforceable),
  };
}

/**
 * Default plan-status read — EXTRACTED to `plan-status-read.ts` in P-013 so the plan-ship
 * coverage gate reads eligibility from the same query this resolver does. See that
 * module's header for why a second copy would be a defect rather than a duplication.
 */
const defaultListPlanStatuses = listPlanStatuses;

/**
 * Resolve every behavior clause a work item is on the hook for, across plan namespaces.
 *
 * Returns a REPORT. See the module header: no result of this function is a refusal.
 */
export async function resolveWorkItemBehaviorContract(
  workItem: WorkItemForContract,
  deps: ResolveBehaviorContractDeps = {},
): Promise<WorkItemBehaviorContract> {
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listPlanStatuses = deps.listPlanStatuses ?? defaultListPlanStatuses;
  const stamp = planStampOf(workItem);
  const harnessSlug = stamp?.harnessSlug ?? workItem.harness?.trim() ?? undefined;

  // PRIMARY LEG (D-013): all explicit edges, every namespace. Unscoped by plan_slug
  // on purpose — scoping it here is what made a standalone item invisible.
  const edges = await listEdges({ harnessSlug, workItemId: workItem.id });

  const byPlan = new Map<string, WorkItemSpecRevisionEdge[]>();
  for (const edge of edges) {
    const list = byPlan.get(edge.planSlug);
    if (list) list.push(edge);
    else byPlan.set(edge.planSlug, [edge]);
  }
  // BACK-COMPAT LEG: the source-plan stamp contributes its namespace even with no edge,
  // so plan-item-owned clauses authored before edges existed still resolve.
  if (stamp && !byPlan.has(stamp.planSlug)) byPlan.set(stamp.planSlug, []);

  // P-013: one batched status read for every namespace in scope. Batched rather than
  // per-group so a contract spanning several plans stays one query, and read BEFORE the
  // groups are built so eligibility is present on every return path — including the
  // observation-lane and non-behavior-changing early returns below.
  const planStatuses = await listPlanStatuses({ harnessSlug, planSlugs: [...byPlan.keys()] });

  const groups = await Promise.all(
    [...byPlan.entries()].map(async ([planSlug, planEdges]): Promise<BehaviorContractGroup> => {
      const edgeSpecIds = [...new Set(planEdges.map((edge) => edge.specId))];
      const isStampPlan = stamp?.planSlug === planSlug;
      const [edgeClauses, itemClauses] = await Promise.all([
        edgeSpecIds.length
          ? listClauses({ harnessSlug, planSlug, specIds: edgeSpecIds })
          : Promise.resolve([] as SpecClauseRevision[]),
        // Only the STAMPED namespace merges plan-item-owned clauses. A namespace reached
        // purely by an edge contributes exactly the clauses that edge names — pulling in
        // its plan items too would make one edge drag in an unrelated plan's whole contract.
        isStampPlan && stamp.planItemIds.length
          ? listClauses({ harnessSlug, planSlug, planItemIds: stamp.planItemIds })
          : Promise.resolve([] as SpecClauseRevision[]),
      ]);

      const clauses = [
        ...new Map([...itemClauses, ...edgeClauses].map((clause) => [clause.specId, clause])).values(),
      ];
      const currentBySpec = new Map(clauses.map((clause) => [clause.specId, clause]));
      const staleEdges = planEdges.flatMap((edge) => {
        const clause = currentBySpec.get(edge.specId);
        if (!clause || clause.revision === edge.specRevision) return [];
        return [{ specId: edge.specId, edgeRevision: edge.specRevision, currentRevision: clause.revision }];
      });

      // An unreadable plan (absent from the map) must not enforce. Passing a sentinel
      // status here rather than `''` keeps that explicit: `laneOf` maps any unrecognized
      // status to `enforceable`, so a blank would have QUIETLY enforced on a plan we
      // could not read — the opposite of the intended failure direction.
      const planStatus = planStatuses.get(planSlug) ?? null;
      const eligibility: EnforcementEligibility =
        planStatus === null
          ? { enforcing: false, lane: 'pre-enforcement', adoption: 'no-behavior-declared', reason: 'pre-enforcement' }
          : enforcementEligibility({ status: planStatus, clauseCount: clauses.length });

      return {
        planSlug,
        via: planEdges.length === 0 ? 'plan-stamp' : isStampPlan ? 'edge+plan-stamp' : 'edge',
        edges: planEdges,
        clauses,
        staleEdges,
        planStatus,
        eligibility,
      };
    }),
  );

  groups.sort((a, b) => a.planSlug.localeCompare(b.planSlug));
  const enforceable = groups.flatMap((group) => group.clauses.filter(isEnforceable));

  // Applicability is BEHAVIOR-owned, not plan-owned (D-012).
  const lane = workItem.lane?.trim().toLowerCase();
  const kind = workItem.kind?.trim().toLowerCase();
  if (lane === 'observation') {
    return {
      workItemId: workItem.id,
      groups,
      enforceable,
      impact: { required: false, resolved: enforceable.length > 0, report: null, reason: 'observation-lane' },
    };
  }
  if (!kind || !(BEHAVIOR_CHANGING_KINDS as readonly string[]).includes(kind)) {
    return {
      workItemId: workItem.id,
      groups,
      enforceable,
      impact: { required: false, resolved: enforceable.length > 0, report: null, reason: 'non-behavior-changing' },
    };
  }

  const resolved = enforceable.length > 0;
  // `plans:set-specs` requires a `planItemId` that an ad-hoc caller has no plan to take one
  // from, and naming only the arg to OMIT (`slug`) left the required one to be guessed. The
  // advice is rendered per item, so it states the EXACT literal rather than a convention the
  // reader has to instantiate — see `adhocPlanItemIdFor`, which validates against the same
  // shape the database CHECK enforces so this can never suggest a rejected value.
  const adhocPlanItemId = adhocPlanItemIdFor(workItem.id);
  const adhocPlanItemArg = adhocPlanItemId
    ? `passing \`planItemId: '${adhocPlanItemId}'\``
    : 'passing the required `planItemId` (shape `P-` followed by at least 3 digits)';
  const missingClauseRemedy = stamp
    ? `link one with plans:bind-spec-evidence, or promote a new clause with plans:set-specs.`
    : `This item has no source plan. Use the harness ad-hoc scope \`${ADHOC_WORK_ITEM_SPEC_SCOPE}\`: ` +
      `author an item-local clause with plans:set-specs while omitting \`slug\` and ${adhocPlanItemArg}, ` +
      `then bind this work item and its proof with plans:bind-spec-evidence while also omitting \`slug\`. ` +
      // EI-23820598120293502: naming the two verbs and the one arg to OMIT still cost a closer
      // five corrective round-trips, because neither verb's WRAPPER key nor required keys were
      // named. State only the structural facts that were each measured to be guessed wrong
      // (an OBJECT not an array under `spec`; `binding`, not loose top-level args) and point at
      // the schema for the closed enums, which are the part that drifts if copied here.
      `Shapes: plans:set-specs takes ONE object under \`spec\` (not an array) with at least specId, ` +
      `expectedRevision (0 to create), planItemId, behavior, behaviorClass and lifecycleStatus; ` +
      `plans:bind-spec-evidence takes ONE object under \`binding\` with at least workItemId, specId, ` +
      `specRevision, evidenceKind and evidenceRef, plus exactly one of \`measurement\` ` +
      `({ schemaVersion: 1, kind, sourcePaths, ... }) or \`sourceFingerprint\` (or the ledger form ` +
      `{ workItemId, specId, fromTestRun } that derives the rest from a test_runs row). Read the exact ` +
      `enum values with tools:find before the first call.`;
  return {
    workItemId: workItem.id,
    groups,
    enforceable,
    impact: {
      required: true,
      resolved,
      reason: resolved ? 'resolved' : 'unresolved',
      report: resolved
        ? null
        : `${workItem.id} is a behavior-changing ${kind} that resolves no active behavior clause. ` +
          `D-012 expects a behavior-changing item to name the clauses it affects — ${missingClauseRemedy} ` +
          `Reported, not enforced (P-016 reports; P-013 turns this into a hard gate).`,
    },
  };
}
