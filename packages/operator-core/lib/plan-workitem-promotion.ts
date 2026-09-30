/**
 * Plan → work-item promotion (unified-work-item-ledger-2026-06-21 P-003).
 *
 * The bug this fixes: `plans:start` only marks a plan `op_status='started'` and
 * fires a wake — it mints NO work-items. There is no auto-promotion, so a started
 * plan whose items were never hand-created as work-items leaves the Queen idle
 * (documented: 3 of 4 started plans yielded ZERO work-items). The fix: a SINGLE,
 * idempotent promotion that turns each OPEN plan-item into a placeable work-item
 * (D-002: the Queen also just calls `plans:start`, so there is one path for
 * human/su/Queen).
 *
 * This module is the PURE core — given the open plan-items and the set of
 * plan-item ids already promoted (read from existing work-items'
 * source_plan_item_ids), it computes the create-specs. It performs NO I/O, so it
 * is fully unit-testable; the DB wiring (read items, call createWorkItem, gate on
 * the flag) lives in the plans:start handler.
 */

/** An open (todo/wip/blocked/needs-human) plan item eligible for promotion. */
export interface OpenPlanItem {
  /** The plan-item id, e.g. "P-003". */
  id: string;
  /** The item's free text — becomes the work-item title (trimmed/clamped). */
  text: string;
}

/** The kind-independent spec the wiring feeds to createWorkItem(). */
export interface WorkItemCreateSpec {
  kind: 'feature';
  harness: string;
  title: string;
  sourcePlanSlug: string;
  /** The plan-item ids this work-item covers — the idempotency key with the slug. */
  sourcePlanItemIds: string[];
}

export interface PromotionInput {
  planSlug: string;
  harness: string;
  /** The plan's currently-open items (caller filters out done/dropped). */
  openItems: OpenPlanItem[];
  /**
   * Plan-item ids already covered by an existing work-item for THIS plan
   * (flattened from each existing work-item's source_plan_item_ids). The
   * idempotency guard: an item already promoted is never promoted again.
   */
  existingPromotedItemIds: Iterable<string>;
}

const MAX_TITLE = 200;

/** Build a clean, length-clamped work-item title from a plan-item. */
export function titleFromPlanItem(item: OpenPlanItem): string {
  const collapsed = (item.text ?? '').replace(/\s+/g, ' ').trim();
  const base = collapsed.length > 0 ? collapsed : item.id;
  return base.length > MAX_TITLE ? `${base.slice(0, MAX_TITLE - 1)}…` : base;
}

/**
 * Compute the work-items to create for a started+eligible plan. Idempotent:
 * re-running after the work-items exist returns []. Keyed on
 * (sourcePlanSlug, plan-item id) — never double-creates.
 */
export function computePromotions(input: PromotionInput): WorkItemCreateSpec[] {
  const already = new Set(input.existingPromotedItemIds);
  return input.openItems
    .filter((it) => !already.has(it.id))
    .map((it) => ({
      kind: 'feature' as const,
      harness: input.harness,
      title: titleFromPlanItem(it),
      sourcePlanSlug: input.planSlug,
      sourcePlanItemIds: [it.id],
    }));
}
