/**
 * db-pgss-orphan-stats-reclaim.ts — the single-run body of the pg_stat_statements
 * orphan-entry reclaim routine (db-performance-remediation-2026-07-26 D-033, WI-9313).
 * Kept separate from the DBOS scheduled wrapper in lib/dbos/periodic-workflows.ts so it
 * integration-tests without the scheduler (mirrors runIndexBloatReindexOnce).
 *
 * WHY THIS EXISTS
 * ---------------
 * pg_stat_statements has no DROP DATABASE hook. Entries are keyed on
 * (userid, dbid, queryid, toplevel), and when a database is dropped its entries are
 * simply retained — forever. Backups/dumps run against TRANSIENT databases, so every
 * such dump permanently consumes entry slots nothing will ever reclaim.
 *
 * Measured 2026-08-03: 3,303 of 9,791 entries (33.7%) carried a dbid absent from
 * pg_database, across 23 dropped databases. Their content is unmistakably pg_dump
 * (`PREPARE dumpFunc`, `pg_get_viewdef`, `format_type`, `COPY … TO stdout`).
 *
 * This is a MEASUREMENT-INTEGRITY defect, not a housekeeping one. `pg_stat_statements.max`
 * is 10000 and POSTMASTER-context (restart to change). At 97.9% full Postgres evicts, and
 * it evicts by LOW USAGE — so it discards REAL application statistics. Measured dealloc:
 * 332 over 24.6 days = 13.5/day. An evicted-then-recreated entry's next delta reads as a
 * PHANTOM SPIKE, the exact defect this plan already fought once. The leak attacks the
 * plan's own instrument.
 *
 * A one-shot reclaim is therefore only a MITIGATION — the residue regrows with every dump
 * against a transient database. This routine is the durable fix.
 *
 * ⚠ THE FOOTGUN THIS ROUTINE EXISTS TO NOT TRIP
 * ---------------------------------------------
 * `pg_stat_statements_reset(userid, dbid, queryid, minmax_only)` treats ZERO in any
 * position as "match ALL". So `pg_stat_statements_reset(0, 0, 0, false)` DISCARDS THE
 * ENTIRE STATISTICS TABLE. A naive "loop over the dbids I found and reset each" would
 * therefore wipe everything the moment one orphan row carried dbid = 0 — silently
 * destroying the very measurements this plan depends on, and looking like a successful
 * sweep in the log. Two independent guards below prevent that:
 *   1. the candidate query itself excludes `dbid = 0`;
 *   2. `reclaimOrphanPgssStatsOnce` re-asserts `dbid !== 0` immediately before every
 *      reset call, so a future refactor of the query cannot reintroduce the hazard.
 * Measured 2026-08-03: 0 entries carried dbid = 0, so this is prophylactic — which is
 * precisely when it is cheapest to install.
 *
 * SAFETY
 * ------
 *   - Only ever targets a dbid that returns NO row from pg_database. Absence is
 *     re-verified immediately before each reset (a database created between the scan and
 *     the reset would otherwise have its live stats discarded).
 *   - Never passes dbid = 0 — see above.
 *   - Checks has_function_privilege() first and skips with a NAMED reason rather than
 *     throwing: harness_admin is not a superuser, and holds only pg_read_all_stats
 *     (migration 733) until migration 756 grants EXECUTE. An inert sweep must say WHY.
 *   - Skips when the extension is absent (it is superuser-opt-in and not guaranteed).
 *   - Never throws for a per-dbid failure — it is recorded on the entry and the sweep
 *     moves on, so one bad dbid cannot strand the rest.
 *
 * Non-destructive with respect to application data: the only thing discarded is
 * monitoring counters for databases that no longer exist.
 *
 * Server-only.
 */
import type postgres from 'postgres';

/** One dropped database whose statistics the sweep reclaimed (or tried to). */
export interface ReclaimedDbid {
  dbid: number;
  /** Entries this dbid held immediately before the reset. */
  entries: number;
  /** Present only when the reset failed; the run continues past it. */
  error?: string;
}

export interface PgssOrphanReclaimResult {
  /** Dropped-database dbids swept this run, with the entry counts they freed. */
  reclaimed: ReclaimedDbid[];
  /** Total entries returned to the cap across all successful resets. */
  entriesReclaimed: number;
  /** Entry-table occupancy before and after the sweep. */
  entriesBefore: number;
  entriesAfter: number;
  /** pg_stat_statements.max, for context on the two numbers above. */
  capMax: number;
  /**
   * True when occupancy is STILL above `pressurePct` after a successful sweep — i.e. the
   * cap is genuinely undersized rather than merely leaking, and raising
   * pg_stat_statements.max (a postmaster restart) is the remaining lever. Surfacing this
   * keeps the sweep from masking a real capacity problem by partially relieving it.
   */
  capStillPressured: boolean;
  /** Set when the run declined to do anything, naming the guard that tripped. */
  skipped?: 'extension-absent' | 'no-privilege' | 'no-orphans';
  /** True when the per-run cap cut the sweep short. */
  truncated: boolean;
}

export interface PgssOrphanReclaimOpts {
  /** Hard cap on dbids reset per run. Default 50. */
  maxDbidsPerRun?: number;
  /** Occupancy above which `capStillPressured` is reported. Default 80(%). */
  pressurePct?: number;
  /** Report candidates without resetting anything. */
  dryRun?: boolean;
}

const DEFAULTS = {
  maxDbidsPerRun: 50,
  pressurePct: 80,
};

interface OrphanRow {
  dbid: string | number;
  entries: string | number;
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);

/**
 * Run one pg_stat_statements orphan-entry reclaim. Never throws for a per-dbid failure.
 */
export async function reclaimOrphanPgssStatsOnce(
  sql: postgres.Sql,
  opts: PgssOrphanReclaimOpts = {},
): Promise<PgssOrphanReclaimResult> {
  const cfg = { ...DEFAULTS, ...opts };
  const empty = (skipped: PgssOrphanReclaimResult['skipped']): PgssOrphanReclaimResult => ({
    reclaimed: [],
    entriesReclaimed: 0,
    entriesBefore: 0,
    entriesAfter: 0,
    capMax: 0,
    capStillPressured: false,
    skipped,
    truncated: false,
  });

  // Guard 1: the extension is superuser-opt-in and not guaranteed to be installed.
  const [ext] = await sql<{ installed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
      AS installed`;
  if (!ext?.installed) return empty('extension-absent');

  // Guard 2: reset is superuser-only until migration 756 grants EXECUTE. Report the
  // reason rather than throwing — an inert sweep that says nothing is indistinguishable
  // from a working one that found nothing.
  const [priv] = await sql<{ can_reset: boolean | null }[]>`
    SELECT has_function_privilege(
             current_user,
             'pg_stat_statements_reset(oid,oid,bigint,boolean)',
             'EXECUTE') AS can_reset`;
  if (!priv?.can_reset) return empty('no-privilege');

  const [before] = await sql<{ entries: string; cap_max: string }[]>`
    SELECT (SELECT count(*) FROM pg_stat_statements)::text AS entries,
           (SELECT setting FROM pg_settings WHERE name = 'pg_stat_statements.max') AS cap_max`;
  const entriesBefore = num(before?.entries);
  const capMax = num(before?.cap_max);

  // Candidates: entries whose database no longer exists. `dbid <> 0` is the first of two
  // guards against the reset-everything footgun documented at the top of this file.
  const orphans = await sql<OrphanRow[]>`
    SELECT s.dbid::text AS dbid, count(*)::text AS entries
      FROM pg_stat_statements s
     WHERE s.dbid <> 0
       AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.oid = s.dbid)
     GROUP BY s.dbid
     ORDER BY count(*) DESC`;

  if (orphans.length === 0) {
    return {
      ...empty('no-orphans'),
      entriesBefore,
      entriesAfter: entriesBefore,
      capMax,
      capStillPressured: capMax > 0 && (entriesBefore / capMax) * 100 > cfg.pressurePct,
    };
  }

  const slice = orphans.slice(0, cfg.maxDbidsPerRun);
  const truncated = orphans.length > slice.length;
  const reclaimed: ReclaimedDbid[] = [];

  for (const row of slice) {
    const dbid = num(row.dbid);
    const entries = num(row.entries);

    // Guard: NEVER pass 0 — it means "all databases" and would discard the whole table.
    // Deliberately redundant with the query's `dbid <> 0`, so a future edit of that query
    // cannot reintroduce the hazard.
    if (!Number.isFinite(dbid) || dbid === 0) continue;

    if (cfg.dryRun) {
      reclaimed.push({ dbid, entries });
      continue;
    }

    try {
      // Re-verify the database is STILL absent immediately before resetting. A database
      // created between the scan above and this call would otherwise have its live
      // statistics discarded. Checked in the same statement that performs the reset so
      // nothing can interleave between the two.
      const [done] = await sql<{ reset: boolean }[]>`
        SELECT (pg_stat_statements_reset(0, ${dbid}::oid, 0, false) IS NOT NULL) AS reset
         WHERE NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.oid = ${dbid}::oid)`;
      if (done?.reset) reclaimed.push({ dbid, entries });
    } catch (err) {
      reclaimed.push({ dbid, entries, error: (err as Error).message });
    }
  }

  const [after] = await sql<{ entries: string }[]>`
    SELECT count(*)::text AS entries FROM pg_stat_statements`;
  const entriesAfter = cfg.dryRun ? entriesBefore : num(after?.entries);

  return {
    reclaimed,
    entriesReclaimed: reclaimed.filter((r) => !r.error).reduce((n, r) => n + r.entries, 0),
    entriesBefore,
    entriesAfter,
    capMax,
    capStillPressured: capMax > 0 && (entriesAfter / capMax) * 100 > cfg.pressurePct,
    truncated,
  };
}
