/**
 * hot-seq-scan-detector.ts — the single-run body of the hot-statement seq-scan detector
 * (EI-19312743681026041). Kept separate from its DBOS scheduled wrapper in
 * lib/dbos/periodic-workflows.ts so it unit-tests without the scheduler, mirroring
 * `reclaimOrphanPgssStatsOnce` and `runIndexBloatReindexOnce`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two migrations in two days fixed the SAME defect class, and both were found only
 * because an agent went looking through pg_stat_statements BY HAND:
 *
 *   717 (WI-6839) — Scout's harness_plans sweeps: seq scan + detoast 999 rows to
 *                   return ~1.  4,459 -> 615 buffers.
 *   718 (WI-6850) — pot frontier survey: seq-scanned work_items (284 MB) TWICE per
 *                   call to return 0-700 rows.  14,379 -> 1,112 buffers;
 *                   26.98% -> 0.90% of live DB time.
 *
 * Nothing in the system noticed either one. The 718 case had been burning ~27% of ALL
 * live database time at ~171 calls/min. No alarm, no scorecard, no health panel covered
 * it. This module is that missing detector.
 *
 * The shape always repeats: a filter cheap to WRITE with no index behind it, over a
 * table with a fat TOASTed column, called on a tick. Invisible in code review because
 * the SQL is *correct* — just unindexed. Invisible in tests because fixtures are small
 * and a seq scan over 40 rows is free. It exists only at production row counts, so the
 * only place it can be caught is against the live database.
 *
 * THE SIGNATURE IT MATCHES
 * ------------------------
 * "Read many, return few", measured directly from pg_stat_statements deltas:
 *   - blocksPerCall  HIGH  (the work actually done), and
 *   - rowsPerCall    LOW   (the work the caller asked for), and
 *   - amplification = blocksPerCall / rowsPerCall above a floor,
 * then CONFIRMED by an EXPLAIN showing a Seq Scan on a relation above a size floor.
 * Both halves are required: the ratio alone flags legitimate aggregates, and a Seq Scan
 * alone is correct and optimal on a small table.
 *
 * ⚠ WHAT A FINDING DOES AND DOES NOT PROVE — read before acting on one.
 * The two halves of a finding carry very different weight, and conflating them is the
 * easiest way to waste a day on this detector's output:
 *   - The COUNTERS are measured from real executions. `blocksPerCall`, `rowsPerCall` and
 *     the amplification between them are facts about work the database actually did.
 *   - The PLAN is inferred. `GENERIC_PLAN` deliberately plans WITHOUT parameter values,
 *     so it cannot use a partial or expression index whose applicability depends on the
 *     value bound at runtime. A statement can therefore show a Seq Scan here while its
 *     runtime custom plan uses an index. Measured on this box 2026-08-31: the memory
 *     recall query generic-plans as a Seq Scan on memory_canonical even though
 *     `memory_canonical_user_id_idx` indexes the very expression it filters on.
 * So a finding says "this statement really is reading many blocks to return few rows,
 * AND here is a plausible reason" — not "this is its executed plan". Confirm with
 * `EXPLAIN (ANALYZE, BUFFERS)` against representative parameter VALUES before writing a
 * migration. The amplification is the finding; the plan is the lead.
 *
 * Deliberately NOT keyed on reltuples: `pg_class.reltuples = -1` on a never-analyzed
 * relation, and a VIEW reports its own trivial row count rather than the base table's
 * (harness_features_consolidated reads as 2,090 rows over a 30,088-row / 284 MB table —
 * that IS the 718 case). A threshold applied to those numbers skips the real defect, so
 * size is measured in BYTES via pg_total_relation_size, which is always truthful.
 *
 * ⚠ THREE TRAPS THIS MODULE EXISTS TO NOT TRIP
 * --------------------------------------------
 * 1. LIFETIME TOTALS INVERT THE ANSWER. Ranking must use a live DELTA between two
 *    samples, never the cumulative counters. db-performance-remediation-2026-07-26
 *    D-007 makes that binding, and the 718 statements are why: 26.98% of LIVE database
 *    time but only 0.2% of lifetime. A lifetime ranking hides the very thing being
 *    hunted behind whatever ran most since the last postmaster restart.
 *
 * 2. AN EVICTED + RECREATED ENTRY READS AS A PHANTOM SPIKE. pg_stat_statements evicts
 *    by LOW USAGE at the cap, and a recreated entry's counters restart at zero, so a
 *    naive `now - then` subtraction reports the entry's whole new lifetime as one
 *    window's work. Guarded on `stats_since` (pgss 1.11+), which moves when an entry's
 *    statistics are reset — a strictly better tell than a negative delta, because it
 *    also catches an entry that was reset and then climbed back ABOVE its old value
 *    between two samples. See db-pgss-orphan-stats-reclaim.ts (D-033) for the leak that
 *    makes this eviction routine rather than exotic.
 *
 * 3. pg_stat_activity IS THE WRONG INSTRUMENT AND MUST NOT BE SUBSTITUTED. It masks
 *    query text to non-superusers (EI-19311529270893371), and sampling it measures
 *    time-in-state rather than executions, which over-weights the youngest and coldest
 *    process. pg_stat_statements counts every execution, which is the question here.
 *
 * SAFETY
 * ------
 *   - EXPLAIN is run WITHOUT ANALYZE, so the inspected statement is planned and never
 *     executed. Verified against an UPDATE: `EXPLAIN (GENERIC_PLAN, FORMAT JSON)` of a
 *     DML statement succeeds inside a READ ONLY transaction, which is exactly the
 *     property that makes inspecting hot writes safe.
 *   - Every EXPLAIN additionally runs inside an explicit READ ONLY transaction with a
 *     statement_timeout, so even a future edit that reached for ANALYZE cannot write.
 *   - `GENERIC_PLAN` (PostgreSQL 16+; this box is 18.4) is what makes any of it possible:
 *     pg_stat_statements stores NORMALIZED text with `$1` placeholders, which plain
 *     EXPLAIN refuses for want of parameter types.
 *   - Statement text is screened before it is interpolated: only single SELECT / WITH /
 *     INSERT / UPDATE / DELETE / MERGE statements are inspected, and any text carrying a
 *     non-trailing `;` is skipped rather than concatenated into the EXPLAIN.
 *   - Never throws for a per-statement failure. pgss truncates text at
 *     `track_activity_query_size`, so unparseable entries are EXPECTED; they are counted
 *     and stepped over, never raised.
 *
 * Server-only. Read-only with respect to application data — it plans statements and
 * reads catalog sizes, and writes nothing.
 */
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Thresholds. Every default is derived from the two measured cases above rather
// than picked round, and each states what it would have done to 717 and 718.
// ---------------------------------------------------------------------------

/**
 * Blocks read per call, above which a statement is doing real I/O work.
 * 1,000 blocks ~= 8 MB touched per call. Measured: 717 read 4,459 buffers/call and 718
 * read 14,379 — both clear this by 4.5x and 14x. Set here rather than higher precisely
 * so the SMALLER of the two known cases is not the one that slips through.
 */
export const HOT_SEQ_SCAN_MIN_BLOCKS_PER_CALL = 1_000;

/**
 * Rows returned per call, below which the caller is asking for little. 717 returned ~1
 * row; 718 returned 0-700. 1,000 admits both with margin while excluding bulk exports,
 * which legitimately read many blocks AND return many rows.
 */
export const HOT_SEQ_SCAN_MAX_ROWS_PER_CALL = 1_000;

/**
 * Blocks read per row returned — the read-many-return-few ratio itself, and the one
 * threshold that encodes the defect rather than its symptoms. 717: 4,459/1 = 4,459x.
 * 718 at its most forgiving: 14,379/700 = 20.5x. A floor of 10 keeps 718's best case at
 * 2x margin.
 */
export const HOT_SEQ_SCAN_MIN_AMPLIFICATION = 10;

/**
 * Relation size floor, in bytes, for a Seq Scan to be worth reporting. A seq scan on a
 * small table is the correct plan and must not be flagged. 16 MB sits below 717's ~35 MB
 * working set (4,459 buffers) and far below 718's 284 MB.
 */
export const HOT_SEQ_SCAN_MIN_RELATION_BYTES = 16 * 1024 * 1024;

/** Statements EXPLAINed per run, taken from the top of the delta ranking. */
export const HOT_SEQ_SCAN_TOP_N = 25;

/** Calls in the window below which a delta is too small to rank on. */
export const HOT_SEQ_SCAN_MIN_CALLS_DELTA = 10;

/**
 * Shortest window worth differencing. Under a minute the deltas are dominated by
 * whatever happened to run, and the ranking is noise.
 */
export const HOT_SEQ_SCAN_MIN_WINDOW_MS = 60_000;

/** Per-EXPLAIN statement timeout. Planning is cheap; this bounds the pathological case. */
export const HOT_SEQ_SCAN_EXPLAIN_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One pg_stat_statements entry as sampled, reduced to the counters we difference. */
export interface PgssSampleEntry {
  calls: number;
  totalExecTimeMs: number;
  rows: number;
  /** shared_blks_hit + shared_blks_read — total buffers touched, cached or not. */
  sharedBlks: number;
  /** `stats_since` as epoch ms; moves when this entry's statistics are reset. */
  statsSinceMs: number;
}

/** A full sample of the statement table, plus when it was taken. */
export interface PgssBaseline {
  sampledAt: number;
  entries: Map<string, PgssSampleEntry>;
}

/** A Seq Scan node found in a generic plan, resolved against the catalog. */
export interface SeqScanHit {
  /** Relation name exactly as the plan named it. */
  relation: string;
  /** Schema of the relation the name resolved to, when it could be resolved. */
  schema?: string;
  /** pg_total_relation_size — heap + indexes + TOAST. Truthful where reltuples is not. */
  sizeBytes: number;
  /**
   * True when the plan's unqualified relation name matched relations in more than one
   * schema and the LARGEST was assumed. Reported rather than hidden: guessing large is
   * the fail-loud direction for a size threshold, but it is still a guess.
   */
  ambiguousName?: boolean;
}

/** One statement judged to be reading many blocks to return few rows via a seq scan. */
export interface HotSeqScanFinding {
  queryid: string;
  /** Stable identity across samples: userid:dbid:queryid:toplevel. */
  key: string;
  callsDelta: number;
  totalExecTimeMsDelta: number;
  rowsDelta: number;
  sharedBlksDelta: number;
  /** Buffers touched per call in the window. */
  blocksPerCall: number;
  /** Rows returned per call in the window. */
  rowsPerCall: number;
  /** blocksPerCall / max(rowsPerCall, 1) — the read-many-return-few ratio. */
  amplification: number;
  /** Share of the window's total measured exec-time delta, 0..1. */
  shareOfWindowTime: number;
  /** Seq Scans on relations at or above the size floor. Never empty on a finding. */
  seqScans: SeqScanHit[];
  /**
   * Best-effort owning module, recovered from a SQL comment retained in the statement
   * text. `undefined` when the text carries no comment — this codebase tags only some
   * statements, and an unresolved caller is reported as unresolved rather than guessed.
   */
  caller?: string;
  /** Normalized statement text, truncated for reporting. */
  queryText: string;
}

export interface HotSeqScanResult {
  findings: HotSeqScanFinding[];
  /** Sample to carry into the next run. Always present, even when the run skipped. */
  nextBaseline: PgssBaseline;
  /** Length of the differenced window. 0 when no comparison was made. */
  windowMs: number;
  /** Statements with a usable positive delta this window. */
  candidates: number;
  /** Statements actually EXPLAINed (the top-N slice of `candidates`). */
  examined: number;
  /** Entries skipped because `stats_since` moved — the phantom-spike guard (trap 2). */
  resetEntriesSkipped: number;
  /** Statements whose text could not be planned; expected, since pgss truncates text. */
  explainFailures: number;
  /** Statements not eligible for EXPLAIN (utility statements, multi-statement text). */
  notExplainable: number;
  /** Set when the run declined to judge anything, naming the guard that tripped. */
  skipped?: 'extension-absent' | 'no-baseline' | 'window-too-short';
}

export interface HotSeqScanOpts {
  /** Previous sample. Absent on the first run of a process — the run then only samples. */
  baseline?: PgssBaseline | null;
  topN?: number;
  minBlocksPerCall?: number;
  maxRowsPerCall?: number;
  minAmplification?: number;
  minRelationBytes?: number;
  minCallsDelta?: number;
  minWindowMs?: number;
  explainTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULTS = {
  topN: HOT_SEQ_SCAN_TOP_N,
  minBlocksPerCall: HOT_SEQ_SCAN_MIN_BLOCKS_PER_CALL,
  maxRowsPerCall: HOT_SEQ_SCAN_MAX_ROWS_PER_CALL,
  minAmplification: HOT_SEQ_SCAN_MIN_AMPLIFICATION,
  minRelationBytes: HOT_SEQ_SCAN_MIN_RELATION_BYTES,
  minCallsDelta: HOT_SEQ_SCAN_MIN_CALLS_DELTA,
  minWindowMs: HOT_SEQ_SCAN_MIN_WINDOW_MS,
  explainTimeoutMs: HOT_SEQ_SCAN_EXPLAIN_TIMEOUT_MS,
};

const num = (v: string | number | null | undefined): number => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Pure helpers — exported so each is tested directly, without a database.
// ---------------------------------------------------------------------------

/** Stable per-entry identity. pg_stat_statements keys on exactly this tuple. */
export function sampleKey(r: {
  userid: string | number;
  dbid: string | number;
  queryid: string | number;
  toplevel: boolean;
}): string {
  return `${r.userid}:${r.dbid}:${r.queryid}:${r.toplevel}`;
}

/** A candidate statement with its window deltas, before any plan inspection. */
export interface DeltaCandidate {
  key: string;
  queryid: string;
  callsDelta: number;
  totalExecTimeMsDelta: number;
  rowsDelta: number;
  sharedBlksDelta: number;
  blocksPerCall: number;
  rowsPerCall: number;
  amplification: number;
  queryText: string;
}

/**
 * Difference two samples and rank by exec-time delta descending.
 *
 * Trap 2 lives here: an entry whose `stats_since` is at or after the baseline sample
 * was reset inside the window, so its counters are a fresh lifetime rather than a
 * continuation. Those are counted and dropped, never differenced — subtracting them
 * reports the entry's entire new lifetime as one window's work, which is exactly the
 * phantom spike that would send someone chasing a statement that did nothing unusual.
 */
export function rankDeltas(
  baseline: PgssBaseline,
  current: Map<string, PgssSampleEntry>,
  texts: Map<string, string>,
  opts: { minCallsDelta: number },
): { candidates: DeltaCandidate[]; resetEntriesSkipped: number } {
  const candidates: DeltaCandidate[] = [];
  let resetEntriesSkipped = 0;

  for (const [key, now] of current) {
    const then = baseline.entries.get(key);
    if (!then) continue; // new entry: no baseline to difference against, so no rate yet.

    // Reset/eviction guard. `stats_since` moving means the counters restarted.
    //
    // Compared against the BASELINE'S OWN recorded stats_since, never against
    // `baseline.sampledAt`: both sides are then database-sourced, so the test is immune
    // to skew between the operator host's clock and the database's. Comparing a pgss
    // timestamp to the sampler's wall clock looks equivalent and is not — a database
    // running seconds ahead makes healthy entries read as freshly reset, and every one
    // is then dropped. That is a silent false NEGATIVE, the one direction a detector
    // cannot afford, since the result is an empty report that looks like good news.
    if (now.statsSinceMs > then.statsSinceMs) {
      resetEntriesSkipped += 1;
      continue;
    }

    const callsDelta = now.calls - then.calls;
    // Defence in depth: a counter that went backwards was reset even if `stats_since`
    // did not say so (an older pgss, or a replaced entry that kept its timestamp).
    if (callsDelta < 0 || now.sharedBlks < then.sharedBlks || now.rows < then.rows) {
      resetEntriesSkipped += 1;
      continue;
    }
    if (callsDelta < opts.minCallsDelta) continue;

    const sharedBlksDelta = now.sharedBlks - then.sharedBlks;
    const rowsDelta = now.rows - then.rows;
    const blocksPerCall = sharedBlksDelta / callsDelta;
    const rowsPerCall = rowsDelta / callsDelta;

    candidates.push({
      key,
      queryid: key.split(':')[2] ?? '',
      callsDelta,
      totalExecTimeMsDelta: now.totalExecTimeMs - then.totalExecTimeMs,
      rowsDelta,
      sharedBlksDelta,
      blocksPerCall,
      rowsPerCall,
      amplification: blocksPerCall / Math.max(rowsPerCall, 1),
      queryText: texts.get(key) ?? '',
    });
  }

  candidates.sort((a, b) => b.totalExecTimeMsDelta - a.totalExecTimeMsDelta);
  return { candidates, resetEntriesSkipped };
}

/**
 * Does this candidate match the read-many-return-few signature?
 *
 * All three conditions are required. Blocks-per-call alone flags any large scan;
 * rows-per-call alone flags every point lookup; the ratio alone flags a legitimate
 * COUNT(*) aggregate, which reads everything and returns one row on purpose. Their
 * conjunction is what distinguishes "did far more work than the answer justifies".
 */
export function matchesReadManyReturnFew(
  c: Pick<DeltaCandidate, 'blocksPerCall' | 'rowsPerCall' | 'amplification'>,
  opts: { minBlocksPerCall: number; maxRowsPerCall: number; minAmplification: number },
): boolean {
  return (
    c.blocksPerCall >= opts.minBlocksPerCall &&
    c.rowsPerCall <= opts.maxRowsPerCall &&
    c.amplification >= opts.minAmplification
  );
}

/** A raw Seq Scan node lifted out of a plan, before catalog resolution. */
export interface RawSeqScan {
  relation: string;
  planRows: number;
}

/**
 * Walk an EXPLAIN FORMAT JSON tree and collect every Seq Scan node.
 *
 * Recurses through `Plans`, and also through the plan-shaped members a plan tree can
 * carry outside it — `InitPlan`/`SubPlan` on older shapes, and the `Subplans` a
 * ModifyTable node hangs its per-relation plans from. Missing one of those is how a
 * scan hidden inside a CTE or a subquery goes unreported, which would make the detector
 * quietly blind to exactly the composite queries most likely to hide one.
 */
export function collectSeqScans(node: unknown): RawSeqScan[] {
  const out: RawSeqScan[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (!n || typeof n !== 'object') return;
    const rec = n as Record<string, unknown>;

    if (rec['Node Type'] === 'Seq Scan' && typeof rec['Relation Name'] === 'string') {
      out.push({
        relation: rec['Relation Name'],
        planRows: typeof rec['Plan Rows'] === 'number' ? rec['Plan Rows'] : 0,
      });
    }
    // Descend through every nested plan-bearing key rather than `Plans` alone.
    for (const key of ['Plan', 'Plans', 'InitPlan', 'SubPlan', 'Subplans']) {
      if (key in rec) visit(rec[key]);
    }
  };
  visit(node);
  return out;
}

/**
 * Is this statement text safe and sensible to hand to EXPLAIN?
 *
 * Two jobs. First, exclude what cannot be planned — utility statements (SET, VACUUM,
 * CREATE INDEX, BEGIN) simply error, and counting those as "explain failures" would
 * bury the failures that actually mean something. Second, refuse any text carrying a
 * non-trailing `;`: statement text is interpolated into the EXPLAIN rather than bound,
 * so this is the guard that keeps a single normalized statement from becoming two.
 */
export function isExplainable(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Reject a `;` anywhere but the very end — no multi-statement text reaches EXPLAIN.
  if (t.slice(0, -1).includes(';')) return false;
  const withoutLeadingComments = t.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)*/, '');
  return /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|TABLE|VALUES)\b/i.test(withoutLeadingComments);
}

/**
 * Recover the owning module from a SQL comment retained in the statement text (R2).
 *
 * pg_stat_statements keeps comments, and this codebase's tagged-template SQL carries
 * them on some statements — measured 2026-08-31: 2 of the top 12 statements by exec
 * time. Returns `undefined` when nothing is there. Deliberately not guessed from table
 * names: naming the wrong module is worse than naming none, because it sends the reader
 * to a file that never ran the query.
 */
export function extractCaller(text: string): string | undefined {
  const m = /\/\*([\s\S]{1,200}?)\*\//.exec(text);
  if (!m) return undefined;
  const body = m[1].trim();
  const ident = /([A-Za-z_$][\w$.-]{2,80})/.exec(body);
  return ident ? ident[1] : undefined;
}

// ---------------------------------------------------------------------------
// Database seams
// ---------------------------------------------------------------------------

interface PgssRow {
  userid: string | number;
  dbid: string | number;
  queryid: string | number;
  toplevel: boolean;
  query: string;
  calls: string | number;
  total_exec_time: string | number;
  rows: string | number;
  shared_blks_hit: string | number;
  shared_blks_read: string | number;
  stats_since: string | Date;
}

/**
 * Sample the statement table for the CURRENT database only.
 *
 * Scoped to `current_database()` because entries for other databases — including the
 * dropped ones db-pgss-orphan-stats-reclaim sweeps — cannot be EXPLAINed from this
 * connection and would only dilute the ranking.
 */
export async function samplePgss(
  sql: postgres.Sql,
): Promise<{ entries: Map<string, PgssSampleEntry>; texts: Map<string, string> }> {
  const rows = await sql<PgssRow[]>`
    SELECT userid, dbid, queryid, toplevel, query, calls, total_exec_time, rows,
           shared_blks_hit, shared_blks_read, stats_since
      FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND queryid IS NOT NULL`;

  const entries = new Map<string, PgssSampleEntry>();
  const texts = new Map<string, string>();
  for (const r of rows) {
    const key = sampleKey(r);
    entries.set(key, {
      calls: num(r.calls),
      totalExecTimeMs: num(r.total_exec_time),
      rows: num(r.rows),
      sharedBlks: num(r.shared_blks_hit) + num(r.shared_blks_read),
      statsSinceMs: new Date(r.stats_since).getTime(),
    });
    texts.set(key, r.query ?? '');
  }
  return { entries, texts };
}

/**
 * Resolve plan relation names to true on-disk sizes.
 *
 * Sizes come from `pg_total_relation_size` — heap + indexes + TOAST — never from
 * `reltuples`, which is -1 on a never-analyzed relation and reports a view's own
 * trivial count rather than the base table's. That distinction is the whole 718 case
 * (see the header), so it is enforced here rather than left to the caller.
 *
 * A plan names relations unqualified. When one name matches relations in several
 * schemas, the LARGEST is assumed and the hit is marked `ambiguousName`: for a size
 * threshold, over-estimating fails loud (a spurious finding a human dismisses) while
 * under-estimating fails silent (the defect this module exists to catch, missed again).
 */
export async function resolveRelationSizes(
  sql: postgres.Sql,
  names: string[],
): Promise<Map<string, { schema: string; sizeBytes: number; ambiguous: boolean }>> {
  const out = new Map<string, { schema: string; sizeBytes: number; ambiguous: boolean }>();
  if (names.length === 0) return out;

  const rows = await sql<{ relname: string; nspname: string; bytes: string }[]>`
    SELECT c.relname, n.nspname, pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = ANY(${names})
       AND c.relkind IN ('r', 'm', 'p', 'f')`;

  for (const r of rows) {
    const bytes = num(r.bytes);
    const prev = out.get(r.relname);
    if (!prev) {
      out.set(r.relname, { schema: r.nspname, sizeBytes: bytes, ambiguous: false });
    } else {
      out.set(r.relname, {
        schema: bytes > prev.sizeBytes ? r.nspname : prev.schema,
        sizeBytes: Math.max(bytes, prev.sizeBytes),
        ambiguous: true,
      });
    }
  }
  return out;
}

/**
 * Plan one statement without executing it.
 *
 * `GENERIC_PLAN` is mandatory, not a refinement: pg_stat_statements stores normalized
 * text whose literals are `$1` placeholders, and plain EXPLAIN rejects it for want of
 * parameter types. The READ ONLY transaction is belt to that braces — EXPLAIN without
 * ANALYZE already never executes the statement (verified against an UPDATE), and the
 * transaction makes that true even if someone later reaches for ANALYZE.
 *
 * Returns `null` on any failure. Unparseable text is EXPECTED here, because pgss
 * truncates at `track_activity_query_size`; a truncated statement is not an error worth
 * raising, and one bad entry must never strand the rest of the run.
 */
export async function explainGeneric(
  sql: postgres.Sql,
  text: string,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      const res = await tx.unsafe(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${text}`);
      const first = (res as unknown as Record<string, unknown>[])[0];
      return (first?.['QUERY PLAN'] ?? null) as unknown;
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run one hot-seq-scan detection pass.
 *
 * The first call of a process has no baseline and can only sample — it returns
 * `skipped: 'no-baseline'` with a `nextBaseline` to carry forward. That is the honest
 * report: a rate needs two observations, and pretending otherwise is precisely the
 * lifetime-totals mistake in trap 1.
 *
 * Never throws for a per-statement failure.
 */
export async function runHotSeqScanDetectionOnce(
  sql: postgres.Sql,
  opts: HotSeqScanOpts = {},
): Promise<HotSeqScanResult> {
  const cfg = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;

  const empty = (
    skipped: HotSeqScanResult['skipped'],
    nextBaseline: PgssBaseline,
    windowMs = 0,
  ): HotSeqScanResult => ({
    findings: [],
    nextBaseline,
    windowMs,
    candidates: 0,
    examined: 0,
    resetEntriesSkipped: 0,
    explainFailures: 0,
    notExplainable: 0,
    skipped,
  });

  // The extension is superuser-opt-in and not guaranteed to be installed.
  const [ext] = await sql<{ installed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
      AS installed`;
  if (!ext?.installed) {
    return empty('extension-absent', { sampledAt: now(), entries: new Map() });
  }

  const sampledAt = now();
  const { entries, texts } = await samplePgss(sql);
  const nextBaseline: PgssBaseline = { sampledAt, entries };

  const baseline = opts.baseline;
  if (!baseline || baseline.entries.size === 0) return empty('no-baseline', nextBaseline);

  const windowMs = sampledAt - baseline.sampledAt;
  // Too short a window: keep the ORIGINAL baseline so the delta keeps accumulating
  // rather than resetting the clock every run and never reaching a measurable window.
  if (windowMs < cfg.minWindowMs) return empty('window-too-short', baseline, windowMs);

  const { candidates, resetEntriesSkipped } = rankDeltas(baseline, entries, texts, {
    minCallsDelta: cfg.minCallsDelta,
  });

  const totalWindowTime = candidates.reduce((n, c) => n + Math.max(c.totalExecTimeMsDelta, 0), 0);

  const findings: HotSeqScanFinding[] = [];
  let examined = 0;
  let explainFailures = 0;
  let notExplainable = 0;

  for (const c of candidates.slice(0, cfg.topN)) {
    // Cheap arithmetic screen first — EXPLAIN only what already looks wrong, so a run
    // costs a couple of dozen plans rather than one per statement.
    if (!matchesReadManyReturnFew(c, cfg)) continue;
    if (!isExplainable(c.queryText)) {
      notExplainable += 1;
      continue;
    }

    examined += 1;
    const plan = await explainGeneric(sql, c.queryText, cfg.explainTimeoutMs);
    if (plan === null) {
      explainFailures += 1;
      continue;
    }

    const raw = collectSeqScans(plan);
    if (raw.length === 0) continue;

    const sizes = await resolveRelationSizes(sql, [...new Set(raw.map((s) => s.relation))]);
    const seqScans: SeqScanHit[] = [];
    for (const s of raw) {
      const info = sizes.get(s.relation);
      if (!info || info.sizeBytes < cfg.minRelationBytes) continue;
      if (seqScans.some((x) => x.relation === s.relation)) continue;
      seqScans.push({
        relation: s.relation,
        schema: info.schema,
        sizeBytes: info.sizeBytes,
        ...(info.ambiguous ? { ambiguousName: true } : {}),
      });
    }
    if (seqScans.length === 0) continue;

    findings.push({
      queryid: c.queryid,
      key: c.key,
      callsDelta: c.callsDelta,
      totalExecTimeMsDelta: c.totalExecTimeMsDelta,
      rowsDelta: c.rowsDelta,
      sharedBlksDelta: c.sharedBlksDelta,
      blocksPerCall: c.blocksPerCall,
      rowsPerCall: c.rowsPerCall,
      amplification: c.amplification,
      shareOfWindowTime:
        totalWindowTime > 0 ? Math.max(c.totalExecTimeMsDelta, 0) / totalWindowTime : 0,
      seqScans,
      ...(extractCaller(c.queryText) ? { caller: extractCaller(c.queryText) } : {}),
      queryText: c.queryText.replace(/\s+/g, ' ').slice(0, 400),
    });
  }

  return {
    findings,
    nextBaseline,
    windowMs,
    candidates: candidates.length,
    examined,
    resetEntriesSkipped,
    explainFailures,
    notExplainable,
  };
}

/**
 * One-line human summary of a finding, for a log line or an escalation body.
 *
 * Leads with the MEASURED cost, because that is the part that is a fact, and says
 * "generic-plans a Seq Scan" rather than "seq-scans" so the plan is never read as the
 * executed one — see the header's note on what a finding does and does not prove.
 */
export function describeFinding(f: HotSeqScanFinding): string {
  const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(0)} MB`;
  const rel = f.seqScans.map((s) => `${s.schema ? `${s.schema}.` : ''}${s.relation} (${mb(s.sizeBytes)})`).join(', ');
  return (
    `queryid=${f.queryid} reads ${f.blocksPerCall.toFixed(0)} blocks/call to return ` +
    `${f.rowsPerCall.toFixed(1)} rows/call (${f.amplification.toFixed(0)}x amplification) ` +
    `over ${f.callsDelta} calls, ${(f.shareOfWindowTime * 100).toFixed(1)}% of window exec time; ` +
    `generic-plans a Seq Scan on ${rel}` +
    `${f.caller ? `, caller≈${f.caller}` : ''}`
  );
}
