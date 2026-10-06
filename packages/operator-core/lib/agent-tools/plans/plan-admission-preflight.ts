/** Shared exact-plan admission gate for plans:start and fleet:launch-on-plan. */
import { resolveEffectiveStatusForItems, type PlanItem } from '@papercusp/plan-parser';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, type ClaimSpec } from '../../scheduler/claim-spec';
import type { ClaimSpecRecord } from '../../scheduler/claim-spec-store';
import {
  readClaimSpecLaneHealth,
  readClaimSpecLaneHealthDiagnosed,
  type FleetLaneHealth,
} from '../../fleet/lane-health';
import {
  ACTIVE_FEATURE_FAMILY_KINDS,
  isSettledWorkItemState,
  ISSUE_FAMILY_KINDS,
  listWorkItems,
  WORK_ITEMS_MAX_LIMIT,
  type WorkItem,
} from '../../work-items';
import { getPlanRow, planItemsForRow } from './source';
import { analyzePlanDagParallelism, type PlanDagParallelismDiagnostics } from './plan-dag-parallelism';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

const ISSUE_KINDS = new Set<string>(ISSUE_FAMILY_KINDS);

export function claimableStatesForKinds(kinds: readonly string[]): string[] | undefined {
  return kinds.some((kind) => ISSUE_KINDS.has(kind)) ? ['open'] : undefined;
}

export function buildExactPlanClaimSpec(specId: string, planSlug: string, kinds?: readonly string[]): ClaimSpec {
  const plan = { field: 'plan' as const, op: '=' as const, value: planSlug };
  const filter = kinds?.length
    ? { all: [plan, { field: 'kind' as const, op: 'in' as const, value: [...kinds] }] }
    : plan;
  const states = kinds?.length ? claimableStatesForKinds(kinds) : undefined;
  return {
    specVersion: '1.0',
    specId,
    revision: 1,
    view: { filter },
    rank: DEFAULT_CLAIM_SPEC.rank,
    limits: DEFAULT_CLAIM_SPEC.limits,
    ...(states ? { states } : {}),
  };
}

type AdmissionWorkItem = Pick<WorkItem, 'id' | 'family' | 'sourcePlanItemIds' | 'payload'> &
  Partial<Pick<WorkItem, 'assignee' | 'takenAt' | 'state'>>;
type RootClass = 'dependency' | 'sticky' | 'cycle' | 'dangling' | 'needs-human' | 'non-actionable-status';
export type ExactPlanAdmissionReason =
  | 'ready'
  | 'plan-not-found'
  | 'no-actionable-plan-items'
  | 'promotion-lag'
  | 'duplicate-coverage'
  | 'lane-unknown'
  | 'floor-diagnostics-unavailable'
  | 'floor-gated'
  | 'family-disagreement'
  | 'insufficient-executable-width';

export interface ExactPlanAdmission {
  ready: boolean;
  status: 'ready' | 'blocked' | 'refused';
  reason: ExactPlanAdmissionReason;
  plan: string;
  /** Effective kind narrowing; null preserves a mixed-family or not-yet-promoted plan. */
  claimKinds: string[] | null;
  planItems: {
    total: number;
    actionable: number;
    actionableIds: string[];
    rootClasses: Record<RootClass, number>;
  };
  promotion: {
    rows: number;
    byFamily: { feature: number; issue: number };
    coveredActionable: number;
    missingActionableItemIds: string[];
    duplicateActionable: Array<{ planItemId: string; workItemIds: string[] }>;
    sourceCap: number;
    sourceCapExhausted: boolean;
  };
  parallelism: PlanDagParallelismDiagnostics;
  /** Advisory-only classifier output; never changes the admission verdict. */
  findings: PlanDagParallelismDiagnostics['findings'];
  requestedSeats: number | null;
  /** WIP plan lanes already occupied by an assigned promoted row. */
  occupiedWidth: number;
  executableWidth: number | null;
  seatShortfall: number | null;
  blockingRows: Array<{
    planItemId: string;
    workItemId: string;
    holder: string;
    takenAt: string | null;
  }>;
  lane: FleetLaneHealth | null;
  message: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function provenanceIds(item: AdmissionWorkItem): string[] {
  if (item.sourcePlanItemIds?.length) return item.sourcePlanItemIds;
  const payload = record(item.payload);
  const stamp = record(payload.plan_item ?? payload.planItem);
  const one = stamp.item_id ?? stamp.itemId ?? stamp.item;
  return typeof one === 'string' && one ? [one] : [];
}

/**
 * Derive a safe family narrowing from the current promoted plan rows.
 *
 * A plan-only claim spec is structurally reachable in both scheduler storage
 * families. Narrow it only when every active promoted row is from one family;
 * mixed families (and an empty promotion census) must retain the broad plan
 * predicate so a later-unblocked row cannot be starved by a stale narrowing.
 */
export function deriveExactPlanClaimKinds(
  workItems: ReadonlyArray<Pick<AdmissionWorkItem, 'family' | 'state'>>,
): string[] | undefined {
  const families = new Set(
    workItems.filter((item) => !isSettledWorkItemState(item.state)).map((item) => item.family),
  );
  if (families.size !== 1) return undefined;
  return families.has('issue') ? [...ISSUE_FAMILY_KINDS] : [...ACTIVE_FEATURE_FAMILY_KINDS];
}

function rootsFor(items: ReturnType<typeof resolveEffectiveStatusForItems>): Record<RootClass, number> {
  const roots: Record<RootClass, number> = {
    dependency: 0,
    sticky: 0,
    cycle: 0,
    dangling: 0,
    'needs-human': 0,
    'non-actionable-status': 0,
  };
  const cycles = new Set(items.cycleMembers);
  const dangling = new Set(items.missingRefs.map((entry) => entry.itemId));
  for (const item of items.items) {
    if (item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman) continue;
    if (cycles.has(item.id)) roots.cycle++;
    else if (dangling.has(item.id)) roots.dangling++;
    else if (item.needsHuman) roots['needs-human']++;
    else if (item.staleBlockedHint) roots.sticky++;
    else if (item.unresolvedBlockers.length) roots.dependency++;
    else roots['non-actionable-status']++;
  }
  return roots;
}

function finish(
  base: Omit<ExactPlanAdmission, 'ready' | 'status' | 'reason' | 'message'>,
  status: ExactPlanAdmission['status'],
  reason: ExactPlanAdmissionReason,
  message: string,
): ExactPlanAdmission {
  return { ...base, ready: status === 'ready', status, reason, message };
}

function zeroClaimableLaneVerdict(
  planSlug: string,
  lane: FleetLaneHealth,
): Pick<ExactPlanAdmission, 'reason' | 'message'> {
  const { matchedByFilter, excluded } = lane.effective;
  const filter = `plan = '${planSlug}'`;
  const scope = lane.spec.assigneeScoped
    ? `claimant scope '${lane.spec.assigneeScoped}'`
    : 'the caller-neutral fleet population';
  if (matchedByFilter == null || excluded == null) {
    return {
      reason: 'floor-diagnostics-unavailable',
      message:
        `Under ${scope}, the exact-plan lane (${filter}) has zero claimable rows, but ` +
        `${lane.effective.basis} diagnostics do not expose matched-row or exclusion-floor counts. ` +
        'This verdict cannot identify whether the filter matched rows or which claim floor excluded them.',
    };
  }
  if (matchedByFilter === 0) {
    return {
      reason: 'floor-gated',
      message: `Under ${scope}, the exact-plan filter (${filter}) matches no rows; no row reached the claim floors.`,
    };
  }
  if (!Object.values(excluded).some((count) => count > 0)) {
    return {
      reason: 'floor-gated',
      message:
        `INTERNAL INCONSISTENCY: under ${scope}, the exact-plan filter (${filter}) matched ${matchedByFilter} row(s) ` +
        'and claimable=0, but every reported exclusion bucket is zero; these counters do not support a floor-gated diagnosis.',
    };
  }
  const activeExclusions = Object.entries(excluded)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  return {
    reason: 'floor-gated',
    message: `Under ${scope}, the exact-plan lane is structurally reachable but every matched row is excluded by claim floors (${activeExclusions}).`,
  };
}

/** PURE verdict over one exact plan snapshot, its promoted rows, and lane oracle. */
export function evaluateExactPlanAdmission(args: {
  planSlug: string;
  planItems: PlanItem[];
  workItems: AdmissionWorkItem[];
  laneHealth: FleetLaneHealth | null;
  /** Why the lane read produced no exact measurement (from the diagnosed reader);
   * appended to a `lane-unknown` refusal so the cause is not lost (WI-10004851). */
  laneHealthUnavailable?: string | null;
  sourceCapExhausted?: boolean;
  requestedSeats?: number;
  /** Allow plans:start to report success when this caller already owns every ready row. */
  assignee?: string;
  allowCallerHeld?: boolean;
  /** Explicit narrowing supplied by a caller; omitted means derive from active rows. */
  claimKinds?: readonly string[];
}): ExactPlanAdmission {
  const resolved = resolveEffectiveStatusForItems(args.planItems);
  const parallelism = analyzePlanDagParallelism(args.planItems);
  const actionable = resolved.items.filter(
    (item) => item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman,
  );
  const planIds = new Set(args.planItems.map((item) => item.id));
  const coverage = new Map<string, string[]>();
  const promotedRows = args.workItems.filter((item) => {
    const ids = provenanceIds(item).filter((id) => planIds.has(id));
    return ids.length > 0;
  });
  // Promotion history is intentionally retained in the diagnostics below, but
  // only non-terminal rows are CURRENT coverage. Otherwise one dropped retry
  // beside its live successor permanently looks like duplicate actionable
  // coverage and fleet:launch-on-plan can never admit the plan again.
  const activePromotedRows = promotedRows.filter((item) => !isSettledWorkItemState(item.state));
  const claimKinds = args.claimKinds?.length
    ? [...args.claimKinds]
    : deriveExactPlanClaimKinds(activePromotedRows);
  for (const item of activePromotedRows) {
    for (const id of provenanceIds(item).filter((candidate) => planIds.has(candidate))) {
      coverage.set(id, [...(coverage.get(id) ?? []), item.id]);
    }
  }
  const missing = actionable.filter((item) => !coverage.get(item.id)?.length).map((item) => item.id);
  const duplicate = actionable.flatMap((item) => {
    const ids = coverage.get(item.id) ?? [];
    return ids.length > 1 ? [{ planItemId: item.id, workItemIds: ids }] : [];
  });
  const requestedSeats =
    Number.isFinite(args.requestedSeats) && (args.requestedSeats ?? 0) > 0
      ? Math.floor(args.requestedSeats as number)
      : null;
  const laneClaimable = args.laneHealth?.effective.claimable ?? null;
  const unclaimedExecutableWidth = laneClaimable == null ? null : Math.min(parallelism.readyWidth, laneClaimable);
  const wipPlanItemIds = new Set(
    resolved.items.filter((item) => item.effectiveStatus === 'wip').map((item) => item.id),
  );
  const occupiedPlanItemIds = new Set(
    activePromotedRows.flatMap((row) => {
      if (!row.assignee) return [];
      return provenanceIds(row).filter((planItemId) => wipPlanItemIds.has(planItemId));
    }),
  );
  const occupiedWidth = occupiedPlanItemIds.size;
  // `requestedSeats` is a target-width diagnostic for fleet launches. Include
  // lanes already occupied by assigned WIP rows in that target comparison, but
  // keep the plans:start (no requestedSeats) diagnostic as the unclaimed width:
  // its caller-held bypass handles already-owned rows explicitly below.
  const executableWidth =
    unclaimedExecutableWidth == null
      ? null
      : requestedSeats == null
        ? unclaimedExecutableWidth
        : unclaimedExecutableWidth + occupiedWidth;
  const seatShortfall =
    requestedSeats == null || executableWidth == null ? null : Math.max(0, requestedSeats - executableWidth);
  const readyItemIds = new Set(parallelism.readyItemIds);
  const hasExecutableGap =
    unclaimedExecutableWidth != null && parallelism.readyWidth > unclaimedExecutableWidth;
  const blockingRows = hasExecutableGap
    ? activePromotedRows
        .flatMap((row) => {
          if (!row.assignee) return [];
          return provenanceIds(row)
            .filter((planItemId) => readyItemIds.has(planItemId))
            .map((planItemId) => ({
              planItemId,
              workItemId: row.id,
              holder: row.assignee as string,
              takenAt: row.takenAt ?? null,
            }));
        })
        .sort((a, b) => a.planItemId.localeCompare(b.planItemId) || a.workItemId.localeCompare(b.workItemId))
    : [];
  const resolvedById = new Map(resolved.items.map((item) => [item.id, item]));
  const callerOwnedActivePlanItemIds = new Set(
    activePromotedRows.flatMap((row) => {
      if (!args.allowCallerHeld || args.requestedSeats != null || !args.assignee || row.assignee !== args.assignee) {
        return [];
      }
      return provenanceIds(row).filter((planItemId) => {
        const planItem = resolvedById.get(planItemId);
        return Boolean(
          planItem &&
          (planItem.effectiveStatus === 'wip' ||
            (planItem.effectiveStatus === 'todo' && planItem.unresolvedBlockers.length === 0 && !planItem.needsHuman)),
        );
      });
    }),
  );
  const callerOwnsActiveLane = callerOwnedActivePlanItemIds.size > 0;
  // `readClaimSpecLaneHealth` deliberately excludes taken rows from claimable. That is
  // correct for a new fleet, but plans:start is also called by the agent that may already
  // own an actionable row or be actively progressing a WIP lane. In that case a zero
  // claimable count caused by another holder or a stop-the-line floor is not a failure:
  // plans:start acknowledges existing work and does not need to open a new claim.
  const callerHoldsAllReadyRows =
    args.allowCallerHeld === true &&
    args.requestedSeats == null &&
    Boolean(args.assignee) &&
    parallelism.readyItemIds.length > 0 &&
    parallelism.readyItemIds.every((planItemId) =>
      blockingRows.some((row) => row.planItemId === planItemId && row.holder === args.assignee),
    );
  const base = {
    plan: args.planSlug,
    claimKinds: claimKinds ?? null,
    planItems: {
      total: resolved.items.length,
      actionable: actionable.length,
      actionableIds: actionable.map((item) => item.id),
      rootClasses: rootsFor(resolved),
    },
    promotion: {
      rows: promotedRows.length,
      byFamily: {
        feature: promotedRows.filter((item) => item.family === 'feature').length,
        issue: promotedRows.filter((item) => item.family === 'issue').length,
      },
      coveredActionable: actionable.length - missing.length,
      missingActionableItemIds: missing,
      duplicateActionable: duplicate,
      sourceCap: WORK_ITEMS_MAX_LIMIT,
      sourceCapExhausted: args.sourceCapExhausted === true,
    },
    parallelism,
    findings: parallelism.findings,
    requestedSeats,
    occupiedWidth,
    executableWidth,
    seatShortfall,
    blockingRows,
    lane: args.laneHealth,
  };

  if (!actionable.length)
    return finish(
      base,
      'blocked',
      'no-actionable-plan-items',
      'No exact-plan item is actionable; rootClasses explains the blocked DAG.',
    );
  if (args.sourceCapExhausted)
    return finish(
      base,
      'refused',
      'lane-unknown',
      'The promoted-row census hit its source cap; exact coverage is unknown.',
    );
  if (missing.length)
    return finish(
      base,
      'refused',
      'promotion-lag',
      `Actionable plan items lack a promoted row: ${missing.join(', ')}.`,
    );
  if (duplicate.length)
    return finish(
      base,
      'refused',
      'duplicate-coverage',
      `Actionable plan items have duplicate promoted rows: ${duplicate.map((entry) => entry.planItemId).join(', ')}.`,
    );
  if (!args.laneHealth || args.laneHealth.effective.claimable == null)
    return finish(
      base,
      'refused',
      'lane-unknown',
      'The exact-plan claim lane could not be read completely.' +
        (args.laneHealthUnavailable ? ` ${args.laneHealthUnavailable}` : ''),
    );

  const needed = new Set(
    activePromotedRows
      .filter((row) => provenanceIds(row).some((id) => actionable.some((item) => item.id === id)))
      .map((row) => row.family),
  );
  const unreachable =
    (needed.has('feature') && !args.laneHealth.familyReachability.feature) ||
    (needed.has('issue') && !args.laneHealth.familyReachability.issue);
  const unknownFamily = needed.has('feature') && args.laneHealth.featureFamily?.claimable == null;
  if (unknownFamily)
    return finish(base, 'refused', 'lane-unknown', 'A required claim family returned an unknown count.');
  const featureZero = needed.has('feature') && args.laneHealth.featureFamily?.claimable === 0;
  const issueZero = needed.has('issue') && args.laneHealth.issueFamily.claimable === 0;
  const somePositive = (args.laneHealth.featureFamily?.claimable ?? 0) > 0 || args.laneHealth.issueFamily.claimable > 0;
  const familyDisagreement = (featureZero || issueZero) && somePositive;
  // A mixed plan can still feed a bounded launch from the family that has a
  // claimable row. Treat the zero family as diagnostic context when the
  // requested seat count is already satisfied; an unbounded plans:start call
  // and a request with a real shortfall retain the refusal diagnostics.
  if (unreachable || (familyDisagreement && seatShortfall !== 0 && !callerOwnsActiveLane)) {
    return finish(
      base,
      'refused',
      'family-disagreement',
      'Actionable promoted families disagree with the exact-plan lane reachability/counts.',
    );
  }
  if (callerHoldsAllReadyRows || callerOwnsActiveLane) {
    return finish(
      base,
      'ready',
      'ready',
      callerHoldsAllReadyRows
        ? 'Exact-plan admission is ready: the caller already holds all ' +
            blockingRows.length +
            ' actionable ready row(s); no additional claimable row is required.'
        : `Exact-plan admission is ready: the caller already owns ${callerOwnedActivePlanItemIds.size} active non-final lane(s); ` +
            'no additional claimable row is required for those lanes.',
    );
  }
  if (args.laneHealth.effective.claimable === 0) {
    const zeroLane = zeroClaimableLaneVerdict(args.planSlug, args.laneHealth);
    return finish(base, 'refused', zeroLane.reason, zeroLane.message);
  }
  if (seatShortfall != null && seatShortfall > 0) {
    const edges = parallelism.blockingEdges
      .slice(0, 8)
      .map((edge) => `${edge.itemId}<-${edge.blockerId}(${edge.blockerStatus})`);
    const edgeSuffix = parallelism.blockingEdges.length > 8 ? `, … +${parallelism.blockingEdges.length - 8} more` : '';
    const nonReady = parallelism.nonReadyItems.slice(0, 8).map((item) => `${item.itemId}:${item.reason}`);
    const nonReadySuffix =
      parallelism.nonReadyItems.length > 8 ? `, … +${parallelism.nonReadyItems.length - 8} more` : '';
    const heldReadyRows = blockingRows.map(
      (row) => `${row.planItemId}->${row.workItemId}(holder=${row.holder}, takenAt=${row.takenAt ?? 'unknown'})`,
    );
    return finish(
      base,
      'refused',
      'insufficient-executable-width',
      `Requested ${requestedSeats} seat(s), but the exact plan exposes executableWidth=${executableWidth} ` +
        `(readyWidth=${parallelism.readyWidth}, laneClaimable=${args.laneHealth.effective.claimable}, ` +
        `occupiedWidth=${occupiedWidth}); ` +
        `shortfall=${seatShortfall}. Ready items: ${parallelism.readyItemIds.join(', ') || 'none'}. ` +
        `${hasExecutableGap ? `Held ready rows: ${heldReadyRows.join(', ') || 'none identified'}. ` : ''}` +
        `Blocking edges: ${edges.join(', ') || 'none'}${edgeSuffix}. ` +
        `Other non-ready items: ${nonReady.join(', ') || 'none'}${nonReadySuffix}.`,
    );
  }
  return finish(
    base,
    'ready',
    'ready',
    `Exact-plan admission is ready with ${args.laneHealth.effective.claimable} claimable row(s).`,
  );
}

export interface ExactPlanLaneHealthPreflightArgs {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** Audit actor that authored this ephemeral admission spec. */
  actor: string;
  /** Omit claimant for a caller-neutral population read. */
  claimant?: string;
  specId: string;
  fleetSlug?: string;
  /** Explicit family narrowing is safe only when the caller already knows it. */
  claimKinds?: readonly string[];
}

/**
 * Read the exact-plan claim lane without requiring promoted-row coverage.
 *
 * `plans:start` calls this before approval/promotion. At that point an empty
 * promoted-row census is expected, so the full admission verdict would report
 * `promotion-lag` and deadlock every first start. This helper deliberately
 * measures only the claim-lane oracle; post-promotion admission remains
 * authoritative for coverage and claimability.
 */
export async function preflightExactPlanLaneHealth(
  args: ExactPlanLaneHealthPreflightArgs,
): Promise<FleetLaneHealth | null> {
  const built = buildExactPlanClaimSpec(args.specId, args.planSlug, args.claimKinds);
  const validation = validateClaimSpec(built);
  if (!validation.ok || !validation.spec)
    throw new Error(`invalid exact-plan claim spec: ${validation.errors.join('; ')}`);
  const spec = validation.spec;
  const record: ClaimSpecRecord = {
    source: 'fleet',
    spec,
    revision: spec.revision,
    updatedBy: args.actor,
    updatedAt: null,
    harnessSlug: args.harnessSlug,
    fleetSlug: args.fleetSlug ?? `exact-plan:${args.planSlug}`,
  };
  return readClaimSpecLaneHealth({
    spec,
    record,
    fleet: record.fleetSlug!,
    harness: args.harnessSlug,
    workspaceId: args.workspaceId,
    assignee: args.claimant,
    matchedBy: 'exact-plan-lane-health-preflight',
  });
}

export async function preflightExactPlanAdmission(args: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** Audit actor that authored this ephemeral admission spec. */
  actor: string;
  /**
   * Optional claimant whose caller-relative floors should be evaluated. Omit for
   * a fleet population/handoff read: a leader's release cooldown must not make a
   * ready row look unavailable to the different member that will claim it.
   */
  claimant?: string;
  specId: string;
  fleetSlug?: string;
  claimKinds?: readonly string[];
  requestedSeats?: number;
  /** Allow plans:start to report success when this caller already holds every ready row. */
  allowCallerHeld?: boolean;
}): Promise<ExactPlanAdmission> {
  const row = await getPlanRow(args.planSlug, { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug });
  if (!row) {
    const empty = evaluateExactPlanAdmission({
      planSlug: args.planSlug,
      planItems: [],
      workItems: [],
      laneHealth: null,
      requestedSeats: args.requestedSeats,
      assignee: args.claimant,
      allowCallerHeld: args.allowCallerHeld,
    });
    return { ...empty, reason: 'plan-not-found', status: 'refused', message: `Plan '${args.planSlug}' was not found.` };
  }
  // listWorkItems derives its workspace from ALS, while the plan and lane
  // readers below accept this explicit workspaceId. Bind the same scope for
  // the promoted-row census or a cross-workspace caller sees false promotion
  // lag even when this exact plan has a real promoted row.
  const workItems = await runWithWorkspaceIfConcrete(args.workspaceId, () => listWorkItems({
    harness: args.harnessSlug,
    sourcePlanSlug: args.planSlug,
    includeChildren: true,
    limit: WORK_ITEMS_MAX_LIMIT,
  }));
  const planItems = planItemsForRow(row);
  const sourceCapExhausted = workItems.length >= WORK_ITEMS_MAX_LIMIT;
  // These structural refusals are definitive before the scheduler lane is read.
  // The lane oracle can be comparatively slow and cannot turn an unpromoted,
  // duplicate-covered, or non-actionable plan into a launchable one. Returning
  // here keeps a bounded agenda read able to name the real repair instead of
  // timing out and replacing a known promotion gap with an unknown verdict.
  const structural = evaluateExactPlanAdmission({
    planSlug: args.planSlug,
    planItems,
    workItems,
    laneHealth: null,
    sourceCapExhausted,
    requestedSeats: args.requestedSeats,
    assignee: args.claimant,
    allowCallerHeld: args.allowCallerHeld,
    claimKinds: args.claimKinds,
  });
  if (
    structural.reason === 'no-actionable-plan-items' ||
    structural.reason === 'promotion-lag' ||
    structural.reason === 'duplicate-coverage' ||
    (sourceCapExhausted && structural.reason === 'lane-unknown')
  ) return structural;
  const effectiveClaimKinds = args.claimKinds?.length
    ? [...args.claimKinds]
    : deriveExactPlanClaimKinds(workItems);
  const built = buildExactPlanClaimSpec(args.specId, args.planSlug, effectiveClaimKinds);
  const validation = validateClaimSpec(built);
  if (!validation.ok || !validation.spec)
    throw new Error(`invalid exact-plan claim spec: ${validation.errors.join('; ')}`);
  const spec = validation.spec;
  const record: ClaimSpecRecord = {
    source: 'fleet',
    spec,
    revision: spec.revision,
    updatedBy: args.actor,
    updatedAt: null,
    harnessSlug: args.harnessSlug,
    fleetSlug: args.fleetSlug ?? `exact-plan:${args.planSlug}`,
  };
  // Diagnosed read: same measurement as readClaimSpecLaneHealth, but a failed
  // read keeps its cause instead of collapsing to a bare null (WI-10004851).
  const { laneHealth, unavailable } = await readClaimSpecLaneHealthDiagnosed({
    spec,
    record,
    fleet: record.fleetSlug!,
    harness: args.harnessSlug,
    workspaceId: args.workspaceId,
    assignee: args.claimant,
    matchedBy: 'exact-plan-preflight',
  });
  return evaluateExactPlanAdmission({
    planSlug: args.planSlug,
    planItems,
    workItems,
    laneHealth,
    laneHealthUnavailable: unavailable?.detail ?? null,
    sourceCapExhausted,
    requestedSeats: args.requestedSeats,
    assignee: args.claimant,
    allowCallerHeld: args.allowCallerHeld,
    claimKinds: effectiveClaimKinds,
  });
}
