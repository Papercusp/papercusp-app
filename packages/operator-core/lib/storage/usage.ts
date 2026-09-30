/**
 * Live storage usage introspection (storage-settings-page-2026-06-15 P-003,
 * D-003). Reuses the audit's introspection: PG table sizes from the catalog
 * (instant) + a bounded age-distribution count, and `du` of the on-disk stores.
 *
 * Shape per category: total size + a cumulative "older than N days" distribution
 * the page turns into per-option projected reclaim. The bucket counts run under a
 * short statement_timeout so a huge table (route_invocations is ~26M rows) can
 * never wedge a settings read — on timeout the row still returns its size with an
 * empty distribution + a note, and the UI falls back to "trim all" / a server
 * dry-run. Server-only.
 */
import {
  STORAGE_CATEGORIES,
  isTrimmable,
  type AgeColumnType,
  type StorageCategory,
  type StorageFederation,
} from './categories';
import { listDiskEntriesAsync, type DiskWalkBudget } from './disk';

/** The fixed "trim older than" thresholds (days) the page offers + projects. */
export const TRIM_THRESHOLD_DAYS = [30, 90, 365] as const;

/** Statement-timeout cap for each bounded storage query (ms). */
const QUERY_TIMEOUT_CAP_MS = 4000;

/**
 * Aggregate wall-clock budget for the direct `storage:usage` read path. The
 * composed `code:run` foreground budget is 50s; leave room for dispatch and
 * shaping while still allowing several slow-but-useful catalog reads.
 */
const STORAGE_READ_BUDGET_MS = 30_000;

/**
 * The budget used when this runs OFF the read path — from the
 * `system:precompute-derived-reads` routine, where nobody is waiting on the
 * result (precompute-derived-sync-reads-2026-07-19 P-003).
 *
 * Deliberately NOT unbounded. The plan item said to delete the budget outright
 * now that the walk is off the read path, but EI-6045's budget guards the EVENT
 * LOOP, not just read latency — a recursive walk that blocks for minutes is just
 * as harmful inside a routine as inside a resolver, it merely stalls the operator
 * instead of one panel. Raising it (rather than removing it) buys complete,
 * accurate sizes on a large store while keeping the stall bounded.
 */
const STORAGE_PRECOMPUTE_BUDGET_MS = 120_000;

class StorageReadDeadlineExceeded extends Error {
  constructor(phase: string) {
    super(`storage usage read deadline exhausted before ${phase}`);
    this.name = 'StorageReadDeadlineExceeded';
  }
}

function queryTimeoutMs(budget: DiskWalkBudget, phase: string): number {
  const remaining = budget.deadlineMs - Date.now();
  if (remaining <= 0) {
    budget.truncated = true;
    throw new StorageReadDeadlineExceeded(phase);
  }
  return Math.max(1, Math.min(QUERY_TIMEOUT_CAP_MS, remaining));
}

/** Run one storage query under the remaining aggregate read deadline. */
async function runBoundedStorageQuery<T>(
  sql: Sql,
  budget: DiskWalkBudget,
  phase: string,
  run: (tx: Sql) => Promise<T>,
): Promise<T> {
  const timeoutMs = queryTimeoutMs(budget, phase);
  return sql.begin(async (tx) => {
    // statement_timeout bounds server execution. The deadline check above
    // bounds how much of the aggregate budget this phase may consume.
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return run(tx);
  });
}

function storageReadNote(err: unknown, fallback: string): string {
  return err instanceof StorageReadDeadlineExceeded ? err.message : fallback;
}

/** A cumulative slice: rows/entries strictly older than `olderThanDays`. A null
 *  threshold is the TOTAL (everything — the "trim all" target). */
export interface StorageAgeBucket {
  olderThanDays: number | null;
  rows: number;
  bytes: number;
}

export interface StorageUsageRow {
  id: string;
  label: string;
  kind: 'pg' | 'disk';
  federation: StorageFederation;
  /** false → read-only (federated); the page disables trim + warns. */
  trimmable: boolean;
  /** logical delete needs a VACUUM FULL to return disk (substrate_outbox). */
  bloats: boolean;
  totalBytes: number;
  /** pg row estimate / disk top-level entry count. null when unknown. */
  totalRows: number | null;
  /** cumulative older-than distribution (incl. a null=total bucket). Empty for
   *  federated categories or when the count timed out. */
  ageBuckets: StorageAgeBucket[];
  ageColumnType?: AgeColumnType;
  minOlderThanDays?: number;
  description: string;
  note?: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Catalog size — instant (no row scan). Returns 0 bytes for a missing table. */
async function catalogSize(
  sql: Sql,
  schema: string,
  table: string,
  budget: DiskWalkBudget,
): Promise<{ totalBytes: number; rowsEstimate: number }> {
  const rows = await runBoundedStorageQuery(
    sql,
    budget,
    `catalog sizing for ${table}`,
    (tx) => tx`
      SELECT pg_total_relation_size(c.oid)::bigint AS total_bytes,
             GREATEST(c.reltuples, 0)::bigint       AS rows_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind = 'r'
       LIMIT 1`,
  );
  const r = rows[0];
  return { totalBytes: num(r?.total_bytes), rowsEstimate: num(r?.rows_estimate) };
}

/** The age-distribution SQL for one table (trusted identifiers from the taxonomy). */
function bucketSql(
  schema: string,
  table: string,
  ageColumn: string,
  ageColumnType: AgeColumnType,
  drainedGuard: boolean,
): string {
  const t = `${ident(schema)}.${ident(table)}`;
  const col = ident(ageColumn);
  const cond = (days: number): string =>
    ageColumnType === 'timestamptz'
      ? `${col} < now() - make_interval(days => ${days})`
      : `${col} < (extract(epoch from now()) * 1000)::bigint - ${days}::bigint * 86400000`;
  const where = drainedGuard ? 'WHERE drained_at IS NOT NULL' : '';
  const filters = TRIM_THRESHOLD_DAYS.map((d) => `count(*) FILTER (WHERE ${cond(d)})::bigint AS d${d}`).join(
    ',\n         ',
  );
  return `
    SELECT count(*)::bigint AS total,
           ${filters}
      FROM ${t}
      ${where}`;
}

async function computePgUsage(
  sql: Sql,
  cat: StorageCategory & { kind: 'pg' },
  opts: { sizesOnly?: boolean; budget: DiskWalkBudget },
): Promise<StorageUsageRow> {
  const base: StorageUsageRow = {
    id: cat.id,
    label: cat.label,
    kind: 'pg',
    federation: cat.federation,
    trimmable: isTrimmable(cat),
    bloats: Boolean(cat.bloats),
    totalBytes: 0,
    totalRows: null,
    ageBuckets: [],
    ageColumnType: cat.ageColumnType,
    description: cat.description,
  };
  try {
    const { totalBytes, rowsEstimate } = await catalogSize(sql, cat.schema, cat.table, opts.budget);
    base.totalBytes = totalBytes;
    base.totalRows = rowsEstimate;
  } catch (err) {
    base.note = storageReadNote(err, `size unavailable: ${(err as Error)?.message ?? 'error'}`);
    return base;
  }

  // sizesOnly (storage-growth-alarm P-017): the catalog size is all the caller
  // needs — skip the bounded age-distribution scan entirely (no per-table SQL).
  if (opts.sizesOnly) return base;

  // Federated / no age column → read-only, no distribution.
  if (!base.trimmable || !cat.ageColumn || !cat.ageColumnType) return base;

  try {
    const q = bucketSql(cat.schema, cat.table, cat.ageColumn, cat.ageColumnType, Boolean(cat.drainedGuard));
    const rows = await runBoundedStorageQuery(sql, opts.budget, `age distribution for ${cat.table}`, (tx) =>
      tx.unsafe(q),
    );
    const r = rows[0] ?? {};
    const total = num(r.total);
    const perRow = total > 0 ? base.totalBytes / total : 0;
    const buckets: StorageAgeBucket[] = TRIM_THRESHOLD_DAYS.map((d) => {
      const olderRows = num(r[`d${d}`]);
      return { olderThanDays: d, rows: olderRows, bytes: Math.round(perRow * olderRows) };
    });
    // The total bucket: for a drained-guarded queue the "all" target is the drained
    // subset (`total`), not the whole table — so its bytes are the proportional
    // estimate, not the full relation size.
    const totalBytes = cat.drainedGuard ? Math.round(perRow * total) : base.totalBytes;
    buckets.push({ olderThanDays: null, rows: total, bytes: totalBytes });
    base.ageBuckets = buckets;
  } catch (err) {
    base.note = storageReadNote(
      err,
      `age distribution unavailable (table too large to scan in ${QUERY_TIMEOUT_CAP_MS}ms)`,
    );
    void err;
  }
  return base;
}

async function computeDiskUsage(
  cat: StorageCategory & { kind: 'disk' },
  budget?: DiskWalkBudget,
): Promise<StorageUsageRow> {
  const entries = await listDiskEntriesAsync(cat, budget);
  const now = Date.now();
  const totalBytes = entries.reduce((a, e) => a + e.sizeBytes, 0);
  const buckets: StorageAgeBucket[] = TRIM_THRESHOLD_DAYS.map((d) => {
    const cutoff = now - d * 86400000;
    const older = entries.filter((e) => e.mtimeMs < cutoff);
    return {
      olderThanDays: d,
      rows: older.length,
      bytes: older.reduce((a, e) => a + e.sizeBytes, 0),
    };
  });
  buckets.push({ olderThanDays: null, rows: entries.length, bytes: totalBytes });
  return {
    id: cat.id,
    label: cat.label,
    kind: 'disk',
    federation: cat.federation,
    trimmable: true,
    bloats: false,
    totalBytes,
    totalRows: entries.length,
    ageBuckets: buckets,
    minOlderThanDays: cat.minOlderThanDays,
    description: cat.description,
    // Sizes are partial when the shared disk-walk budget was exhausted (EI-6045).
    note: budget?.truncated ? `disk sizes are partial (sizing budget exceeded on a large store)` : undefined,
  };
}

/** Compute usage for every category. Sequential (gentle on the DB); a failing
 *  category degrades to size-only with a note rather than failing the page. */
export async function computeStorageUsage(
  opts: { sizesOnly?: boolean; offReadPath?: boolean; deadlineMs?: number } = {},
): Promise<StorageUsageRow[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as Sql;
  const out: StorageUsageRow[] = [];
  // One shared wall-clock budget spans catalog sizing, age distributions, and
  // disk sizing. Previously the per-query PG caps and disk cap were independent,
  // so seven sequential age scans could consume the entire code:run foreground
  // budget before the caller received even a partial result. Over-budget rows
  // remain in the response with an explicit note.
  const budgetMs = opts.offReadPath ? STORAGE_PRECOMPUTE_BUDGET_MS : STORAGE_READ_BUDGET_MS;
  const diskBudget: DiskWalkBudget = { deadlineMs: opts.deadlineMs ?? Date.now() + budgetMs };
  for (const cat of STORAGE_CATEGORIES) {
    if (cat.kind === 'pg') {
      out.push(await computePgUsage(sql, cat, { sizesOnly: opts.sizesOnly, budget: diskBudget }));
    } else {
      if (diskBudget.deadlineMs <= Date.now()) {
        diskBudget.truncated = true;
        out.push({
          id: cat.id,
          label: cat.label,
          kind: 'disk',
          federation: cat.federation,
          trimmable: true,
          bloats: false,
          totalBytes: 0,
          totalRows: null,
          ageBuckets: [],
          minOlderThanDays: cat.minOlderThanDays,
          description: cat.description,
          note: `storage usage read deadline exhausted before disk sizing for ${cat.id}`,
        });
        continue;
      }
      try {
        out.push(await computeDiskUsage(cat, diskBudget));
      } catch (err) {
        out.push({
          id: cat.id,
          label: cat.label,
          kind: 'disk',
          federation: cat.federation,
          trimmable: true,
          bloats: false,
          totalBytes: 0,
          totalRows: null,
          ageBuckets: [],
          minOlderThanDays: cat.minOlderThanDays,
          description: cat.description,
          note: `disk scan unavailable: ${(err as Error)?.message ?? 'error'}`,
        });
      }
    }
  }
  return out;
}
