/**
 * WI-10005685: a `wall:` fact that names a plan item does NOT stop that item
 * from being placed. Plan placement reads PLAN STATE — the goal
 * `goal-plan-placement` obligation, the exact-plan admission preflight behind
 * `fleet:launch-on-plan` (`plan-admission-preflight.ts`: an item is admissible
 * while it is `todo`, unblocked and not `needsHuman`), and the claim scheduler.
 * None of them read `agent_facts`.
 *
 * Measured 2026-10-02 (goal 60d3a8, plan hud-orders-instant-load-2026-09-13):
 * a goal steward walled P-003 as protected-solo ONLY through
 * `facts:assert { key:'wall:hud-orders-p003-protected-solo' }` at 15:04:47Z
 * while P-003 stayed `todo`. Six successive goal holders then attempted
 * `fleet:launch-on-plan` on that plan seven times (14:12Z–19:22Z; two
 * succeeded before the wall, five were stopped only by unrelated gates), and
 * the wall string never appeared in any successor's kickoff transcript. The
 * lane stopped drawing launches only once a holder set P-003 `needs-human`
 * (20:53:21Z).
 *
 * So the assert receipt now names every plan item the wall body cites whose
 * plan state still admits placement, with the plan-state write that binds it.
 * Advisory and fail-soft like every other lint on this receipt: the fact is
 * still the durable human-readable record; it is just not the enforcement.
 */

/** A plan slug ends in its creation date (`<words>-YYYY-MM-DD`). */
const PLAN_SLUG = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-20\d{2}-\d{2}-\d{2})\b/g;
const PLAN_ITEM = /\bP-(\d{3,})\b/g;
/** A P-id binds to the nearest plan slug that precedes it within this window. */
const SLUG_TO_ITEM_MAX_CHARS = 160;

/** Plan states the placement paths still treat as live, unwalled work. */
const PLACEABLE_STATUSES: ReadonlySet<string> = new Set(['todo', 'wip']);

export interface WalledPlanItemRef {
  planSlug: string;
  itemId: string;
}

export interface WalledPlanItemState extends WalledPlanItemRef {
  status: string;
  /** The plan's harness; plans:set-status needs it. Null when unknown. */
  harness?: string | null;
}

export interface WallPlanStateWarning {
  code: 'wall-names-placeable-plan-item';
  items: WalledPlanItemState[];
  note: string;
  repair: string[];
}

/**
 * PURE: the (plan slug, item id) pairs a wall body cites. Each `P-NNN` binds to
 * the closest preceding plan slug within {@link SLUG_TO_ITEM_MAX_CHARS}; a P-id
 * with no slug in range is ignored rather than guessed. `#D-NNN` decision
 * anchors are not items and never match.
 */
export function extractWalledPlanItemRefs(body: string | null | undefined): WalledPlanItemRef[] {
  if (!body) return [];
  const slugs: Array<{ slug: string; end: number }> = [];
  for (const m of body.matchAll(PLAN_SLUG)) {
    slugs.push({ slug: m[1], end: (m.index ?? 0) + m[0].length });
  }
  if (slugs.length === 0) return [];
  const seen = new Set<string>();
  const out: WalledPlanItemRef[] = [];
  for (const m of body.matchAll(PLAN_ITEM)) {
    const at = m.index ?? 0;
    let bound: string | null = null;
    for (const s of slugs) {
      if (s.end > at) break;
      if (at - s.end <= SLUG_TO_ITEM_MAX_CHARS) bound = s.slug;
    }
    if (!bound) continue;
    const itemId = `P-${m[1]}`;
    const k = `${bound}\u0000${itemId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ planSlug: bound, itemId });
  }
  return out;
}

/** PURE: keep only cited items whose stored plan state still admits placement. */
export function placeableWalledItems(
  refs: readonly WalledPlanItemRef[],
  rows: readonly WalledPlanItemState[],
): WalledPlanItemState[] {
  const byKey = new Map(rows.map((r) => [`${r.planSlug}\u0000${r.itemId}`, r] as const));
  const out: WalledPlanItemState[] = [];
  for (const ref of refs) {
    const row = byKey.get(`${ref.planSlug}\u0000${ref.itemId}`);
    if (row && PLACEABLE_STATUSES.has(row.status)) out.push(row);
  }
  return out;
}

/** PURE: the receipt field, or null when nothing cited is still placeable. */
export function buildWallPlanStateWarning(items: readonly WalledPlanItemState[]): WallPlanStateWarning | null {
  if (items.length === 0) return null;
  const list = items.map((i) => `${i.planSlug} ${i.itemId} (${i.status})`).join(', ');
  return {
    code: 'wall-names-placeable-plan-item',
    items: [...items],
    note:
      `This wall names ${list}, which plan state still marks placeable. Goal placement ` +
      `obligations, fleet:launch-on-plan admission and claim scheduling read PLAN STATE, ` +
      `not facts, so successors will be told to place this item again (WI-10005685). ` +
      `Record the wall where they read it.`,
    repair: items.map(
      (i) =>
        `plans:set-status { slug: '${i.planSlug}', ` +
        (i.harness ? `harness: '${i.harness}', ` : '') +
        `item: '${i.itemId}', status: 'needs-human', note: '<the owner ask that clears this wall>' }`,
    ),
  };
}

export type WalledItemStatusReader = (
  workspaceId: string,
  refs: readonly WalledPlanItemRef[],
) => Promise<WalledPlanItemState[]>;

/** Production reader: the normalized `harness_shared.plan_items` rows for the cited pairs. */
export const readWalledItemStatusesPg: WalledItemStatusReader = async (workspaceId, refs) => {
  if (refs.length === 0) return [];
  const { boundedOrgTxn } = await import('../../pg-bounded-txn');
  const slugs = [...new Set(refs.map((r) => r.planSlug))];
  const items = [...new Set(refs.map((r) => r.itemId))];
  const rows = await boundedOrgTxn(
    (tx) => tx<{ plan_slug: string; item_id: string; status: string; harness_slug: string | null }[]>`
      SELECT plan_slug, item_id, status, harness_slug
        FROM harness_shared.plan_items
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ANY(${slugs}::text[])
         AND item_id = ANY(${items}::text[])`,
    { statementTimeoutMs: 1_500 },
  );
  return rows.map((r) => ({
    planSlug: r.plan_slug,
    itemId: r.item_id,
    status: r.status,
    harness: r.harness_slug,
  }));
};

/**
 * Runs only for a `wall:` key. Any read failure yields null: this is a receipt
 * advisory and must never fail or delay the write it annotates.
 */
export async function detectWallPlanStateGap(
  key: string,
  body: string,
  workspaceId: string | null,
  read: WalledItemStatusReader,
): Promise<WallPlanStateWarning | null> {
  if (!key.startsWith('wall:') || !workspaceId) return null;
  const refs = extractWalledPlanItemRefs(body);
  if (refs.length === 0) return null;
  try {
    return buildWallPlanStateWarning(placeableWalledItems(refs, await read(workspaceId, refs)));
  } catch {
    return null;
  }
}
