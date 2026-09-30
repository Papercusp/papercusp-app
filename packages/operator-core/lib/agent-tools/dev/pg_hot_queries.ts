/**
 * dev:pg_hot_queries — sample pg_stat_statements twice and rank what advanced.
 *
 * pg_stat_statements is cumulative. A large lifetime total can describe a query
 * that stopped running days ago, so lifetime ORDER BYs are not a live-load
 * diagnostic. This tool keeps no transaction or pool connection open while it
 * waits: it takes one snapshot, releases the query, waits, then takes another.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { extractPgErrorInfo } from '../../pg-read-query';

const DEFAULT_WINDOW_SEC = 15;
const DEFAULT_LIMIT = 15;
const MAX_QUERY_CHARS = 240;
const DEAD_CONFIDENCE = 0.95;
const SELF_SAMPLER_MARKER = 'dev:pg_hot_queries sampler';

type DbRow = {
  userid: string | number | null;
  dbid: string | number | null;
  toplevel: boolean | null;
  queryid: string | number | null;
  query: string | null;
  calls: string | number | null;
  total_exec_time_ms: string | number | null;
  rows: string | number | null;
  stats_since: string | Date | null;
};

export type PgStatementSnapshotRow = {
  key: string;
  userId: string;
  dbId: string;
  topLevel: boolean;
  queryId: string | null;
  query: string;
  calls: bigint;
  totalExecMs: number;
  rows: bigint;
  statsSinceMs: number | null;
};

export type PgStatementsSnapshot = {
  capturedAtMs: number;
  rows: PgStatementSnapshotRow[];
  /**
   * `pg_stat_statements_info.dealloc` at snapshot time — CLUSTER-WIDE (not
   * scoped to the current database), monotonic until an explicit reset. A
   * change between two snapshots means the cap forced an eviction somewhere
   * in the window: EI-19447625969710283 — an evicted-then-recreated entry's
   * counters restart at zero, so its next delta is a phantom spike rather
   * than real load. `diffPgStatements` surfaces the delta so a reader can
   * tell a genuine spike from an eviction artifact instead of trusting the
   * ranking blind.
   */
  dealloc: number;
  /** `count(*) FROM pg_stat_statements` — CLUSTER-WIDE entry occupancy at snapshot time. */
  entryCount: number;
  /** `pg_stat_statements.max` (postmaster-context; needs a restart to raise). */
  capMax: number;
};

export type PgHotQueriesInput = {
  windowSec?: number;
  limit?: number;
  filter?: string;
};

export type PgHotQueriesDeps = {
  readSnapshot: () => Promise<PgStatementsSnapshot>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function toBigInt(value: string | number | null): bigint {
  if (value == null || value === '') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toNumber(value: string | number | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value: string | Date | null): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function excerpt(query: string): string {
  const oneLine = query.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_QUERY_CHARS ? oneLine : `${oneLine.slice(0, MAX_QUERY_CHARS - 1)}…`;
}

function snapshotKey(row: DbRow): string {
  const queryId = row.queryid == null ? `text:${row.query ?? ''}` : String(row.queryid);
  return `${row.userid ?? ''}:${row.dbid ?? ''}:${row.toplevel ?? true}:${queryId}`;
}

function isSelfSampler(row: { query: string }): boolean {
  return row.query.toLowerCase().includes(SELF_SAMPLER_MARKER);
}

/** Read one point-in-time pg_stat_statements snapshot for the current DB only. */
export async function readPgStatementsSnapshot(): Promise<PgStatementsSnapshot> {
  const { sql } = getOrgPg();
  const rows = await sql<DbRow[]>`
    SELECT /* dev:pg_hot_queries sampler */
           userid::text AS userid,
           dbid::text AS dbid,
           toplevel,
           queryid::text AS queryid,
           query,
           calls::text AS calls,
           total_exec_time::float8 AS total_exec_time_ms,
           rows::text AS rows,
           stats_since
      FROM public.pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;

  // Cluster-wide (not per-database, unlike the rows above): the eviction cap and its
  // pressure counters are global to the extension, not scoped to one database.
  const [info] = await sql<{ dealloc: string | number | null; entry_count: string | number | null; cap_max: string | number | null }[]>`
    SELECT (SELECT dealloc::text FROM pg_stat_statements_info) AS dealloc,
           (SELECT count(*)::text FROM pg_stat_statements) AS entry_count,
           (SELECT setting FROM pg_settings WHERE name = 'pg_stat_statements.max') AS cap_max`;

  return {
    capturedAtMs: Date.now(),
    rows: rows.map((row) => ({
      key: snapshotKey(row),
      userId: String(row.userid ?? ''),
      dbId: String(row.dbid ?? ''),
      topLevel: row.toplevel ?? true,
      queryId: row.queryid == null ? null : String(row.queryid),
      query: row.query ?? '',
      calls: toBigInt(row.calls),
      totalExecMs: toNumber(row.total_exec_time_ms),
      rows: toBigInt(row.rows),
      statsSinceMs: timestampMs(row.stats_since),
    })),
    dealloc: toNumber(info?.dealloc ?? null),
    entryCount: toNumber(info?.entry_count ?? null),
    capMax: toNumber(info?.cap_max ?? null),
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Sampling aborted before the second snapshot.'), { code: 'ABORT_ERR' }));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(Object.assign(new Error('Sampling aborted before the second snapshot.'), { code: 'ABORT_ERR' }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

type Pair = { before?: PgStatementSnapshotRow; after?: PgStatementSnapshotRow };

function deltaBigInt(after: bigint, before: bigint): bigint {
  return after >= before ? after - before : after;
}

function deltaNumber(after: number, before: number): number {
  return after >= before ? after - before : after;
}

function resultRow(pair: Pair, windowSec: number, sampleEndMs: number, stale: boolean) {
  const lifetime = pair.after ?? pair.before!;
  const before = pair.before;
  const after = pair.after;
  const counterReset = Boolean(
    before &&
    after &&
    (after.calls < before.calls || after.totalExecMs < before.totalExecMs || after.rows < before.rows),
  );
  const calls = after ? (before ? deltaBigInt(after.calls, before.calls) : after.calls) : 0n;
  const execMs = after ? (before ? deltaNumber(after.totalExecMs, before.totalExecMs) : after.totalExecMs) : 0;
  const rows = after ? (before ? deltaBigInt(after.rows, before.rows) : after.rows) : 0n;
  const callsNumber = Number(calls);
  const rowsNumber = Number(rows);
  const lifetimeCallsNumber = Number(lifetime.calls);
  const lifetimeRowsNumber = Number(lifetime.rows);
  const lifetimeObservationSec =
    lifetime.statsSinceMs == null ? null : Math.max(0, (sampleEndMs - lifetime.statsSinceMs) / 1000);
  const expectedCalls =
    lifetimeObservationSec && lifetimeObservationSec > 0
      ? (lifetimeCallsNumber / lifetimeObservationSec) * windowSec
      : null;
  const zeroConfidence = expectedCalls == null ? null : 1 - Math.exp(-expectedCalls);
  const zeroCallVerdict =
    calls > 0n
      ? null
      : zeroConfidence == null
        ? 'unknown'
        : zeroConfidence >= DEAD_CONFIDENCE
          ? 'dead'
          : 'too-rare-to-tell';

  return {
    queryId: lifetime.queryId,
    query: excerpt(lifetime.query),
    topLevel: lifetime.topLevel,
    inWindow: {
      execMs: round(execMs, 3),
      calls: calls.toString(),
      callsPerSec: round(callsNumber / windowSec, 4),
      msPerCall: calls > 0n ? round(execMs / callsNumber, 3) : null,
      rows: rows.toString(),
      rowsPerCall: calls > 0n ? round(rowsNumber / callsNumber, 3) : null,
    },
    lifetime: {
      execMs: round(lifetime.totalExecMs, 3),
      calls: lifetime.calls.toString(),
      msPerCall: lifetime.calls > 0n ? round(lifetime.totalExecMs / lifetimeCallsNumber, 3) : null,
      rows: lifetime.rows.toString(),
      rowsPerCall: lifetime.calls > 0n ? round(lifetimeRowsNumber / lifetimeCallsNumber, 3) : null,
      statsSince: lifetime.statsSinceMs == null ? null : new Date(lifetime.statsSinceMs).toISOString(),
    },
    stale,
    zeroCallVerdict,
    statisticalPower:
      calls > 0n
        ? null
        : {
            method: 'poisson-from-lifetime-call-rate',
            expectedCalls: expectedCalls == null ? null : round(expectedCalls, 3),
            confidencePct: zeroConfidence == null ? null : round(zeroConfidence * 100, 2),
            deadThresholdPct: DEAD_CONFIDENCE * 100,
          },
    newEntry: !before && Boolean(after),
    vanished: Boolean(before) && !after,
    counterReset,
  };
}

/**
 * Pure delta engine, exported so the recurrence guard does not require a real
 * sleep or a mutable pg_stat_statements installation in unit tests.
 */
export function diffPgStatements(
  before: PgStatementsSnapshot,
  after: PgStatementsSnapshot,
  input: Required<Pick<PgHotQueriesInput, 'limit'>> & Pick<PgHotQueriesInput, 'filter'>,
) {
  const actualWindowSec = Math.max(0.001, (after.capturedAtMs - before.capturedAtMs) / 1000);
  const pairs = new Map<string, Pair>();
  for (const row of before.rows) pairs.set(row.key, { before: row });
  for (const row of after.rows) {
    const pair = pairs.get(row.key) ?? {};
    pair.after = row;
    pairs.set(row.key, pair);
  }

  const filter = input.filter?.trim().toLowerCase() || null;
  const matching = [...pairs.values()].filter((pair) => {
    const row = pair.after ?? pair.before;
    if (!row || isSelfSampler(row)) return false;
    return filter == null || row.query.toLowerCase().includes(filter);
  });
  const rows = matching.map((pair) => {
    const provisional = resultRow(pair, actualWindowSec, after.capturedAtMs, false);
    const active = BigInt(provisional.inWindow.calls) > 0n || provisional.inWindow.execMs > 0;
    return { pair, provisional, active };
  });
  const hot = rows
    .filter((row) => row.active)
    .sort(
      (a, b) =>
        b.provisional.inWindow.execMs - a.provisional.inWindow.execMs ||
        Number(BigInt(b.provisional.inWindow.calls) - BigInt(a.provisional.inWindow.calls)),
    )
    .slice(0, input.limit)
    .map((row) => row.provisional);
  const staleLifetimeLeaders = rows
    .filter((row) => !row.active && row.provisional.lifetime.execMs > 0)
    .sort((a, b) => b.provisional.lifetime.execMs - a.provisional.lifetime.execMs)
    .slice(0, Math.min(3, input.limit))
    .map((row) => resultRow(row.pair, actualWindowSec, after.capturedAtMs, true));

  // EI-19447625969710283: dealloc is CLUSTER-WIDE, so it moving during the window means
  // the cap forced an eviction — possibly of a statement not even in `matching` (a query
  // outside this sample's filter, or one that never ran again to be re-observed). A
  // per-row `counterReset` already flags the entries THIS sample can see corrupted; this
  // is the whole-cluster confirmation that lets a reader trust the absence of
  // counterReset instead of just hoping the window got lucky.
  const deallocDuringWindow = deltaNumber(after.dealloc, before.dealloc);
  const evictedDuringWindow = deallocDuringWindow > 0;
  const occupancyPct = after.capMax > 0 ? round((after.entryCount / after.capMax) * 100, 1) : null;

  return {
    sample: {
      startedAt: new Date(before.capturedAtMs).toISOString(),
      endedAt: new Date(after.capturedAtMs).toISOString(),
      actualWindowSec: round(actualWindowSec, 3),
      firstSnapshotStatements: before.rows.length,
      secondSnapshotStatements: after.rows.length,
      matchedStatements: matching.length,
      activeStatements: rows.filter((row) => row.active).length,
      zeroCallStatements: rows.filter((row) => !row.active).length,
      filter,
      capPressure: {
        entryCount: after.entryCount,
        capMax: after.capMax,
        occupancyPct,
        deallocBefore: before.dealloc,
        deallocAfter: after.dealloc,
        deallocDuringWindow,
        evictedDuringWindow,
      },
    },
    hot,
    staleLifetimeLeaders,
    note:
      'stale:true means a large lifetime total had zero calls in this sample. zeroCallVerdict=dead is a >=95% Poisson result at the statement lifetime-average call rate; it is not proof that the query can never recur. too-rare-to-tell means this window had insufficient power.' +
      (evictedDuringWindow
        ? ` ⚠ capPressure.evictedDuringWindow=true (${deallocDuringWindow} entr${deallocDuringWindow === 1 ? 'y' : 'ies'} evicted cluster-wide during this sample) — a row here with counterReset:true had its in-window delta corrupted by an evict-then-recreate (its "delta" is really its full re-accumulation since eviction, not a real per-window rate); pg_stat_statements.max is ${after.capMax} and occupancy is ${occupancyPct}%.`
        : ''),
  };
}

export async function samplePgHotQueries(
  input: PgHotQueriesInput,
  signal?: AbortSignal,
  deps: PgHotQueriesDeps = { readSnapshot: readPgStatementsSnapshot, sleep: abortableSleep },
) {
  const windowSec = input.windowSec ?? DEFAULT_WINDOW_SEC;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const before = await deps.readSnapshot();
  await deps.sleep(windowSec * 1000, signal);
  const after = await deps.readSnapshot();
  return {
    requestedWindowSec: windowSec,
    limit,
    ...diffPgStatements(before, after, { limit, filter: input.filter }),
  };
}

export function classifyPgStatStatementsError(error: unknown): {
  reason: string;
  message: string;
  code?: string;
} {
  const info = extractPgErrorInfo(error);
  const text = `${info.message ?? ''} ${info.detail ?? ''}`.toLowerCase();
  if (info.code === '42P01') {
    return {
      reason: 'pg_stat_statements_not_installed',
      message: 'pg_stat_statements is not installed in this database.',
      code: info.code,
    };
  }
  if (info.code === '42501') {
    return {
      reason: 'pg_stat_statements_permission_denied',
      message: 'The operator database role cannot read pg_stat_statements.',
      code: info.code,
    };
  }
  if (text.includes('must be loaded via shared_preload_libraries')) {
    return {
      reason: 'pg_stat_statements_not_loaded',
      message: 'pg_stat_statements is installed but not loaded via shared_preload_libraries.',
      ...(info.code ? { code: info.code } : {}),
    };
  }
  if ((error as { code?: string } | null)?.code === 'ABORT_ERR') {
    return { reason: 'sampling_aborted', message: 'Sampling was aborted before the second snapshot.' };
  }
  return {
    reason: 'pg_hot_queries_failed',
    message: info.message ?? String(error),
    ...(info.code ? { code: info.code } : {}),
  };
}

export default defineTool({
  name: 'dev:pg_hot_queries',
  profile: 'engineer',
  description:
    'Sample pg_stat_statements twice and rank queries by IN-WINDOW execution-time delta. Returns calls/s, ms/call and rows/call beside lifetime totals, plus stale lifetime leaders with zero-call statistical power.',
  capability: 'intel:read',
  guidance: {
    when: 'You need to know what is burning database time NOW, or whether a catastrophic pg_stat_statements lifetime total is still advancing. This catches frequent short queries that an instantaneous pg_stat_activity read misses.',
    notWhen:
      'You need one currently-running/blocked query → dev:pg_active_queries. You need ad-hoc SQL or EXPLAIN → dev:pg_query. This call intentionally waits windowSec between snapshots.',
    chaining:
      'Start with the default 15s window. A zero is conclusive only when zeroCallVerdict is dead; too-rare-to-tell needs a longer window or a stored long-running baseline. Use filter for a case-insensitive query-text substring.',
    returns:
      '{ requestedWindowSec, limit, sample, hot[], staleLifetimeLeaders[], note }. hot is ranked by in-window execMs, not cumulative totals. staleLifetimeLeaders reserves up to three zero-call lifetime leaders so stale historical cost cannot masquerade as live load. sample.capPressure reports pg_stat_statements cap occupancy and whether the CLUSTER-WIDE eviction counter (dealloc) moved during this sample — evictedDuringWindow:true means any hot/staleLifetimeLeaders row with counterReset:true is a phantom spike (its "delta" is a fresh re-accumulation since eviction, not real in-window load), and it is also possible for a statement outside this filter to have been evicted unseen.',
    seeAlso: [
      'dev:pg_active_queries (queries executing at one instant)',
      'dev:pg_query (one-off SQL / EXPLAIN)',
      'dev:pg_health (database and connection health)',
    ],
  },
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'mug', 'scoper', 'reviewer', 'validator', 'worker'],
  args: z.object({
    windowSec: z.number().int().min(1).max(600).optional().default(DEFAULT_WINDOW_SEC),
    limit: z.number().int().min(1).max(100).optional().default(DEFAULT_LIMIT),
    filter: z.string().trim().min(1).max(500).optional(),
  }),
  result: z
    .object({
      requestedWindowSec: z.unknown().optional(),
      limit: z.unknown().optional(),
      sample: z.unknown().optional(),
      hot: z.unknown().optional(),
      staleLifetimeLeaders: z.unknown().optional(),
      note: z.unknown().optional(),
    })
    .passthrough(),
  async handler(rawArgs, ctx) {
    const args = rawArgs ?? {};
    try {
      return { data: await samplePgHotQueries(args, ctx.signal) };
    } catch (error) {
      const classified = classifyPgStatStatementsError(error);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: classified.message, ...classified }) }],
      };
    }
  },
});
