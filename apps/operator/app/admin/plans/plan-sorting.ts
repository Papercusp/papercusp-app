/**
 * Plan rail sort orders.
 *
 * Extracted from PlanRail (which hardcoded one order) so the comparator
 * is pure + unit-testable and PlanFilters can render the same option
 * list. The rail reads the selected order from the `pSort` nuqs key;
 * PlanFilters owns the write (same split as the filter keys).
 *
 * `default` preserves the original smart order: live buckets first
 * (running → ready → draft → shipped → rejected), explicit dispatch
 * priority within running, then last-updated descending. Every other
 * order is a flat sort across buckets.
 */

import { bucketOf, IMPORTANCE_LEVELS, type Importance, type PlanBucket, type PlanListRow } from './plans-api';

export type PlanSort =
  | 'default'
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'needs-human'
  | 'urgency'
  | 'blocked'
  | 'priority'
  | 'progress'
  | 'title';

export const PLAN_SORTS: ReadonlyArray<{ id: PlanSort; label: string }> = [
  { id: 'default', label: 'Smart order' },
  { id: 'updated-desc', label: 'Recently updated' },
  { id: 'updated-asc', label: 'Oldest updated' },
  { id: 'created-desc', label: 'Recently created' },
  { id: 'created-asc', label: 'Oldest created' },
  { id: 'needs-human', label: 'Needs human' },
  { id: 'urgency', label: 'Most urgent' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'priority', label: 'Priority' },
  { id: 'progress', label: 'Progress' },
  { id: 'title', label: 'Title A–Z' },
];

export const PLAN_SORT_IDS: PlanSort[] = PLAN_SORTS.map((s) => s.id);

export function planSortLabel(sort: PlanSort): string {
  return PLAN_SORTS.find((s) => s.id === sort)?.label ?? sort;
}

/** Rail bucket order under the default sort: live/actionable first, terminals last. */
const BUCKET_ORDER: Record<PlanBucket, number> = {
  running: 0,
  ready: 1,
  draft: 2,
  awaiting: 3,
  shipped: 4,
  rejected: 5,
};

/**
 * Compare ISO-ish date strings lexicographically (frontmatter dates are
 * `YYYY-MM-DD[…]`, so string order IS chronological order). Plans missing
 * the date sort last in BOTH directions — an undated plan is "unknown",
 * not "oldest". `undefined` is tolerated for rows from a server that
 * predates the field (e.g. `created` mid-rollout).
 */
function cmpDate(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: 1 | -1,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return dir * a.localeCompare(b);
}

/**
 * Fraction of items done (0..1), or null when the plan has no items.
 * Counts every item including dropped — mirrors PlanRail's
 * PlanProgressBar so the sort agrees with the bar the row renders.
 */
export function planProgress(counts: PlanListRow['itemCounts']): number | null {
  if (!counts) return null;
  let done = 0;
  let total = 0;
  for (const [k, v] of Object.entries(counts)) {
    const n = v ?? 0;
    total += n;
    if (k === 'done') done += n;
  }
  return total === 0 ? null : done / total;
}

/** Stable tail: most-recently-updated first, then slug. */
function tiebreak(a: PlanListRow, b: PlanListRow): number {
  return cmpDate(a.updated, b.updated, -1) || a.slug.localeCompare(b.slug);
}

function countOf(p: PlanListRow, key: 'needs-human' | 'blocked'): number {
  return (p.itemCounts ?? {})[key] ?? 0;
}

/** Most → least urgent, per IMPORTANCE_LEVELS order. */
const IMPORTANCE_RANK: Record<Importance, number> = Object.fromEntries(
  IMPORTANCE_LEVELS.map((level, i) => [level, i]),
) as Record<Importance, number>;

/**
 * Comparator for the given sort order. Selected-plan pinning is NOT
 * applied here — that's rail-local UI state PlanRail layers on top.
 */
export function comparePlans(
  sort: PlanSort,
): (a: PlanListRow, b: PlanListRow) => number {
  switch (sort) {
    case 'updated-desc':
      return (a, b) => cmpDate(a.updated, b.updated, -1) || a.slug.localeCompare(b.slug);
    case 'updated-asc':
      return (a, b) => cmpDate(a.updated, b.updated, 1) || a.slug.localeCompare(b.slug);
    case 'created-desc':
      return (a, b) => cmpDate(a.created, b.created, -1) || tiebreak(a, b);
    case 'created-asc':
      return (a, b) => cmpDate(a.created, b.created, 1) || tiebreak(a, b);
    case 'needs-human':
      // Biggest waiting-on-a-human pile first — "rank my inbox".
      return (a, b) => countOf(b, 'needs-human') - countOf(a, 'needs-human') || tiebreak(a, b);
    case 'blocked':
      // Most-stuck plans first.
      return (a, b) => countOf(b, 'blocked') - countOf(a, 'blocked') || tiebreak(a, b);
    case 'urgency':
      // Hottest OPEN item wins (urgent > high > normal > low); plans with
      // no open items (maxImportance null, or a pre-field server) last.
      return (a, b) => {
        const ra = a.maxImportance ? IMPORTANCE_RANK[a.maxImportance] : 99;
        const rb = b.maxImportance ? IMPORTANCE_RANK[b.maxImportance] : 99;
        return ra - rb || tiebreak(a, b);
      };
    case 'priority':
      // Dispatch rank: lower = dispatched first; unranked plans last.
      return (a, b) => {
        const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
        const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
        return pa - pb || tiebreak(a, b);
      };
    case 'progress':
      // Closest to done first; plans with no items last.
      return (a, b) => {
        const ga = planProgress(a.itemCounts);
        const gb = planProgress(b.itemCounts);
        if (ga === null && gb === null) return tiebreak(a, b);
        if (ga === null) return 1;
        if (gb === null) return -1;
        return gb - ga || tiebreak(a, b);
      };
    case 'title':
      return (a, b) =>
        (a.title ?? a.slug).localeCompare(b.title ?? b.slug, undefined, {
          sensitivity: 'base',
        }) || a.slug.localeCompare(b.slug);
    case 'default':
      return (a, b) => {
        const sa = BUCKET_ORDER[bucketOf(a)] ?? 99;
        const sb = BUCKET_ORDER[bucketOf(b)] ?? 99;
        if (sa !== sb) return sa - sb;
        // Within the running bucket: explicit dispatch priority first
        // (lower first, null last) — the order drag-to-reorder edits.
        if (sa === BUCKET_ORDER.running) {
          const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
          const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
          if (pa !== pb) return pa - pb;
        }
        return cmpDate(a.updated, b.updated, -1);
      };
  }
}
