/**
 * fleet-dag-view — the pure DAG-filter / frontier SHAPER for
 * `fleet:assignments { includeDag }` (EI-6949; owner-requested 2026-07-03).
 *
 * WHY a separate view, not presence: presence is an AGENT-centric hot path
 * (per-agent, heartbeat-frequency, TTL-reaped) and already carries each agent's
 * own `claimedItems`. The DAG filter is FLEET/plan-level work-graph state,
 * identical across every agent in the fleet — so it belongs in an OPT-IN read
 * alongside who's-on-what, never duplicated onto each agent's presence row
 * (O(agents×items) on a hot path + wrong lifecycle). This module is that view's
 * pure core.
 *
 * ONE computation, TWO consumers: the fleet spawner ADMITS from the plan's
 * dependency DAG (an item is placeable once its blockers are satisfied and its
 * touch-set is conflict-free — admit-conflict-free.ts). This view reads the SAME
 * canonical plan-item state (effectiveStatus + unresolvedBlockers) + live claims,
 * so what it shows as `ready` is exactly what the spawner would place next — the
 * view can never drift from reality. PURE: no DB — the caller reads the plan
 * items + the claim map and hands them in.
 */

/** One plan item as the DAG view needs it — a projection of a plans:get item
 *  (its effective status + dependency edges + optional declared touch-set). */
export interface DagFrontierItem {
  id: string;
  /** The plan item's effective lifecycle status (plans layer): todo / wip / done
   *  / dropped / blocked. Null ⇒ treated as todo. */
  effectiveStatus?: string | null;
  /** Declared dependency edges (the DAG): items this one is blocked-by. */
  blockedBy?: readonly string[] | null;
  /** Of `blockedBy`, the ones NOT yet satisfied (plans layer `unresolvedBlockers`).
   *  Empty ⇒ the item's dependencies are met (it is on the ready frontier). */
  unresolvedBlockers?: readonly string[] | null;
  /** Declared repo-relative file touch-set (admit-conflict-free) — surfaced so the
   *  view shows what a placement would touch. Optional. */
  files?: readonly string[] | null;
}

/** The per-item disposition in the fleet DAG view. */
export type DagItemStatus = 'done' | 'dropped' | 'claimed' | 'wip' | 'ready' | 'blocked';

export interface DagFrontierNode {
  id: string;
  status: DagItemStatus;
  blockedBy: string[];
  unresolvedBlockers: string[];
  /** The ownerId currently holding a live claim on this item, or null. */
  claimedBy: string | null;
  files: string[];
}

export type DagFrontierCounts = Record<DagItemStatus, number> & { total: number };

export interface DagFrontierView {
  items: DagFrontierNode[];
  counts: DagFrontierCounts;
}

const ZERO_COUNTS = (): DagFrontierCounts => ({
  done: 0,
  dropped: 0,
  claimed: 0,
  wip: 0,
  ready: 0,
  blocked: 0,
  total: 0,
});

/**
 * Classify one plan item's disposition. Precedence (highest first):
 *   terminal (done / dropped) > claimed (a live holder) > wip (in-flight but
 *   unclaimed) > blocked (sticky status or unsatisfied deps) > ready (todo, deps met — the
 *   frontier the spawner admits from). Pure.
 */
export function classifyDagItem(item: DagFrontierItem, claimedBy: string | null): DagItemStatus {
  const s = (item.effectiveStatus ?? 'todo').toLowerCase();
  if (s === 'done') return 'done';
  if (s === 'dropped') return 'dropped';
  if (claimedBy) return 'claimed';
  if (s === 'wip') return 'wip';
  // A plan item can be canonically blocked by an external/sticky gate even when
  // its dependency list is satisfied. Preserve that effective status instead of
  // treating the item as a placeable frontier row.
  if (s === 'blocked') return 'blocked';
  const unresolved = item.unresolvedBlockers ?? [];
  if (unresolved.length > 0) return 'blocked';
  return 'ready';
}

/**
 * Derive the item→holder claims map from the plan-item COVERAGE map
 * (getAllPlanItemCoverage — the fused work-item↔plan-item + direct-claim view,
 * already computed by the fleet:assignments handler). A coverage ref is
 * `<plan>#<item>`; entries not on `plan` are skipped, and the first worker (if
 * any) is taken as the item's holder. Reusing coverage (not a raw claim scan)
 * means `claimed` in the DAG view matches the SAME "is anyone on it" notion the
 * rest of fleet:assignments reports. Pure.
 */
export function claimsFromCoverage(
  coverage: Iterable<{ ref: string; workers?: readonly string[] | null }>,
  plan: string,
): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const c of coverage) {
    const hash = c.ref.indexOf('#');
    if (hash <= 0 || c.ref.slice(0, hash) !== plan) continue;
    const holder = c.workers?.[0];
    if (holder) claims[c.ref.slice(hash + 1)] = holder;
  }
  return claims;
}

/**
 * Shape the fleet DAG-filter view. `claims` maps a plan-item id → the ownerId
 * currently holding it (from harness_shared.fleet_assignment). Order-stable
 * (preserves the plan's item order). Pure — never mutates its inputs.
 */
export function shapeDagFrontier(
  items: readonly DagFrontierItem[],
  claims: Readonly<Record<string, string>> = {},
): DagFrontierView {
  const counts = ZERO_COUNTS();
  const nodes: DagFrontierNode[] = [];
  for (const item of items) {
    const claimedBy = claims[item.id] ?? null;
    const status = classifyDagItem(item, claimedBy);
    counts[status] += 1;
    counts.total += 1;
    nodes.push({
      id: item.id,
      status,
      blockedBy: [...(item.blockedBy ?? [])],
      unresolvedBlockers: [...(item.unresolvedBlockers ?? [])],
      claimedBy,
      files: [...(item.files ?? [])],
    });
  }
  return { items: nodes, counts };
}
