/**
 * PgRationaleStore — the PG-backed `ProjectionStore` for the rationale projection
 * (docs-and-memory-as-projections-2026-06-05 D-003; Postgres-by-default policy).
 *
 * Backs `harness_shared.rationale_index` (migration 154). One row per persisted
 * contribution, keyed by the projection-index identity triple
 * `(source_id, key, entry_id)`. `applyDelta` is atomic per source (a transaction:
 * delete the refs, upsert the puts) so a re-projection can never leave the index
 * half-updated.
 *
 * Read semantics (filter `kinds` / sort over `sortKey` / `limit`) are delegated to
 * the lib's reference `InMemoryProjectionStore` so they are byte-identical to it by
 * construction (the conformance test asserts this) — no re-implementation drift.
 * `sortKey` is persisted as text; the projector only ever emits ISO-date strings or
 * `undefined`, both of which round-trip and sort correctly as text.
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
import type { RationaleEntry } from './types';

type Row = {
  source_id: string;
  key: string;
  entry_id: string;
  kind: string | null;
  entry: RationaleEntry;
  sort_key: string | null;
};

function rowToEntry(r: Row): IndexedEntry<RationaleEntry> {
  return {
    sourceId: r.source_id,
    key: r.key,
    entryId: r.entry_id,
    entry: r.entry,
    ...(r.kind != null ? { kind: r.kind } : {}),
    ...(r.sort_key != null ? { sortKey: r.sort_key } : {}),
  };
}

export class PgRationaleStore implements ProjectionStore<RationaleEntry> {
  async contributionsOf(sourceId: string): Promise<IndexedEntry<RationaleEntry>[]> {
    const { sql } = getOrgPg();
    const rows = await sql<Row[]>`
      SELECT source_id, key, entry_id, kind, entry, sort_key
      FROM harness_shared.rationale_index
      WHERE source_id = ${sourceId}`;
    return rows.map(rowToEntry);
  }

  async applyDelta(_sourceId: string, delta: Delta<RationaleEntry>): Promise<void> {
    if (delta.put.length === 0 && delta.delete.length === 0) return;
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      for (const ref of delta.delete) {
        await tx`
          DELETE FROM harness_shared.rationale_index
          WHERE source_id = ${ref.sourceId} AND key = ${ref.key} AND entry_id = ${ref.entryId}`;
      }
      for (const e of delta.put) {
        const sortKey = e.sortKey === undefined ? null : String(e.sortKey);
        const kind = e.kind ?? null;
        // jsonb on the getOrgPg org pool MUST be bound as `${JSON.stringify(x)}::text::jsonb`
        // — sql.json() throws ("Buffer.byteLength received Object") and a bare object
        // mis-binds on this pool (agent-insights/postgres-js-jsonb-binding).
        await tx`
          INSERT INTO harness_shared.rationale_index
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

  async byKey(key: IndexKey, opts?: QueryOptions): Promise<IndexedEntry<RationaleEntry>[]> {
    const { sql } = getOrgPg();
    const rows = await sql<Row[]>`
      SELECT source_id, key, entry_id, kind, entry, sort_key
      FROM harness_shared.rationale_index
      WHERE key = ${key}`;
    // Delegate sort/filter/limit to the reference impl so semantics match exactly.
    const ref = new InMemoryProjectionStore<RationaleEntry>();
    await ref.applyDelta('_', { put: rows.map(rowToEntry), delete: [] });
    return ref.byKey(key, opts);
  }
}
