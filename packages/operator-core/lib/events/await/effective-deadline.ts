/**
 * effective-deadline.ts — a composed LEAF's real deadline, resolved from its root.
 *
 * P-016 of fleet-leadership-continuity-and-actuation-2026-08-01, the CLASS fix behind
 * P-015's single-surface one.
 *
 * THE DEFECT. A composed await (`events:await { spec }`) writes exactly ONE deadline,
 * on the root NODE (`event_await_nodes.expires_ts`). Its LEAF rows in `event_awaits`
 * are deadline-free on purpose — `insertComposedLeaf` writes `expires_ts = NULL`
 * because "the leaf owns no deadline — the ROOT owns the tree's timeout", and the root
 * ANCHOR row is NULL for the same reason (so the generic timeout sweep leaves it
 * alone). Correct for the FIRE path.
 *
 * Wrong for every READ path, because in the other ~99% of `event_awaits` rows a NULL
 * `expires_ts` means "waits forever". So a healthy 30-minute composed park reads as an
 * INDEFINITE one at every liveness surface that has not special-cased it — which, live
 * on 2026-07-26 (fleet push-not-poll), turned the most benign possible park into the
 * most alarming possible reading and produced a false fleet-halting-deadlock report to
 * the owner. P-015 fixed the one surface that produced that report; a leaf row is not
 * self-describing, so every other consumer can reach the same wrong conclusion.
 *
 * WHY A HELPER AND NOT ONLY THE VIEW. Migration 710 adds
 * `harness_shared.event_awaits_effective`, which is the right answer for ad-hoc and
 * analytic SQL (`dev:pg_query`) and for anything that can pick its own FROM. But the
 * TypeScript readers are the ones that feed the liveness surfaces, they funnel through
 * a handful of shared functions in store.ts, and several integration tests hand-roll
 * their own `event_awaits` DDL with no view and no nodes table. Resolving in the fold
 * therefore fixes the class for every TS consumer at once AND degrades to today's
 * behaviour on a schema that predates the tree tables, instead of turning a missing
 * relation into a failed liveness read.
 *
 * Shape: a PURE fold (unit-testable, no PG) plus a fail-soft IO seam — the
 * work-item-prior-work.ts / unanswered-directed.ts house pattern.
 */
import { getOrgPg } from '@papercusp/db-org';

/** The subset of a root node this resolution needs. */
export interface RootDeadline {
  expiresTs: string | null;
  timeoutBehavior: string | null;
}

/** Anything carrying a (possibly absent) deadline and a (possibly absent) tree root. */
export interface DeadlineBearing {
  expiresTs: string | null;
  rootId?: number | null;
}

/**
 * PURE: fill in each row's deadline from its tree root, where the row has none of its
 * own. Returns NEW objects — a decoration must not surprise a caller by mutating rows
 * it also holds elsewhere.
 *
 * A row's OWN `expiresTs` always wins. The helper only fills a gap, so an ordinary
 * (non-composed) await is returned untouched and can never be re-dated by this — which
 * is what makes it safe to apply unconditionally at a shared read.
 */
export function applyRootDeadlines<T extends DeadlineBearing>(
  rows: readonly T[],
  roots: ReadonlyMap<number, RootDeadline>,
): T[] {
  return rows.map((r) => {
    if (r.expiresTs != null) return r;
    if (r.rootId == null) return r;
    const root = roots.get(r.rootId);
    if (!root?.expiresTs) return r;
    return { ...r, expiresTs: root.expiresTs };
  });
}

/**
 * PURE: which root ids actually need a lookup — rows that are part of a tree AND have
 * no deadline of their own. Exported so the "one query, only when needed" property is
 * directly testable: the overwhelmingly common case (no composed awaits in the batch)
 * must issue NO query at all.
 */
export function rootIdsNeedingResolution(rows: readonly DeadlineBearing[]): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.expiresTs == null && r.rootId != null && Number.isFinite(r.rootId)) out.add(r.rootId);
  }
  return [...out];
}

/**
 * PURE: is this row's park still live at `nowMs`?
 *
 * The SQL-side `(expires_ts IS NULL OR expires_ts > now())` filter cannot see a leaf's
 * real deadline, so an EXPIRED composed leaf survives it and reads as an active park.
 * Applying this after resolution closes that half of the same defect: without it, the
 * fix would correct "parked forever" only to leave "parked" on a tree that already
 * timed out.
 */
export function isStillPending(row: DeadlineBearing, nowMs: number = Date.now()): boolean {
  if (row.expiresTs == null) return true;
  const ms = Date.parse(row.expiresTs);
  return !Number.isFinite(ms) || ms > nowMs;
}

/**
 * IO seam: read the deadline of each named root node.
 *
 * Fails SOFT to an empty map — on a schema without the tree tables (the hand-rolled
 * DDL in a few integration tests), or on any PG error, resolution simply does not
 * happen and the caller keeps today's raw values. A decoration must never be able to
 * fail the read it decorates.
 */
export async function fetchRootDeadlines(
  rootIds: readonly number[],
  opts: { workspaceId?: string } = {},
): Promise<Map<number, RootDeadline>> {
  const ids = [...new Set(rootIds.filter((n) => Number.isFinite(n)))];
  if (ids.length === 0) return new Map();
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT id, expires_ts, timeout_behavior
        FROM harness_shared.event_await_nodes
       WHERE id = ANY(${ids as number[]}::bigint[])
         ${opts.workspaceId ? sql`AND workspace_id = ${opts.workspaceId}` : sql``}
    `) as unknown as Array<{
      id: number | string;
      expires_ts: Date | string | null;
      timeout_behavior: string | null;
    }>;
    return new Map(
      rows.map((r) => [
        Number(r.id),
        {
          expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
          timeoutBehavior: r.timeout_behavior ?? null,
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The one call a shared reader makes: resolve every composed leaf's deadline from its
 * root, then (optionally) drop the ones whose tree has already lapsed.
 *
 * Costs ZERO extra queries for a batch containing no composed awaits, which is the
 * overwhelmingly common case.
 */
export async function withEffectiveDeadlines<T extends DeadlineBearing>(
  rows: readonly T[],
  opts: { workspaceId?: string; dropExpired?: boolean; nowMs?: number } = {},
): Promise<T[]> {
  const needed = rootIdsNeedingResolution(rows);
  const roots = needed.length > 0 ? await fetchRootDeadlines(needed, opts) : new Map<number, RootDeadline>();
  const resolved = applyRootDeadlines(rows, roots);
  if (!opts.dropExpired) return resolved;
  const now = opts.nowMs ?? Date.now();
  return resolved.filter((r) => isStillPending(r, now));
}
