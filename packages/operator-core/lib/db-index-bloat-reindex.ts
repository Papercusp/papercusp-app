/**
 * db-index-bloat-reindex.ts — the single-run body of the index-bloat maintenance
 * routine (db-performance-remediation-2026-07-26 P-004). Kept separate from the DBOS
 * scheduled wrapper in lib/dbos/periodic-workflows.ts so it integration-tests without
 * the scheduler (mirrors runRecipeHygieneOnce / runEmbedBackfillOnce).
 *
 * WHY THIS EXISTS
 * ---------------
 * The high-churn telemetry tables are pruned continuously by retention (route_invocations
 * alone took 35.2M deletes against 20.5M inserts while holding only a 7-day / 2M-row
 * window). VACUUM marks the emptied btree pages reusable but never returns them, so the
 * indexes grow monotonically as mostly-empty pages. Measured on 2026-07-26 before the
 * first sweep: route_invocations carried 5.1 GB of index on 711 MB of heap, and
 * `route_invocations_ws_time_idx` alone was 4117 MB at 2122 bytes/row — it rebuilt to
 * 99 MB (50 bytes/row) in 5 seconds. The whole first pass took the database from
 * 22 GB to 14 GB in 33 seconds.
 *
 * A one-off REINDEX is therefore only a MITIGATION: retention keeps deleting ~2M rows a
 * day, so the bloat returns. This routine is the durable fix — it re-runs the same sweep
 * on a cadence so the class cannot recur.
 *
 * HOW A CANDIDATE IS CHOSEN (cheap catalog read, no index scan)
 * ------------------------------------------------------------
 * pgstattuple's `avg_leaf_density` would be the precise signal, but it must scan the
 * whole index to compute, which is far too expensive to run routinely just to DECIDE.
 * Instead we use a purely catalog-derived heuristic that cost nothing and correctly
 * identified all 12 bloated indexes in the audit:
 *   - btree only — GIN/HNSW/GiST/BRIN are legitimately dense and must never be swept
 *     here (an HNSW vector index at 1598 bytes/row is CORRECT, not bloat);
 *   - size >= minBytes, so we never churn on trivia;
 *   - bytes-per-row > maxBytesPerRow, the bloat signal itself;
 *   - AND the parent table shows real delete churn (n_tup_del >= minTableDeletes) —
 *     churn is the actual CAUSE, so this keeps a legitimately-wide index on an
 *     append-only table from being rebuilt forever.
 * A false positive costs one cheap online rebuild, which is why the loose heuristic is
 * preferred over the expensive precise one.
 *
 * SAFETY
 * ------
 *   - REINDEX INDEX CONCURRENTLY only: no ACCESS EXCLUSIVE lock, reads and writes keep
 *     running throughout. It cannot run inside a transaction block, so each statement is
 *     issued autocommit via sql.unsafe() and never inside sql.begin().
 *   - Skips entirely when a long-lived transaction is open: CONCURRENTLY waits on old
 *     snapshots, so firing under one just parks a backend for the duration.
 *   - Skips when disk headroom is short — a concurrent rebuild needs room for a full
 *     second copy of the index.
 *   - Cleans up `*_ccnew` / `*_ccold` leftovers, which is how an INTERRUPTED concurrent
 *     reindex fails: it leaves a valid duplicate behind that is then maintained on every
 *     write forever. The audit found exactly one such orphan (harness_plans_search_idx_ccnew,
 *     17 MB) left by an earlier manual reindex, so this cleanup closes the loop on the
 *     failure mode the routine itself could otherwise create.
 *   - Bounded by maxIndexesPerRun and a wall-clock budget so a run can never monopolise
 *     I/O or overrun its window.
 *
 * Reversible + non-destructive: REINDEX rebuilds an index from the table, so the worst
 * case of a wrong candidate is wasted I/O — no data is at risk.
 *
 * Server-only.
 */
import type postgres from 'postgres';

/** A single index the sweep rebuilt (or tried to). */
export interface ReindexedIndex {
  schema: string;
  index: string;
  table: string;
  beforeBytes: number;
  afterBytes: number;
  elapsedMs: number;
  /** Present only when the rebuild failed; the run continues past it. */
  error?: string;
}

export interface IndexBloatReindexResult {
  /** Indexes successfully rebuilt, with their before/after sizes. */
  reindexed: ReindexedIndex[];
  /** Bytes returned to the OS across all successful rebuilds. */
  bytesReclaimed: number;
  /** Leftover *_ccnew / *_ccold duplicates dropped this run. */
  orphansDropped: string[];
  /** Set when the run declined to do anything, naming the guard that tripped. */
  skipped?: 'long-running-transaction' | 'low-disk' | 'no-candidates';
  /** True when the per-run cap or time budget cut the sweep short. */
  truncated: boolean;
}

export interface IndexBloatReindexOpts {
  /** Only consider indexes at least this large. Default 64 MiB. */
  minBytes?: number;
  /** Bloat trigger: rebuild above this many bytes per indexed row. Default 200.
   *  Healthy btrees in this database measure 49–131 after a rebuild. */
  maxBytesPerRow?: number;
  /** Only sweep indexes whose table has at least this many lifetime deletes. Default 100k. */
  minTableDeletes?: number;
  /** Hard cap on rebuilds per run. Default 12. */
  maxIndexesPerRun?: number;
  /** Wall-clock budget for the whole sweep. Default 10 min. */
  timeBudgetMs?: number;
  /** Refuse to run when a transaction has been open longer than this. Default 60s. */
  maxOpenTxnSeconds?: number;
  /** Refuse to run below this much free disk on the data directory. Default 20 GiB. */
  minFreeDiskBytes?: number;
  /** Report candidates without touching anything. */
  dryRun?: boolean;
  /** Schemas to sweep. Default ['harness_shared']. */
  schemas?: string[];
}

const DEFAULTS = {
  minBytes: 64 * 1024 * 1024,
  maxBytesPerRow: 200,
  minTableDeletes: 100_000,
  maxIndexesPerRun: 12,
  timeBudgetMs: 10 * 60_000,
  maxOpenTxnSeconds: 60,
  minFreeDiskBytes: 20 * 1024 * 1024 * 1024,
  schemas: ['harness_shared'],
};

interface CandidateRow {
  schema_name: string;
  index_name: string;
  table_name: string;
  index_bytes: string | number;
}

/**
 * Run one index-bloat sweep. Never throws for a per-index failure — a failed rebuild is
 * recorded on its entry and the sweep moves on, so one bad index cannot strand the rest.
 */
export async function runIndexBloatReindexOnce(
  sql: postgres.Sql,
  opts: IndexBloatReindexOpts = {},
): Promise<IndexBloatReindexResult> {
  const o = { ...DEFAULTS, ...opts };
  const result: IndexBloatReindexResult = {
    reindexed: [],
    bytesReclaimed: 0,
    orphansDropped: [],
    truncated: false,
  };

  // --- Guard 1: a long-open transaction makes CONCURRENTLY park instead of progress. ---
  const [{ max_open_seconds: maxOpen } = { max_open_seconds: 0 }] = await sql<
    Array<{ max_open_seconds: number }>
  >`
    SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start)), 0)::float8 AS max_open_seconds
      FROM pg_stat_activity
     WHERE xact_start IS NOT NULL
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()
  `;
  if (Number(maxOpen) > o.maxOpenTxnSeconds) {
    result.skipped = 'long-running-transaction';
    return result;
  }

  // --- Always clean leftovers first: an orphaned *_ccnew is a duplicate index being ---
  // --- maintained on every write, so dropping it is pure win and costs nothing.     ---
  const orphans = await sql<Array<{ schema_name: string; index_name: string }>>`
    SELECT n.nspname AS schema_name, c.relname AS index_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relkind = 'i'
       AND n.nspname = ANY(${o.schemas})
       AND (c.relname LIKE '%\_ccnew' OR c.relname LIKE '%\_ccold'
            OR c.relname ~ '_cc(new|old)[0-9]+$')
       AND NOT i.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = c.oid)
  `;
  for (const orph of orphans) {
    try {
      await sql.unsafe(
        `DROP INDEX CONCURRENTLY IF EXISTS "${orph.schema_name}"."${orph.index_name}"`,
      );
      result.orphansDropped.push(`${orph.schema_name}.${orph.index_name}`);
    } catch {
      // A leftover we cannot drop is not worth failing the sweep over.
    }
  }

  // --- Guard 2: a concurrent rebuild needs room for a full second copy of the index. ---
  // statfs the actual data directory rather than assuming a mount point. A probe failure
  // is non-fatal: we would rather sweep than skip on an unreadable stat.
  try {
    const [{ data_directory: dataDir } = { data_directory: '' }] = await sql<
      Array<{ data_directory: string }>
    >`SELECT setting AS data_directory FROM pg_settings WHERE name = 'data_directory'`;
    if (dataDir) {
      const { statfs } = await import('node:fs/promises');
      const st = await statfs(dataDir);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      if (freeBytes < o.minFreeDiskBytes) {
        result.skipped = 'low-disk';
        return result;
      }
    }
  } catch {
    // Unreadable data_directory / statfs unsupported — fall through and sweep.
  }

  // --- Select candidates: btree, big, bloated, and on a table with real delete churn. ---
  const candidates = await sql<CandidateRow[]>`
    SELECT n.nspname AS schema_name,
           c.relname  AS index_name,
           t.relname  AS table_name,
           pg_relation_size(c.oid)::text AS index_bytes
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_am am ON am.oid = c.relam
      LEFT JOIN pg_stat_user_tables st ON st.relid = t.oid
     WHERE n.nspname = ANY(${o.schemas})
       AND am.amname = 'btree'
       AND i.indisvalid
       AND pg_relation_size(c.oid) >= ${o.minBytes}
       AND t.reltuples > 0
       AND (pg_relation_size(c.oid) / t.reltuples) > ${o.maxBytesPerRow}
       AND COALESCE(st.n_tup_del, 0) >= ${o.minTableDeletes}
     ORDER BY pg_relation_size(c.oid) DESC
     LIMIT ${o.maxIndexesPerRun}
  `;

  if (candidates.length === 0) {
    if (result.orphansDropped.length === 0) result.skipped = 'no-candidates';
    return result;
  }
  if (o.dryRun) {
    result.reindexed = candidates.map((c) => ({
      schema: c.schema_name,
      index: c.index_name,
      table: c.table_name,
      beforeBytes: Number(c.index_bytes),
      afterBytes: Number(c.index_bytes),
      elapsedMs: 0,
    }));
    return result;
  }

  const deadline = Date.now() + o.timeBudgetMs;
  for (const cand of candidates) {
    if (Date.now() > deadline) {
      result.truncated = true;
      break;
    }
    const qualified = `"${cand.schema_name}"."${cand.index_name}"`;
    const before = Number(cand.index_bytes);
    const started = Date.now();
    try {
      // REINDEX CONCURRENTLY cannot run inside a transaction block — sql.unsafe() on the
      // pooled connection issues it autocommit, which is what we want.
      await sql.unsafe(`REINDEX INDEX CONCURRENTLY ${qualified}`);
      const [after] = await sql<Array<{ bytes: string }>>`
        SELECT pg_relation_size(${`${cand.schema_name}.${cand.index_name}`}::regclass)::text AS bytes
      `;
      const afterBytes = Number(after?.bytes ?? before);
      result.reindexed.push({
        schema: cand.schema_name,
        index: cand.index_name,
        table: cand.table_name,
        beforeBytes: before,
        afterBytes,
        elapsedMs: Date.now() - started,
      });
      result.bytesReclaimed += Math.max(0, before - afterBytes);
    } catch (err) {
      result.reindexed.push({
        schema: cand.schema_name,
        index: cand.index_name,
        table: cand.table_name,
        beforeBytes: before,
        afterBytes: before,
        elapsedMs: Date.now() - started,
        error: (err as Error).message,
      });
    }
  }

  return result;
}
