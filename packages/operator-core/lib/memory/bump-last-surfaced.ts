/**
 * Bump memory_canonical.last_surfaced_at for a set of memory ids.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 5 P-021).
 *
 * Called from `injection.ts` after the fan-out merge. The only reader that
 * filters on the column is `recentlySurfacedIds` below (the re-inject guard),
 * which looks rows up by id through the primary key.
 *
 * ⚠ Keep this bump a HOT update: do NOT index `last_surfaced_at`. Migration
 * 1312 dropped `memory_canonical_recently_surfaced_idx` (from 085, built for a
 * "Layer 3 picker" that was never written) because an index on the bumped
 * column blocks HOT, so each bump rewrote the row's entries in every index on
 * the table, trigram GIN included: ~29 kB of WAL per row and 5.68 GB in total
 * (measured 2026-10-01, plan papercusp-log-performance-remediation-2026-09-23
 * P-015(d)). bump-last-surfaced-hot.integration.test.ts fails if that returns.
 *
 * Best-effort: any failure (column missing, PG down, malformed id) is
 * swallowed. The injection itself never depends on this side-effect.
 *
 * Schema dependency: requires migration 085 (`last_surfaced_at`
 * column). Probes once and caches; if the column is absent the helper
 * becomes a no-op for the rest of the process.
 */

export interface PgQueryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

let columnMissing = false;

/**
 * Stamp `last_surfaced_at = now()` for the provided memory ids.
 *
 * Returns true when the UPDATE ran (or there was nothing to do);
 * false on first-time column-missing detection (caller can log that
 * migration 085 hasn't applied yet).
 */
export async function bumpLastSurfaced(
  client: PgQueryable,
  memoryIds: string[],
): Promise<boolean> {
  if (memoryIds.length === 0) return true;
  if (columnMissing) return false;

  // Filter to valid uuid shape — the SQL ANY() takes a text[] so we
  // defend against an upstream caller that hands us a non-id string.
  // Mem0 always emits uuids; this is belt-and-suspenders.
  const ids = memoryIds.filter(
    (id) => typeof id === 'string' && /^[0-9a-f-]{20,}$/i.test(id),
  );
  if (ids.length === 0) return true;

  try {
    await client.query(
      `UPDATE harness_shared.memory_canonical
       SET last_surfaced_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return true;
  } catch (err) {
    // Two failure cases:
    //   1. column doesn't exist (migration 085 not applied) — cache as
    //      no-op for the rest of process lifetime so we don't retry
    //   2. transient PG error — log + return false but don't poison
    const msg = (err as Error)?.message ?? '';
    if (
      msg.includes('last_surfaced_at') ||
      msg.includes('column') ||
      /relation .* does not exist/.test(msg)
    ) {
      columnMissing = true;
    }
    return false;
  }
}

/**
 * postgres-js variant — takes the `sql` template-tag from
 * `getOrgPg().sql` instead of a node-pg Client. Used by injection.ts
 * which already plumbs through @papercusp/db-org.
 *
 * Same defensive posture as the node-pg variant.
 */
// `values` is `any[]` (not `unknown[]`) so the real postgres-js `Sql`
// from `getOrgPg().sql` is assignable — see the matching note in
// persist-anchors.ts.
export type SqlTag = <T = unknown>(
  template: TemplateStringsArray,
  ...values: any[]
) => Promise<T>;

export async function bumpLastSurfacedSql(
  sql: SqlTag,
  memoryIds: string[],
): Promise<boolean> {
  if (memoryIds.length === 0) return true;
  if (columnMissing) return false;

  const ids = memoryIds.filter(
    (id) => typeof id === 'string' && /^[0-9a-f-]{20,}$/i.test(id),
  );
  if (ids.length === 0) return true;

  try {
    await sql`
      UPDATE harness_shared.memory_canonical
      SET last_surfaced_at = now()
      WHERE id = ANY(${ids}::uuid[])
    `;
    return true;
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (
      msg.includes('last_surfaced_at') ||
      msg.includes('column') ||
      /relation .* does not exist/.test(msg)
    ) {
      columnMissing = true;
    }
    return false;
  }
}

/**
 * The subset of `memoryIds` whose `last_surfaced_at` is within the last
 * `windowMs` — i.e. memories already injected very recently. The pre-turn
 * injection uses this as a watermark-like "already-shown" guard so a stable
 * fact is not re-injected turn-over-turn (docs-and-memory-as-projections-2026-06-05
 * D-006). Best-effort: any error (column missing, PG down) returns an EMPTY set so
 * the caller degrades to no-dedup rather than dropping the whole injection.
 */
export async function recentlySurfacedIds(
  sql: SqlTag,
  memoryIds: string[],
  windowMs: number,
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (memoryIds.length === 0 || windowMs <= 0 || columnMissing) return empty;
  const ids = memoryIds.filter(
    (id) => typeof id === 'string' && /^[0-9a-f-]{20,}$/i.test(id),
  );
  if (ids.length === 0) return empty;
  const seconds = Math.ceil(windowMs / 1000);
  try {
    const rows = (await sql<{ id: string }[]>`
      SELECT id::text AS id
      FROM harness_shared.memory_canonical
      WHERE id = ANY(${ids}::uuid[])
        AND last_surfaced_at IS NOT NULL
        AND last_surfaced_at > now() - make_interval(secs => ${seconds})
    `) as unknown as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (msg.includes('last_surfaced_at') || msg.includes('column') || /relation .* does not exist/.test(msg)) {
      columnMissing = true;
    }
    return empty;
  }
}

/** Test hook: reset the column-missing cache. */
export function _resetForTests(): void {
  columnMissing = false;
}
