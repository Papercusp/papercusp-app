/**
 * containment-tree — resolve the CONTAINMENT TREE for a continuity ref
 * (effort-scoped-continuity-2026-09-02 P-016, D-007/D-008/D-020).
 *
 * D-007's model, restated so this file can be read on its own:
 *
 *   WRITE attaches to the most specific object the agent is actually working at —
 *   goal, plan, or work-item. The LEVEL OF THE NOTE MATCHES THE LEVEL OF THE INSIGHT.
 *   READ of a level = that level's own history UNION every descendant's history,
 *   nearest-first.
 *
 * This module owns ONLY the edge resolution — who contains whom, in both
 * directions. It mints NO identity and adds NO schema: every edge is a column
 * that already exists and is already populated.
 *
 *   work_items.source_plan_slug   item  → plan
 *   work_items.goal_id            item  → goal
 *   harness_plans.goal_id         plan  → goal
 *
 * and `coord_threads`' UNIQUE (workspace_id, parent_kind, parent_ref) already
 * admits all three parent kinds, so the thread that carries a level's own history
 * needs no migration either (measured 2026-09-02: parent_kind holds issue 23,883 /
 * conversation 694 / feature 144 — `plan` and `goal` are legal keys with zero rows,
 * i.e. UNUSED, not unsupported).
 *
 * ⚠ DIRECTION MATTERS AND THE TWO DIRECTIONS HAVE DIFFERENT COSTS.
 *  - UPWARD (ancestors) is O(1) joins and bounded by the tree's depth (max 2). It is
 *    safe on a member's claim path, and it is the direction that answers "what has
 *    my plan already ruled?".
 *  - DOWNWARD (descendants) is a transitive closure whose fan-out is unbounded in
 *    principle — measured 2026-09-02, the worst plan in this workspace carries 126
 *    items. D-007 states the consequence plainly: the rollup read is a LEADER read,
 *    not a member read. So descent is OPT-IN ({@link ContainmentDirection}), CAPPED
 *    ({@link DESCENDANT_FANOUT_CAP}), and its remainder is DISCLOSED as refs rather
 *    than silently dropped (P-019).
 *
 * D-020/P-020: the goal rung is ADMITTED here and deliberately NOT TUNED. Measured
 * 2026-09-02: 12 distinct goals, 30 open items carrying a goal_id, and exactly ONE
 * goal with any plan attached. Tuning a two-level goal rollup against n=1 is tuning
 * against noise, so the ontology admits `goal` (resolution, thread parent kind,
 * scope rung) and nothing wires a goal rollup into a member's claim path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { boundedPgReadTxn } from './pg-read-query';
import { resolveConcreteWorkspaceId } from './workspace-registry';

/** The three levels an effort can be worked at (D-007). Ordered coarse → fine. */
export type ContainmentKind = 'goal' | 'plan' | 'work_item';

/** Coarse → fine, so `CONTAINMENT_LEVEL[a] < CONTAINMENT_LEVEL[b]` means a CONTAINS b. */
export const CONTAINMENT_LEVEL: Record<ContainmentKind, number> = {
  goal: 0,
  plan: 1,
  work_item: 2,
};

export interface ContainmentRef {
  kind: ContainmentKind;
  ref: string;
  /** The harness the object lives under. Null for a harness-null issue-family item. */
  harness?: string | null;
}

export interface ContainmentNode extends ContainmentRef {
  /**
   * Hops from the REQUESTED ref. 0 = the ref itself; positive in BOTH directions
   * (an ancestor at 1 is the immediate parent, a descendant at 1 an immediate child).
   * D-008 spends the read budget against this number, so it is the tree's only
   * cost-bearing field.
   */
  depth: number;
  /** Human-facing label when one is cheap to carry (plan title, goal title, item title). */
  title?: string | null;
}

export type ContainmentDirection = 'up' | 'down' | 'both';

export interface ResolveContainmentOptions {
  workspaceId?: string;
  /** Harness scope for plan/feature-family lookups. */
  harness?: string | null;
  /**
   * `up` (DEFAULT) resolves ancestors only — the member-safe direction. `down` and
   * `both` add the descendant closure and are LEADER reads (D-007); a caller on a
   * member's claim path must not pass them.
   */
  direction?: ContainmentDirection;
  /** Max descendants admitted before the remainder is disclosed as refs (P-019). */
  maxDescendants?: number;
  /** Exclude the observation lane from descendants. Default true — an observation is
   *  a turn-end reflection, never work (repo convention), so it is not effort history. */
  excludeObservationLane?: boolean;
}

/**
 * P-019 fan-out cap. Measured 2026-09-02 across 409 plans carrying items: avg 7.8,
 * p90 16, WORST 126. 24 admits the p90 plan whole and discloses the tail of the
 * long one, which is the shape D-008 requires — a rollup that silently drops
 * children is the failure P-019 exists to prevent.
 */
export const DESCENDANT_FANOUT_CAP = 24;

/**
 * P-019: how many omitted descendant refs a resolution carries. A ref is ~60 bytes
 * against a record's ~700, so retrievability is cheap next to detail — but it is
 * still bounded, and exhaustion is reported rather than inferred.
 */
export const OMITTED_DESCENDANT_REF_CAP = 200;

export interface ContainmentTree {
  /** A failed edge read is not evidence that this object has no relationships. */
  unavailable?: 'scope-unresolved' | 'read-failed';
  root: ContainmentNode;
  /** Nearest-first: index 0 is the immediate parent. Max length 2 (item→plan→goal). */
  ancestors: ContainmentNode[];
  /** Priority-ordered and capped. Empty unless `direction` asked to descend. */
  descendants: ContainmentNode[];
  /** P-019: the identity of every descendant the cap left out, so the omission is auditable. */
  omittedDescendants: ContainmentRef[];
  /** True when even `omittedDescendants` had to be cut — without it an exhausted
   *  list is indistinguishable from a complete one. */
  omittedDescendantsTruncated: boolean;
  fanOut: {
    /** Descendants actually admitted into `descendants`. */
    admitted: number;
    /** Descendants the edges resolved, before the cap. */
    total: number;
    cap: number;
    /** True when `total > admitted` — i.e. the read is a SAMPLE, not the whole tree. */
    truncated: boolean;
  };
  /** Whether descent ran at all. `false` means `descendants: []` is "not asked for",
   *  NOT "none exist" — the distinction a caller must not have to guess. */
  descended: boolean;
}

/** The coord ObjectRef kind a containment level's own thread hangs from.
 *  `work_item` is deliberately absent: its parent kind is FAMILY-dependent
 *  (issue vs feature) and only `workItemObjectRef` may decide it. */
export const CONTAINMENT_THREAD_KIND = {
  goal: 'goal',
  plan: 'plan',
} as const satisfies Partial<Record<ContainmentKind, string>>;

/**
 * The `coord_threads.parent_ref` for a PLAN.
 *
 * Harness-qualified for the same reason `workItemObjectRef` qualifies a feature ref:
 * `harness_plans` is keyed (workspace_id, harness_slug, plan_slug), so a bare slug is
 * NOT unique across harnesses and an unqualified parent_ref would silently merge two
 * different plans' histories into one thread. A missing harness is therefore a bug,
 * not a default — fail loud rather than key under `:<slug>`.
 */
export function planThreadRef(harness: string | null | undefined, planSlug: string): string {
  const h = harness?.trim();
  if (!h || h === '*') {
    throw new Error(
      `planThreadRef: plan "${planSlug}" has no harness — its thread parent_ref would collide ` +
        `across harnesses (coord dedup corruption). Pass the plan's harness.`,
    );
  }
  return `${h}:${planSlug}`;
}

/** The `coord_threads.parent_ref` for a GOAL. Goal ids are workspace-unique
 *  (harness_shared.goals.id), so unlike a plan slug they need no qualification. */
export function goalThreadRef(goalId: string): string {
  return goalId;
}

interface ItemEdgeRow {
  feature_id: string;
  harness_slug: string | null;
  source_plan_slug: string | null;
  goal_id: string | null;
  title: string | null;
}

interface PlanEdgeRow {
  plan_slug: string;
  harness_slug: string | null;
  goal_id: string | null;
  title: string | null;
}

/**
 * Resolve the containment tree around one ref.
 *
 * Fails SOFT: a resolution error yields the root alone rather than throwing, because
 * every caller is a continuity-enrichment path where a missing ancestor must degrade
 * to "no ancestor" and never to a failed claim.
 */
export async function resolveContainmentTree(
  target: ContainmentRef,
  opts: ResolveContainmentOptions = {},
): Promise<ContainmentTree> {
  const ws = resolveConcreteWorkspaceId(opts.workspaceId);
  const direction: ContainmentDirection = opts.direction ?? 'up';
  const wantsUp = direction === 'up' || direction === 'both';
  const wantsDown = direction === 'down' || direction === 'both';
  const cap = Math.max(1, opts.maxDescendants ?? DESCENDANT_FANOUT_CAP);
  const root: ContainmentNode = { ...target, depth: 0 };
  const empty: ContainmentTree = {
    root,
    ancestors: [],
    descendants: [],
    omittedDescendants: [],
    omittedDescendantsTruncated: false,
    fanOut: { admitted: 0, total: 0, cap, truncated: false },
    descended: wantsDown,
  };
  if (!ws || !target.ref) return { ...empty, unavailable: 'scope-unresolved' };

  try {
    const ancestors = wantsUp ? await resolveAncestors(ws, target, opts) : [];
    const down = wantsDown
      ? await resolveDescendants(ws, target, { ...opts, cap })
      : { nodes: [], total: 0, omitted: [], omittedTruncated: false };
    return {
      root: { ...root, harness: root.harness ?? ancestors[0]?.harness ?? opts.harness ?? null },
      ancestors,
      descendants: down.nodes,
      omittedDescendants: down.omitted,
      omittedDescendantsTruncated: down.omittedTruncated,
      fanOut: {
        admitted: down.nodes.length,
        total: down.total,
        cap,
        truncated: down.total > down.nodes.length,
      },
      descended: wantsDown,
    };
  } catch {
    return { ...empty, unavailable: 'read-failed' };
  }
}

/** item → plan → goal, or plan → goal. Nearest-first. */
async function resolveAncestors(
  ws: string,
  target: ContainmentRef,
  opts: ResolveContainmentOptions,
): Promise<ContainmentNode[]> {
  const { sql } = getOrgPg();
  if (target.kind === 'goal') return [];

  if (target.kind === 'plan') {
    const rows = await boundedPgReadTxn<PlanEdgeRow[]>(
      (tx) => tx`
        SELECT plan_slug, harness_slug, goal_id, title
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws} AND plan_slug = ${target.ref}
           AND (${target.harness ?? opts.harness ?? null}::text IS NULL
                OR harness_slug = ${target.harness ?? opts.harness ?? null})
         LIMIT 1`,
      { client: sql },
    );
    const goalId = rows[0]?.goal_id;
    return goalId ? [{ kind: 'goal', ref: goalId, harness: null, depth: 1 }] : [];
  }

  // work_item: read its own edges, then the plan's goal as the fallback goal edge.
  const rows = await boundedPgReadTxn<ItemEdgeRow[]>(
    (tx) => tx`
      SELECT feature_id, harness_slug, source_plan_slug, goal_id, title
        FROM harness_shared.work_items
       WHERE workspace_id = ${ws} AND feature_id = ${target.ref}
       LIMIT 1`,
    { client: sql },
  );
  const item = rows[0];
  if (!item) return [];
  const out: ContainmentNode[] = [];
  const planHarness = item.harness_slug ?? target.harness ?? opts.harness ?? null;
  if (item.source_plan_slug) {
    out.push({ kind: 'plan', ref: item.source_plan_slug, harness: planHarness, depth: 1 });
  }
  // An item's OWN goal_id wins; otherwise inherit the plan's. Inheriting matters:
  // measured 2026-09-02 only 30 open items carry a goal_id directly, so the plan's
  // goal is the only route most plan-backed work has to its goal level at all.
  let goalId = item.goal_id ?? null;
  if (!goalId && item.source_plan_slug) {
    const planRows = await boundedPgReadTxn<PlanEdgeRow[]>(
      (tx) => tx`
        SELECT plan_slug, harness_slug, goal_id, title
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws} AND plan_slug = ${item.source_plan_slug}
           AND (${planHarness}::text IS NULL OR harness_slug = ${planHarness})
         LIMIT 1`,
      { client: sql },
    );
    goalId = planRows[0]?.goal_id ?? null;
  }
  if (goalId) {
    // Depth counts HOPS, so a goal reached through a plan sits at 2 and a goal
    // reached directly (an item with a goal_id and no plan) sits at 1. D-008 spends
    // the budget against this number, so collapsing the two would buy the orphan's
    // goal the same resolution as its own plan.
    out.push({ kind: 'goal', ref: goalId, harness: null, depth: out.length ? 2 : 1 });
  }
  return out;
}

interface DescendantResult {
  nodes: ContainmentNode[];
  total: number;
  omitted: ContainmentRef[];
  omittedTruncated: boolean;
}

/**
 * goal → plans → items, or plan → items.
 *
 * PRIORITY ORDER is not recency alone: a descendant that CARRIES HISTORY is what a
 * rollup exists to surface, so items with a checkpoint sort first, then by recency.
 * One LEFT JOIN against the carry-note the checkpoint already writes; no new store,
 * and it is the same key `workItemScope` builds (`workitem:<harness>:<id>`, with the
 * null-harness sentinel `*` — see work-item-checkpoint.ts's checkpointScopeHarness).
 */
async function resolveDescendants(
  ws: string,
  target: ContainmentRef,
  opts: ResolveContainmentOptions & { cap: number },
): Promise<DescendantResult> {
  const { sql } = getOrgPg();
  const excludeObservations = opts.excludeObservationLane ?? true;
  const harness = target.harness ?? opts.harness ?? null;
  if (target.kind === 'work_item') {
    return { nodes: [], total: 0, omitted: [], omittedTruncated: false };
  }

  // One past the admitted + disclosed bounds is an exhaustion sentinel. Without
  // it, the 25th child plan disappeared behind a LIMIT 24 while fanOut claimed the
  // 24-row sample was complete; the same exact-boundary lie affected item tails.
  const fetchLimit = opts.cap + OMITTED_DESCENDANT_REF_CAP + 1;
  const childPlans: ContainmentNode[] = [];
  if (target.kind === 'goal') {
    const rows = await boundedPgReadTxn<PlanEdgeRow[]>(
      (tx) => tx`
        SELECT plan_slug, harness_slug, goal_id, title
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws} AND goal_id = ${target.ref}
           AND archived IS NOT TRUE
         ORDER BY updated_at DESC NULLS LAST
         LIMIT ${fetchLimit}`,
      { client: sql },
    );
    for (const row of rows) {
      childPlans.push({
        kind: 'plan',
        ref: row.plan_slug,
        harness: row.harness_slug,
        depth: 1,
        title: row.title,
      });
    }
  }

  // The item leg. For a plan target that is its own items; for a goal target it is
  // items carrying the goal directly PLUS items of the goal's plans — one query, so
  // the two-join closure D-007 describes costs one round-trip rather than N.
  const planSlugs = target.kind === 'plan' ? [target.ref] : childPlans.map((p) => p.ref);
  const goalId = target.kind === 'goal' ? target.ref : null;
  const itemDepth = target.kind === 'goal' ? 2 : 1;
  // Fetch one page beyond the cap so `total` can report that MORE exist without
  // paying for the whole 126-item tail; the surplus becomes the disclosed refs.
  const rows = await boundedPgReadTxn<(ItemEdgeRow & { has_checkpoint: boolean })[]>(
    (tx) => tx`
      SELECT w.feature_id, w.harness_slug, w.source_plan_slug, w.goal_id, w.title,
             (cn.scope IS NOT NULL) AS has_checkpoint
        FROM harness_shared.work_items w
        LEFT JOIN harness_shared.carry_notes cn
               ON cn.workspace_id = w.workspace_id
              AND cn.scope = 'workitem:' || COALESCE(NULLIF(w.harness_slug, ''), '*') || ':' || w.feature_id
       WHERE w.workspace_id = ${ws}
         AND (
           (${planSlugs.length > 0} AND w.source_plan_slug = ANY(${planSlugs}::text[]))
           OR (${goalId}::text IS NOT NULL AND w.goal_id = ${goalId})
         )
         AND (${harness}::text IS NULL OR w.harness_slug = ${harness} OR w.harness_slug IS NULL)
         AND (${!excludeObservations} OR w.lane IS DISTINCT FROM 'observation')
       ORDER BY has_checkpoint DESC, w.updated_ts DESC NULLS LAST, w.feature_id
       LIMIT ${fetchLimit}`,
    { client: sql },
  );

  const itemNodes: ContainmentNode[] = rows.map((row) => ({
    kind: 'work_item' as const,
    ref: row.feature_id,
    harness: row.harness_slug,
    depth: itemDepth,
    title: row.title,
  }));

  // Nearer descendants are admitted before further ones — a goal's own plans outrank
  // its grandchildren items, because a plan's thread is where a leader's cross-item
  // rulings live and losing those to item chatter inverts D-007's whole point.
  const ordered = [...childPlans, ...itemNodes];
  const nodes = ordered.slice(0, opts.cap);
  const rest = ordered.slice(opts.cap);
  const omitted = rest.slice(0, OMITTED_DESCENDANT_REF_CAP).map(({ kind, ref, harness: h }) => ({
    kind,
    ref,
    harness: h,
  }));
  return {
    nodes,
    total: ordered.length,
    omitted,
    omittedTruncated: rest.length > omitted.length,
  };
}

/**
 * The most specific level a caller is working at, given whatever refs it holds.
 * This is P-017's DEFAULT write target: "the most specific object the caller holds,
 * which for 94% of items is the item itself" (measured 2026-09-02: of 16,792 open
 * items, 15,791 carry neither a plan nor a goal).
 */
export function mostSpecificLevel(refs: {
  workItemId?: string | null;
  planSlug?: string | null;
  goalId?: string | null;
}): ContainmentKind | null {
  if (refs.workItemId?.trim()) return 'work_item';
  if (refs.planSlug?.trim()) return 'plan';
  if (refs.goalId?.trim()) return 'goal';
  return null;
}
