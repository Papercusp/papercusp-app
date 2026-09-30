/**
 * steerable-plans — the server-side projection behind the `plans.steerable`
 * sync query (no-http-anywhere-2026-07-28 D-071 / P-008).
 *
 * WHY THIS EXISTS. `MugTab` is the DEFAULT-OPEN tab of `LeftSidebar`, and
 * `LeftSidebar` is mounted for EVERY route (`routes/__root.tsx`). So in the
 * default UI state the Mug steering panel is live chrome on every screen —
 * and it held a subscription to the whole `plans.list` superset feed
 * (`{includeArchived:true, includeLegacy:true}`), re-fetched every 180s, to
 * render a checkbox list of steerable plans. Verified live 2026-08-03 by a
 * fiber walk on a headless rig at `/adv?tab=harnesses`: ONE observer on
 * `plans.list`, and it was MugTab (D-071 carries the full evidence).
 *
 * The `enabled: active` gate that was supposed to prevent this (D-030) is a
 * structural NO-OP: `LeftSidebar.tsx` renders ONLY the active tab and passes a
 * literal `true` (`active.render(true)`, unchanged since 2026-06-07), so
 * `active` is true whenever MugTab is mounted. Gating cannot fix a consumer
 * that IS the default.
 *
 * THE SHAPE OF THE FIX is the `plans.waitingCount` / `plans.attentionRefs`
 * precedent (D-034 / D-031), not narrower args: `usePlanList` deliberately
 * fetches the superset so every consumer shares ONE cache key (P-001, D-029),
 * and narrowing per call site re-multiplies the fetch. A DISTINCT, tiny
 * server-side projection sidesteps that entirely — the superset key keeps
 * serving the consumers that genuinely render full plan lists, and chrome
 * stops paying for it.
 *
 * The predicate is a PURE ROW PREDICATE over fields present on every row
 * (`status` / `archived` / `isLegacy`), which is the bar D-001 set for moving
 * a filter server-side — unlike `harnessSlug`, which is not reproducible from
 * row fields and silently dropped ~677 items when someone tried.
 */

/**
 * The six fields the Mug steering panel actually reads off a plan row.
 *
 * `harness` is load-bearing, not decoration: the nested hive→plan picker
 * (STEERING_POT_TREE, on by default) groups the checkboxes by owning hive via
 * `indexPlansByHive`, and a row whose harness does not match a hive option
 * renders as UNASSIGNED. Dropping it from this projection would silently move
 * every plan into the unassigned bucket — a rendering bug with no error.
 * `''` is the tree's own "unassigned" sentinel (TreePlanInput.harness), which
 * is why this one normalises to `''` rather than null.
 */
export interface SteerablePlanRow {
  slug: string;
  title: string | null;
  status: string | null;
  startStatus: string | null;
  updated: string | null;
  harness: string;
}

/** A `plans.list` row, narrowed to what this projection reads. Structural on
 *  purpose: the resolver receives whatever `callPlansRead('list', …)` returns
 *  and this module must not depend on the client-side `PlanListRow` type
 *  (which lives in the app tree, the wrong direction for operator-core). */
export interface PlanRowLike {
  slug?: unknown;
  title?: unknown;
  status?: unknown;
  startStatus?: unknown;
  updated?: unknown;
  archived?: unknown;
  isLegacy?: unknown;
  harness?: unknown;
}

/** Terminal statuses a steering candidate can never have. */
const TERMINAL_STATUSES = new Set(['shipped', 'superseded']);

/**
 * Rank mirrors the Mug panel's own ordering: in-flight first, then active,
 * then ready, then everything else. Kept here (not in the component) so the
 * server emits rows in render order and the panel does no sorting at all.
 */
export function steerablePlanRank(row: SteerablePlanRow): number {
  if (row.startStatus === 'started') return 0;
  if (row.status === 'active') return 1;
  if (row.status === 'ready') return 2;
  return 3;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Filter + project + sort, exactly reproducing what MugTab used to compute
 * client-side from the superset feed:
 *
 *   usePlanList superset
 *     -> filterPlanListRows({ includeArchived:false, includeLegacy:false })
 *     -> selectSteerablePlans (status not shipped/superseded, not archived)
 *     -> sort by rank, then `updated` descending
 *
 * Pure, so it is unit-testable without a database.
 */
export function selectSteerablePlanRows(rows: readonly PlanRowLike[] | undefined): SteerablePlanRow[] {
  if (!Array.isArray(rows)) return [];
  const out: SteerablePlanRow[] = [];
  for (const p of rows) {
    if (!p || typeof p !== 'object') continue;
    const slug = str(p.slug);
    if (!slug) continue;
    // filterPlanListRows({ includeArchived:false, includeLegacy:false })
    if (p.archived === true) continue;
    if (p.isLegacy === true) continue;
    // selectSteerablePlans: non-terminal only
    const status = str(p.status);
    if (status !== null && TERMINAL_STATUSES.has(status)) continue;
    out.push({
      slug,
      title: str(p.title),
      status,
      startStatus: str(p.startStatus),
      updated: str(p.updated),
      harness: str(p.harness) ?? '',
    });
  }
  out.sort(
    (a, b) => steerablePlanRank(a) - steerablePlanRank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''),
  );
  return out;
}
