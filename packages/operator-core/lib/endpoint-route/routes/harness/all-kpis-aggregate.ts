/**
 * Pure aggregation helpers for `/harness/all/kpis`, split out of the route
 * handler so the row-shaping logic (which drove a couple of subtle-looking
 * decisions — what counts as "open" vs "acknowledged", what counts as
 * "active") is unit-testable without a database.
 */

/** A directive-status count row, as returned by the per-schema UNION ALL query. */
export interface DirectiveStatusCountRow {
  status: string;
  n: number;
}

/**
 * Tallies directive message counts into open vs acknowledged. Only the
 * `'pending'` status counts as open — every other status (acked, dismissed,
 * or any future status this dashboard doesn't yet know about) counts as
 * acknowledged, so a status added elsewhere in the system doesn't silently
 * vanish from both buckets.
 */
export function tallyDirectiveStatuses(
  rows: readonly DirectiveStatusCountRow[],
): { open: number; acknowledged: number } {
  let open = 0;
  let acknowledged = 0;
  for (const row of rows) {
    if (row.status === 'pending') open += row.n;
    else acknowledged += row.n;
  }
  return { open, acknowledged };
}

/** An executed-actions-by-op count row, as returned by the per-schema UNION ALL query. */
export interface OpCountRow {
  op: string;
  n: number;
}

/**
 * Aggregates per-op executed-action counts into a total plus a
 * `{ [op]: count }` breakdown. Duplicate `op` rows (e.g. from separate
 * per-schema queries that weren't pre-grouped) are summed, not overwritten.
 */
export function aggregateOpCounts(
  rows: readonly OpCountRow[],
): { total: number; byOp: Record<string, number> } {
  let total = 0;
  const byOp: Record<string, number> = {};
  for (const row of rows) {
    total += row.n;
    byOp[row.op] = (byOp[row.op] ?? 0) + row.n;
  }
  return { total, byOp };
}

/** An autoloop fire-state row, as returned from `harness_shared.autoloop_state`. */
export interface AutoloopStateRow {
  last_status: string | null;
}

/**
 * Counts autoloop rows considered "active" — currently `ok` (last fire
 * succeeded) or `firing` (in progress). Anything else (an error status,
 * `null`/never-fired) does not count as active.
 */
export function countActiveAutoloops(rows: readonly AutoloopStateRow[]): number {
  return rows.filter((r) => r.last_status === 'ok' || r.last_status === 'firing').length;
}
