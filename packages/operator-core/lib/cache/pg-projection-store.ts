/**
 * PgProjectionStore — a generic PG-backed `ProjectionStore` for
 * `@papercusp/projection-index` (caching-layer-tag-eca-2026-06-22 P-016).
 *
 * WHY: the audit found `projection-index` ships only the O(N) in-memory
 * `InMemoryProjectionStore` — fine for tests + tiny indexes, but a process-local,
 * un-durable, full-scan-per-query store. Any projection that must survive a
 * restart, span processes, or grow beyond memory needs a PG tier. This is that
 * tier, generic over the entry payload `E` (the existing `PgRationaleStore` is the
 * rationale-specific instance; this generalises the pattern to any projection).
 *
 * It backs `harness_shared.cache_l2`? NO — it backs ANY table shaped as the
 * projection-index identity triple `(source_id, key, entry_id)` + `kind` + `entry`
 * (jsonb) + `sort_key`. The table name is injected, so one store class serves
 * every projection. `rationale_index` (migration 154) is the canonical such table.
 *
 * ATOMICITY: `applyDelta` runs the deletes + upserts for one source in a single
 * transaction (`sql.begin`), so a re-projection can never leave the index
 * half-updated — the contract `ProjectionStore.applyDelta` requires.
 *
 * Read semantics (kinds-filter / sortKey-order / limit) are DELEGATED to the lib's
 * reference `InMemoryProjectionStore` so they are byte-identical to it by
 * construction — no re-implementation drift (same approach as PgRationaleStore).
 *
 * jsonb binding: `${JSON.stringify(x)}::text::jsonb` on the getOrgPg org pool
 * (agent-insights/postgres-js-jsonb-binding — `sql.json()` throws there).
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  InMemoryProjectionStore,
  type ProjectionStore,
  type IndexedEntry,
  type Delta,
  type IndexKey,
  type QueryOptions,
} from '@papercusp/projection-index';

type Row<E> = {
  source_id: string;
  key: string;
  entry_id: string;
  kind: string | null;
  entry: E;
  sort_key: string | null;
};

/**
 * A table that conforms to the projection-index column shape. `table` is a
 * fully-qualified, TRUSTED identifier (`harness_shared.<name>`) — it is interpolated
 * via `sql()` (an identifier, not a value), so it must NEVER be attacker-controlled.
 */
export interface PgProjectionStoreConfig {
  /** Fully-qualified table name, e.g. 'harness_shared.rationale_index'. Trusted. */
  table: string;
}

function rowToEntry<E>(r: Row<E>): IndexedEntry<E> {
  return {
    sourceId: r.source_id,
    key: r.key,
    entryId: r.entry_id,
    entry: r.entry,
    ...(r.kind != null ? { kind: r.kind } : {}),
    ...(r.sort_key != null ? { sortKey: r.sort_key } : {}),
  };
}

export class PgProjectionStore<E> implements ProjectionStore<E> {
  private readonly table: string;

  constructor(config: PgProjectionStoreConfig) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(config.table)) {
      throw new Error(`PgProjectionStore: table must be a simple schema.name identifier, got ${JSON.stringify(config.table)}`);
    }
    this.table = config.table;
  }

  async contributionsOf(sourceId: string): Promise<IndexedEntry<E>[]> {
    const { sql } = getOrgPg();
    const rows = await sql<Row<E>[]>`
      SELECT source_id, key, entry_id, kind, entry, sort_key
      FROM ${sql(this.table)}
      WHERE source_id = ${sourceId}`;
    return rows.map(rowToEntry);
  }

  /**
   * Atomically apply a per-source delta: delete the removed refs, upsert the puts,
   * in ONE transaction. A no-op delta short-circuits (no transaction). This is the
   * guarded mutation boundary — but the guard against a *bad source record* (a
   * projector that throws, a duplicate-contribution delta) belongs one level up in
   * the event loop, see `guardedApplyChange` — here we only guarantee atomicity.
   */
  async applyDelta(_sourceId: string, delta: Delta<E>): Promise<void> {
    if (delta.put.length === 0 && delta.delete.length === 0) return;
    const { sql } = getOrgPg();
    const table = sql(this.table);
    await sql.begin(async (tx) => {
      for (const ref of delta.delete) {
        await tx`
          DELETE FROM ${table}
          WHERE source_id = ${ref.sourceId} AND key = ${ref.key} AND entry_id = ${ref.entryId}`;
      }
      for (const e of delta.put) {
        const sortKey = e.sortKey === undefined ? null : String(e.sortKey);
        const kind = e.kind ?? null;
        await tx`
          INSERT INTO ${table}
            (source_id, key, entry_id, kind, entry, sort_key, updated_at)
          VALUES (${e.sourceId}, ${e.key}, ${e.entryId}, ${kind}, ${JSON.stringify(e.entry)}::text::jsonb, ${sortKey}, now())
          ON CONFLICT (source_id, key, entry_id) DO UPDATE SET
            kind = EXCLUDED.kind,
            entry = EXCLUDED.entry,
            sort_key = EXCLUDED.sort_key,
            updated_at = now()`;
      }
    });
  }

  async byKey(key: IndexKey, opts?: QueryOptions): Promise<IndexedEntry<E>[]> {
    const { sql } = getOrgPg();
    const rows = await sql<Row<E>[]>`
      SELECT source_id, key, entry_id, kind, entry, sort_key
      FROM ${sql(this.table)}
      WHERE key = ${key}`;
    // Delegate filter/sort/limit to the reference impl so semantics match exactly.
    const ref = new InMemoryProjectionStore<E>();
    await ref.applyDelta('_', { put: rows.map(rowToEntry), delete: [] });
    return ref.byKey(key, opts);
  }
}
