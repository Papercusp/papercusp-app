/**
 * Canonical executable frontier for an exact-plan fleet lane.
 *
 * This is the shared semantic behind fleet:launch-on-plan admission,
 * fleet:leader-brief's post-launch detector, and the turn-start orientation
 * edge. Unknown, broad, or paused lanes return null; callers must never turn
 * an unread measurement into a measured zero.
 */
import type { FilterNode } from '../scheduler/claim-spec';

export interface FleetExecutableFrontier {
  fleetSlug: string;
  harnessSlug: string;
  planSlug: string;
  readyWidth: number;
  claimable: number;
  executableWidth: number;
}

function uniquePlanSlugs(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Extract exact positive plan predicates without widening through NOT. */
function positivePlanSlugsFromFilter(node: FilterNode | null | undefined): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  if ('not' in node) return [];
  if ('all' in node || 'any' in node) {
    const children = 'all' in node ? node.all : node.any;
    return uniquePlanSlugs(children.flatMap((child) => positivePlanSlugsFromFilter(child)));
  }
  const leaf = node as { field?: unknown; op?: unknown; value?: unknown };
  if (leaf.field !== 'plan') return [];
  if (leaf.op === '=' && typeof leaf.value === 'string') return uniquePlanSlugs([leaf.value]);
  if (leaf.op === 'in' && Array.isArray(leaf.value)) {
    return uniquePlanSlugs(leaf.value.filter((value): value is string => typeof value === 'string'));
  }
  return [];
}

/**
 * Return the one positive plan slug that EVERY admitting branch requires.
 * `any: [plan=P, kind=bug]` mentions a plan but admits work outside it, so it
 * cannot define the fleet's executable frontier.
 */
export function exactPositiveSinglePlanSlugFromFilter(node: FilterNode | null | undefined): string | null {
  const slugs = positivePlanSlugsFromFilter(node);
  if (slugs.length !== 1) return null;
  const target = slugs[0];
  const requiresTarget = (candidate: FilterNode | null | undefined): boolean => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    if ('not' in candidate) return false;
    if ('all' in candidate) return candidate.all.some((child) => requiresTarget(child));
    if ('any' in candidate) {
      return candidate.any.length > 0 && candidate.any.every((child) => requiresTarget(child));
    }
    const leaf = candidate as { field?: unknown; op?: unknown; value?: unknown };
    if (leaf.field !== 'plan') return false;
    if (leaf.op === '=') return leaf.value === target;
    if (leaf.op === 'in' && Array.isArray(leaf.value)) {
      const values = uniquePlanSlugs(leaf.value.filter((value): value is string => typeof value === 'string'));
      return values.length === 1 && values[0] === target;
    }
    return false;
  };
  return requiresTarget(node) ? target : null;
}

/** P-011's canonical executable-seat definition. Null means unmeasured. */
export function canonicalExecutableWidth(input: {
  readyWidth: number | null | undefined;
  claimable: number | null | undefined;
}): number | null {
  if (
    !Number.isSafeInteger(input.readyWidth) ||
    (input.readyWidth ?? -1) < 0 ||
    !Number.isSafeInteger(input.claimable) ||
    (input.claimable ?? -1) < 0
  ) {
    return null;
  }
  return Math.min(input.readyWidth as number, input.claimable as number);
}

/**
 * Resolve the caller's current fleet and measure its exact-plan executable
 * frontier. The plan DAG and family-complete lane health are read concurrently.
 * Every unknown or failure is fail-soft null, never a fabricated empty lane.
 */
export async function readFleetExecutableFrontier(input: {
  ownerId: string;
  workspaceId: string;
}): Promise<FleetExecutableFrontier | null> {
  try {
    // Fresh solo sessions have no fleet frontier. Resolve that inexpensive
    // discriminator before loading the fleet planning/read-model graph into
    // their bounded turn-start path.
    const presence = await import('../agent-tools/coordination/presence-fleet');
    const membership = await presence.resolvePresenceFleet(input.ownerId, {
      fleetSlug: null,
      fleetRole: null,
    });
    const fleetSlug = membership.fleetSlug;
    if (!fleetSlug) return null;

    const [fleets, specs] = await Promise.all([
      import('../agent-fleets-store'),
      import('../scheduler/claim-spec-store'),
    ]);
    const [fleet, resolved] = await Promise.all([
      fleets.getFleet(input.workspaceId, fleetSlug),
      specs.resolveFleetClaimSpec({ spec: fleetSlug, workspaceId: input.workspaceId }),
    ]);
    if (!fleet || fleet.controlState === 'winding-down' || !resolved) return null;

    const planSlug = exactPositiveSinglePlanSlugFromFilter(resolved.record.spec.view?.filter);
    const harnessSlug = resolved.record.harnessSlug;
    if (!planSlug || !harnessSlug) return null;

    const [lane, plans, dag] = await Promise.all([
      import('./lane-health'),
      import('../agent-tools/plans/source'),
      import('../agent-tools/plans/plan-dag-parallelism'),
    ]);
    const [planRow, laneHealth] = await Promise.all([
      plans.getPlanRow(planSlug, { workspaceId: input.workspaceId, harnessSlug }),
      lane.readClaimSpecLaneHealth({
        spec: resolved.record.spec,
        record: resolved.record,
        fleet: fleetSlug,
        harness: harnessSlug,
        workspaceId: input.workspaceId,
        matchedBy: resolved.matchedBy,
      }),
    ]);
    if (!planRow) return null;

    const readyWidth = dag.analyzePlanDagParallelism(plans.planItemsForRow(planRow)).readyWidth;
    const claimable = laneHealth?.effective.claimable ?? null;
    const executableWidth = canonicalExecutableWidth({ readyWidth, claimable });
    if (executableWidth == null || claimable == null) return null;

    return {
      fleetSlug,
      harnessSlug,
      planSlug,
      readyWidth,
      claimable,
      executableWidth,
    };
  } catch {
    return null;
  }
}
