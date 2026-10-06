/**
 * pg-log.ts — PgCoordLog: a single-table Postgres CoordEventLog. The
 * optional production-grade swappable backend alongside FsCoordLog (the
 * portable default) and InMemoryCoordLog (the test double). It satisfies
 * the SAME `CoordEventLog` conformance suite (the P-050 swappability gate)
 * — see `event-log/conformance.ts`.
 *
 * One append-only table, `harness_shared.coord_event_log`, holds every
 * channel:
 *   - LINE surfaces (`messages`, `plan-events`): append a row, read ordered
 *     by the serial `id` (append order). The fs-only `filesBack` rotation
 *     hint is ignored — a single table has no rotation, exactly as the
 *     `ReadLinesOpts` contract permits.
 *   - EVENT surfaces (`handoffs`, `escalations`): one immutable record per
 *     `(workspace_id, surface, msg_id)`, enforced by a PARTIAL unique index +
 *     upsert. The predicate keeps pure-append line rows out of the uniqueness
 *     constraint.
 *
 * Every row carries a `workspace_id` scope, bound at construction (the
 * operator instance serves one workspace) and filtered on every read/write.
 * This is parity with `harness_shared.coord_presence.workspace_id` — the
 * coord channels are agent-to-agent messaging whose roster IS presence, so
 * the channel scope must equal the roster scope. It defaults to `'default'`
 * (the same fallback presence uses), so it is a no-op in the one-workspace
 * install of today and isolates channels cleanly if multiple installs ever
 * share one database (coord-channels-pg-port D-007). The fs layout had no
 * such column — the coord *directory* was the partition; under PG the bound
 * `workspace_id` plays that role.
 *
 * Host couplings are injected, matching PgPresenceStore: the org PG handle
 * (`getSql`) and the table bootstrap (`ensureSchema`). The canonical DDL is
 * exported as `ensureCoordEventLogTable` so a host's `ensureSchema` seam (and
 * the conformance harness) can create the table without duplicating schema.
 */

import type { Sql } from 'postgres';
import type { CoordEnvelope } from '@papercusp/pubsub-substrate/core';
import type {
  AppendLineIfAbsentResult,
  CoordEventLog,
  CoordLogCursorPage,
  EventSurface,
  LineSurface,
  ReadLinesOpts,
} from '@papercusp/pubsub-substrate/event-log';
import { withPgContentionRetry, type PgContentionRetryOptions } from './pg-retry';

/** The coordination scope used when a host does not bind one. Matches the
 *  `'default'` fallback `PgPresenceStore` writes for a workspace-less agent. */
export const DEFAULT_COORD_WORKSPACE = 'default';

export interface PgCoordLogOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure `harness_shared.coord_event_log` exists before first use. */
  ensureSchema: () => Promise<void>;
  /**
   * Coordination scope for every row this instance reads/writes — parity
   * with `coord_presence.workspace_id`. Bound at construction because the
   * surface methods carry no identity. Defaults to `'default'`.
   */
  workspaceId?: string;
  /**
   * Per-call workspace resolver (workspace-data-isolation-leaks-2026-06-17 F-C1).
   * When provided AND it returns a non-empty value, it OVERRIDES the fixed
   * `workspaceId` on every read/write — so the operator's single coordLog can
   * scope coord to the REQUEST's active workspace instead of one shared
   * partition. Falls back to `workspaceId` / 'default' when it returns empty.
   * Bound as a resolver (not a construction value) because one operator process
   * serves every workspace.
   */
  getWorkspaceId?: () => string;
  /** Optional retry tuning/dependency injection for transient PG contention. */
  contentionRetry?: PgContentionRetryOptions;
}

/**
 * Normalize a `jsonb` body to the envelope. postgres-js returns a jsonb
 * column inserted as `${JSON.stringify(x)}::jsonb` as the raw TEXT it was
 * cast from (not an auto-parsed object) under the prod handle's options
 * (`prepare: false`), so parse a string defensively — same posture as
 * PgPresenceStore's `parseFiles`.
 *
 * WI-3912: also BACKSTOPS `ts`/`msg_id` from the row's own NOT-NULL columns
 * when `body` itself is missing/blank them. Every LOCAL write path
 * (appendLine/putEvent/putEvents) stamps the columns FROM the envelope, so
 * body and column agree by construction for local rows — but a FEDERATED
 * remote row folds whatever the peer sent as `body` verbatim (fold-apply
 * does not re-validate CoordEnvelope shape), so a malformed/incomplete
 * remote envelope (observed live: coord_event_log id 458510, a deliberate
 * `origin=remote` test probe body with no `ts`/`msg_id` at all) can land in
 * the log with a body that violates the CoordEnvelope contract. Every
 * reader downstream (feed.ts's `compareByTsThenId`, which calls
 * `.localeCompare` on `a.ts`/`a.msg_id` unconditionally) assumed that
 * contract always holds — ONE such row made `coord:feed` throw a
 * `TypeError: Cannot read properties of undefined (reading 'localeCompare')`
 * on EVERY call reading it, not just a request touching that row specially
 * (it's within the default recent-window read). Filling the gap here, at
 * the read boundary, fixes the whole reader-side CLASS (any current or
 * future malformed row, local or remote) in one place instead of hardening
 * every consumer's sort/compare call individually.
 */
function parseBody(v: unknown, fallback?: { ts?: unknown; msg_id?: unknown }): CoordEnvelope {
  const parsed = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
  if ((typeof parsed.ts !== 'string' || !parsed.ts) && fallback?.ts != null) {
    parsed.ts = fallback.ts instanceof Date ? fallback.ts.toISOString() : String(fallback.ts);
  }
  if ((typeof parsed.msg_id !== 'string' || !parsed.msg_id) && fallback?.msg_id != null) {
    parsed.msg_id = String(fallback.msg_id);
  }
  return parsed as CoordEnvelope;
}

/**
 * Create the `coord_event_log` table + indexes if absent. Idempotent. The
 * canonical schema for `PgCoordLog` — wire it into a host `ensureSchema` seam
 * (or call it directly in a conformance harness).
 *
 * The `workspace_id` column + the `ADD COLUMN`/`DROP INDEX` guards keep this
 * idempotent across a schema that predates the scoping column (D-007): a
 * fresh table gets the scoped definitions outright; a table left over from
 * before the column existed is migrated in place (pre-alpha, test-only, so
 * the index rebuild is safe — no production data on this table yet). Every
 * mutating step is gated by a catalog existence check (`columnExists` /
 * `indexNeedsRebuild`) so the already-migrated steady state issues NO
 * lock-taking DDL — an unconditional `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * still grabs an ACCESS EXCLUSIVE lock and would trip `lock_timeout` against
 * the busy live org DB (the EI-1576 family of checkpoint flakes).
 */
export async function ensureCoordEventLogTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
      id           bigserial   PRIMARY KEY,
      workspace_id text        NOT NULL,
      surface      text        NOT NULL,
      writer_key   text,
      msg_id       text        NOT NULL,
      body         jsonb       NOT NULL,
      ts           timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Migrate a pre-D-007 table that has no scoping column. Guarded by a catalog
  // existence check so the steady state takes NO lock: `ALTER TABLE … ADD COLUMN
  // IF NOT EXISTS` acquires an ACCESS EXCLUSIVE lock on the table BEFORE it
  // evaluates the `IF NOT EXISTS`, so issuing it unconditionally on every call
  // blocks behind the live operator's concurrent writes to coord_event_log and
  // trips `lock_timeout` ("canceling statement due to lock timeout") under load —
  // observed as a green-checkpoint flake. The column already exists on every
  // migrated DB, so the ALTER now only ever runs once, on a genuinely legacy
  // table (same steady-state-skip posture as the index `indexNeedsRebuild` guards
  // below).
  if (!(await columnExists(sql, 'coord_event_log', 'workspace_id'))) {
    // The DEFAULT is REQUIRED here and is not the same thing as a standing column
    // default: adding a NOT NULL column to a table that already has rows needs a
    // fill value or the ALTER fails. So fill with it, then drop it immediately —
    // legacy rows land on 'default' (unchanged behaviour) while the column is left
    // with no standing default, per data-scoping-audit-2026-06-22 P-007 / D-005.
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        -- a one-shot FILL value for the legacy rows, NOT a standing column default:
        -- allow-workspace-default — the very next statement drops it.
        ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default'
    `;
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ALTER COLUMN workspace_id DROP DEFAULT
    `;
  }
  // harness_slug: the harness scope projected from CoordEnvelope.harness_slug.
  // NULL = operator-scope/workspace-global (local). The federation migration
  // (147) adds the same column + the capture triggers + the fed unique index;
  // keeping it here too means the runtime-bootstrapped table (conformance / fresh
  // test rigs) has the scope column without depending on migration order. Same
  // lock-avoiding existence guard as workspace_id above.
  if (!(await columnExists(sql, 'coord_event_log', 'harness_slug'))) {
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ADD COLUMN IF NOT EXISTS harness_slug text
    `;
  }
  // EI-18815759786278298: the coord-message projection's writeToPg (P-008
  // federation writer) INSERTs into every one of these columns unconditionally —
  // migration 732 (supersession, agent-epistemics-2026-08-02 P-004) and the
  // federation columns below are both required for that write to succeed on a
  // table this function (not a real migration run) bootstrapped. Same
  // lock-avoiding existence-guarded ALTER pattern as workspace_id/harness_slug
  // above; all four are nullable so the guard is purely about avoiding an
  // unconditional ACCESS EXCLUSIVE lock, never about a fill value.
  if (!(await columnExists(sql, 'coord_event_log', 'superseded_by_msg_id'))) {
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ADD COLUMN IF NOT EXISTS superseded_by_msg_id text,
        ADD COLUMN IF NOT EXISTS superseded_at timestamptz
    `;
  }
  if (!(await columnExists(sql, 'coord_event_log', 'origin'))) {
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local',
        ADD COLUMN IF NOT EXISTS author_pubkey text,
        ADD COLUMN IF NOT EXISTS fed_ts bigint,
        ADD COLUMN IF NOT EXISTS fed_hlc text
    `;
  }
  // EVENT surfaces are keyed: exactly one immutable record per (workspace_id,
  // surface, msg_id). LINE surfaces (messages/plan-events) are pure append —
  // the partial predicate keeps them out of the uniqueness constraint so the
  // upsert below targets only the event rows.
  //
  // These indexes are (re)built ONLY when missing or in the legacy pre-D-007
  // shape (without `workspace_id`). A blind DROP-then-CREATE on EVERY call is
  // NOT concurrency-safe: this DDL runs against the LIVE org DB — both the
  // operator's `getOrgPg` and the conformance / integration suites that
  // resolve the same `connectionString()` — and during the brief
  // ACCESS-EXCLUSIVE window between DROP and CREATE every concurrent
  // `putEvent` upsert fails with `42P10: there is no unique or exclusion
  // constraint matching the ON CONFLICT specification` (EI-1576; the window
  // widens under PG congestion, where the DROP itself waits on a lock). The
  // index already exists with the right shape on every migrated DB, so the
  // common path now leaves it untouched — the window only ever opens once, to
  // widen a genuinely legacy index. (Pre-alpha: no production data on this
  // table, so that one-time legacy rebuild remains safe.)
  if (await indexNeedsRebuild(sql, 'coord_event_log_event_uq')) {
    await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_event_uq`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_event_uq
        ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
        WHERE surface IN ('handoffs', 'escalations')
    `;
  }
  if (await indexNeedsRebuild(sql, 'coord_event_log_surface_id')) {
    await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_surface_id`;
    await sql`
      CREATE INDEX IF NOT EXISTS coord_event_log_surface_id
        ON harness_shared.coord_event_log (workspace_id, surface, id)
    `;
  }
}

/**
 * True when the named `harness_shared.coord_event_log` index is absent or in
 * the legacy pre-D-007 shape (lacking `workspace_id`) and so must be
 * (re)built; false when it already carries the scoped definition and MUST be
 * left in place. Reading `pg_indexes.indexdef` lets `ensureCoordEventLogTable`
 * skip the destructive DROP/CREATE in the steady state — the fix for the
 * recurring 42P10 upsert failures of EI-1576.
 */
async function indexNeedsRebuild(sql: Sql, indexName: string): Promise<boolean> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'harness_shared' AND indexname = ${indexName}
  `;
  if (rows.length === 0) return true; // missing → build
  return !/\bworkspace_id\b/.test(rows[0].indexdef); // legacy narrow → widen
}

/**
 * True when `harness_shared.<table>` already has the named column. Lets
 * `ensureCoordEventLogTable` skip the `ALTER TABLE … ADD COLUMN` in the steady
 * state — Postgres grabs an ACCESS EXCLUSIVE lock on the table BEFORE it checks
 * `IF NOT EXISTS`, so the otherwise no-op ALTER still blocks on a busy live
 * `coord_event_log` and trips `lock_timeout`. The catalog read takes only
 * ACCESS SHARE on the system catalogs (never on coord_event_log itself), so it
 * never contends with the operator's row writes. Same steady-state-skip posture
 * as `indexNeedsRebuild`.
 */
async function columnExists(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS present
  `;
  return rows[0]?.present === true;
}

/**
 * WI-3937: incremental per-(workspace,surface) cache state for `readLines`.
 * `coord_event_log` LINE surfaces are append-only with a monotonic bigserial
 * `id`, so after ONE full read the cache only ever needs the `id > watermark`
 * delta — see the readLines doc comment for the full rationale + safety rails.
 */
interface ReadLinesCacheEntry extends IdleEvictable {
  /** Highest `id` folded into `rows` (the delta watermark). */
  maxId: number;
  /** The surface's envelopes in `id ASC` order (append order). Treated as
   *  READ-ONLY by contract; readLines returns a fresh array copy per call. */
  rows: CoordEnvelope[];
  /** ids of the most recent rows (overlap-window dedupe — commit-order race). */
  recentIds: Set<number>;
  /** When the last FULL read ran — TTL'd so GC deletions eventually fold out. */
  fullReadAtMs: number;
}

/** How far below the watermark the delta re-reads (commit-order race guard):
 *  a row whose bigserial `id` was assigned before our snapshot but whose
 *  transaction COMMITTED after it would otherwise be skipped forever. Rows are
 *  written by short single-statement INSERTs, so in-flight-id depth is tiny;
 *  1000 is orders of magnitude of headroom at ~1000× less cost than the old
 *  full-surface read. */
const READLINES_CACHE_OVERLAP_IDS = 1_000;
/** How many trailing row ids the dedupe set retains (≥ the overlap window, with
 *  headroom for interleaved concurrent delta reads); rebuilt from the tail when
 *  it doubles past this target so it never grows unbounded. */
const READLINES_CACHE_RECENT_IDS = 2_000;
/** Full re-read cadence — bounds how long a GC-DELETED row can linger in the
 *  cache (deletes don't advance the id watermark). LINE surfaces are GC'd
 *  rarely (escalation GC targets EVENT surfaces), so 5 min is conservative. */
const READLINES_CACHE_FULL_REFRESH_MS = 5 * 60_000;
/** The refresh TTL, env-overridable (PAPERCUSP_COORD_READLINES_CACHE_TTL_MS)
 *  so tests can force the full-refresh path without waiting 5 minutes. */
function readLinesCacheRefreshMs(): number {
  const env = Number(process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : READLINES_CACHE_FULL_REFRESH_MS;
}
/** Kill switch: PAPERCUSP_COORD_READLINES_CACHE=0 restores the always-full read. */
function readLinesCacheEnabled(): boolean {
  return process.env.PAPERCUSP_COORD_READLINES_CACHE !== '0';
}

/**
 * WI-3993 (the WI-3937 class, EVENT-surface leg): incremental per-
 * (workspace, surface) cache state for `readEvents`. Event surfaces differ
 * from LINE surfaces in two ways the readLines cache shape can't handle:
 *   - rows are UPSERT-MUTABLE in place — putEvent's ON CONFLICT keeps the
 *     row's `id` but rewrites `body` and sets `ts = now()` — so an
 *     id-watermark delta alone would serve a stale body forever;
 *   - exactly one record per (workspace, surface, msg_id) — the partial
 *     unique index — so the cache keys by `msg_id` and REPLACES on re-read,
 *     which is what makes both overlap windows below idempotent-safe.
 * The delta therefore reads `id > watermark−overlap OR ts > lastRead−skew`:
 * the id leg catches NEW rows, the ts leg catches in-place upserts (their
 * fresh `ts = now()` stamp). GC deletions (escalation-log-gc) fold out on the
 * TTL'd full refresh, exactly like readLines.
 */
interface ReadEventsCacheEntry extends IdleEvictable {
  /** Highest `id` folded (the NEW-row delta watermark). */
  maxId: number;
  /** One entry per msg_id (the event-surface key); REPLACED on upsert re-read. */
  byMsgId: Map<string, { id: number; envelope: CoordEnvelope }>;
  /** Local wall-clock captured just BEFORE the last successful read was
   *  issued — the `ts >` delta leg re-reads anything upserted after this
   *  (minus the skew window). */
  lastReadStartMs: number;
  /** When the last FULL read ran — TTL'd so GC deletions eventually fold out. */
  fullReadAtMs: number;
}

/** How far back the upsert (`ts >`) delta leg over-reads: covers app↔PG clock
 *  drift plus the window where an upsert's `ts = now()` (transaction start)
 *  predates its COMMIT (putEvent is a short single statement, so minutes of
 *  headroom is overkill by design). Over-reads are deduped by the msg_id
 *  replace, so generosity here costs a few re-fetched rows, never wrong data. */
const READEVENTS_CACHE_TS_SKEW_MS = 120_000;
/** The refresh TTL, env-overridable (PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS)
 *  so tests can force the full-refresh path without waiting 5 minutes. */
function readEventsCacheRefreshMs(): number {
  const env = Number(process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : READLINES_CACHE_FULL_REFRESH_MS;
}
/** Kill switch: PAPERCUSP_COORD_READEVENTS_CACHE=0 restores the always-full read. */
function readEventsCacheEnabled(): boolean {
  return process.env.PAPERCUSP_COORD_READEVENTS_CACHE !== '0';
}

/**
 * A readLines/readEvents cache entry that goes unread this long is dropped.
 * Without it, ONE full read of a large surface stays resident for the whole
 * process lifetime: a single fallback read of `messages` pinned ~2 GB in
 * papercusp-bg-host (host-memory-reduction-2026-09-27 D-010/D-011). A caller
 * that keeps reading keeps its entry warm, so the WI-3937 furnace protection
 * is unchanged for real hot readers. Env override for tests.
 */
const COORD_LOG_CACHE_IDLE_EVICT_MS = 10 * 60_000;
function coordLogCacheIdleMs(): number {
  const env = Number(process.env.PAPERCUSP_COORD_LOG_CACHE_IDLE_MS);
  return Number.isFinite(env) && env > 0 ? env : COORD_LOG_CACHE_IDLE_EVICT_MS;
}

interface IdleEvictable {
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** (Re)arm `entry`'s idle eviction. Called on every read that serves from the cache. */
function armIdleEviction<E extends IdleEvictable>(cache: Map<string, E>, key: string, entry: E): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (cache.get(key) === entry) cache.delete(key);
  }, coordLogCacheIdleMs());
  entry.idleTimer.unref?.();
}

/**
 * Bound every full/rebuild read. The cache
 * is process-local, so a fleet of fresh operator processes can legitimately
 * prime the same (workspace, surface) key at once; leaving the prime query
 * unbounded still makes each process a furnace even though later calls use the
 * watermark. The `(workspace_id, surface, id)` index makes this forward keyset
 * pagination cheap and preserves the same complete `id ASC` result.
 */
export const COORD_LOG_READ_PAGE_SIZE = 10_000;

/**
 * A FULL read at or above this many rows is announced with its caller's stack.
 * Paging bounds each query, not the process: the readLines/readEvents caches keep
 * every row they prime for the process lifetime, and the `messages` surface
 * (536k rows, 1.14 GB of JSON text on 2026-09-27) retained 2,059 MB of V8 heap in
 * a bare probe, which was most of papercusp-bg-host's resident set. Every
 * `messages` reader has a scoped SQL fast path, so a full read of that size is a
 * fallback firing; the stack names which one (host-memory-reduction-2026-09-27 P-005).
 */
export const COORD_LOG_FULL_READ_WARN_ROWS = 50_000;

interface CoordLogRow {
  id: string | number;
  body: unknown;
  ts: Date;
  msg_id: string;
}

async function readCoordLogRows(
  sql: Sql,
  workspaceId: string,
  surface: LineSurface | EventSurface,
  startAfterId: number | null = null,
): Promise<CoordLogRow[]> {
  const all: CoordLogRow[] = [];
  let afterId = startAfterId;
  // Captured before the first await, while the caller's frames are still on the stack.
  const fullReadCaller = startAfterId === null ? new Error('coord_event_log full read').stack : undefined;
  const startedAtMs = Date.now();

  for (;;) {
    const page =
      afterId === null
        ? await sql<CoordLogRow[]>`
            SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
             WHERE workspace_id = ${workspaceId} AND surface = ${surface}
             ORDER BY id ASC
             LIMIT ${COORD_LOG_READ_PAGE_SIZE}
          `
        : await sql<CoordLogRow[]>`
            SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
             WHERE workspace_id = ${workspaceId} AND surface = ${surface} AND id > ${afterId}
             ORDER BY id ASC
             LIMIT ${COORD_LOG_READ_PAGE_SIZE}
          `;
    if (page.length === 0) break;

    all.push(...page);
    const nextId = Number(page[page.length - 1].id);
    if (!Number.isFinite(nextId) || (afterId !== null && nextId <= afterId)) {
      throw new Error(`coord_event_log pagination did not advance for surface=${surface}`);
    }
    afterId = nextId;
    if (page.length < COORD_LOG_READ_PAGE_SIZE) break;
  }

  if (fullReadCaller && all.length >= COORD_LOG_FULL_READ_WARN_ROWS) {
    console.warn(
      `[coord-log] FULL read of surface=${surface} workspace=${workspaceId}: ${all.length} rows in ` +
        `${Date.now() - startedAtMs} ms. A cached surface stays resident for this process's lifetime. Caller:\n` +
        fullReadCaller.split('\n').slice(1, 13).join('\n'),
    );
  }
  return all;
}
/** The readEvents return contract: envelopes in `id ASC` (append) order —
 *  identical to the pre-cache `ORDER BY id ASC` read. */
function sortedEventEnvelopes(entry: ReadEventsCacheEntry): CoordEnvelope[] {
  return [...entry.byMsgId.values()].sort((a, b) => a.id - b.id).map((v) => v.envelope);
}

/**
 * WI-6988: the `kinds` predicate shared by every bounded reader — and the ONE
 * place that must never emit a single-element `= ANY(...)`.
 *
 * All four bounded reads below are `ORDER BY id DESC LIMIT n` over
 * `coord_event_log_surface_kind_id_idx (workspace_id, surface, (body->>'kind'),
 * id DESC)`, an index shaped exactly for them. But PostgreSQL cannot treat an
 * index scan as ORDERED on the trailing columns when a preceding column is
 * matched by a ScalarArrayOpExpr — and `= ANY(array)` is a SAOP even when the
 * array holds exactly one value. The planner still PICKS the index (so every
 * check we have reads "indexed"), then has to materialize EVERY matching row
 * and top-N heapsort it: the LIMIT stops nothing.
 *
 * Measured live, surface='escalations', kinds=['escalation'], LIMIT 500,
 * identical rows out — `= ANY` : Sort over 9,258 rows, 9,168 buffers, 31.8ms
 * vs plain `=` : ordered Index Scan that stops at 500, 486 buffers, 2.9ms
 * (18.9x buffers, 11.2x time). In production this query was 22,034 calls at a
 * 4,432ms mean = 27.1h of DB time over 23 days.
 *
 * So: ONE kind collapses to a scalar equality (the ordered path); MULTIPLE
 * kinds keep the ANY form, which the planner degrades to a backward scan of
 * the surface index plus a filter — correct, and cheap exactly when a
 * multi-kind filter is unselective. Every caller in the tree passes one kind.
 *
 * The cost scales with how SELECTIVE the kind is within its surface, which is
 * why this hid for so long: on `messages` (kind='message' is ~99% of rows) the
 * fallback scan finds its 500 almost immediately and the defect is nearly
 * invisible; on `escalations` (~48%) it is already 19x.
 */
function kindPredicate(sql: Sql, kinds: readonly string[] | undefined) {
  if (!kinds || kinds.length === 0) return sql``;
  if (kinds.length === 1) return sql`AND body->>'kind' = ${kinds[0]}`;
  return sql`AND body->>'kind' = ANY(${kinds as string[]}::text[])`;
}

export class PgCoordLog implements CoordEventLog {
  /** Construction-time fallback scope; the per-call resolver (F-C1) overrides it. */
  private readonly fallbackWs: string;

  /** WI-3937 readLines incremental cache, keyed `${workspace}::${surface}`. */
  private readonly readLinesCache = new Map<string, ReadLinesCacheEntry>();
  /** The in-flight full (re)read per key: concurrent cold callers share ONE read
   *  instead of each materialising the whole surface (D-011). */
  private readonly readLinesPriming = new Map<string, Promise<ReadLinesCacheEntry>>();

  /** WI-3993 readEvents incremental cache, keyed `${workspace}::${surface}`. */
  private readonly readEventsCache = new Map<string, ReadEventsCacheEntry>();
  /** readEvents twin of {@link readLinesPriming}. */
  private readonly readEventsPriming = new Map<string, Promise<ReadEventsCacheEntry>>();

  constructor(private readonly opts: PgCoordLogOptions) {
    this.fallbackWs = opts.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  }

  /**
   * The coordination workspace to scope to NOW (F-C1): the per-call
   * `getWorkspaceId` resolver when set + non-empty, else the construction-time
   * fallback. Resolved per use because one operator coordLog serves every
   * workspace — binding it once would pin all coord to a single partition.
   */
  private resolveWs(): string {
    const dyn = this.opts.getWorkspaceId?.();
    return dyn && dyn.trim() ? dyn : this.fallbackWs;
  }

  /**
   * The coordination workspace every row of this instance reads/writes. Exposed
   * so a caller issuing its OWN targeted `coord_event_log` query (rather than
   * going through readLines) can scope it to the SAME workspace this seam uses —
   * keeping such reads consistent with appendLine/readLines instead of assuming
   * `'default'`. (operator-core readAckedMsgIds relies on this.)
   */
  get workspaceId(): string {
    return this.resolveWs();
  }

  /**
   * The postgres handle this seam reads/writes. Exposed alongside `workspaceId`
   * so a targeted-query caller hits the SAME database — in production this is
   * `getOrgPg().sql`, but a swapped seam (tests, a non-default backend) points
   * elsewhere, so a caller must NOT reach for `getOrgPg()` independently.
   */
  getSql(): Sql {
    return this.opts.getSql();
  }

  async appendLine(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
  ): Promise<number | null> {
    return withPgContentionRetry(async () => {
      await this.opts.ensureSchema();
      const sql = this.opts.getSql();
    // `::text::jsonb` (not bare `::jsonb`): the explicit text cast forces
    // postgres-js to bind the JSON as a plain text param, so it stores a real
    // jsonb OBJECT under BOTH the operator runtime client (getOrgPg — where a
    // bare `::jsonb` happens to work but `sql.json()` throws) AND a fresh /
    // testcontainer pool (where bare `::jsonb` double-encodes to a jsonb
    // string). One form, correct everywhere. See agent-insight
    // postgres-js-jsonb-binding.
    //
    // WI-3826 (fleet-reliability-verification-2026-07-10): `ts` is stamped
    // EXPLICITLY from `line.ts` (the envelope's own construction-time
    // timestamp) instead of the column's DEFAULT now(). The row USED to get
    // its `ts` from whenever this INSERT happened to commit — but callers
    // (e.g. sendMessage) build the envelope, then `await` audience/hive-scope
    // resolution BEFORE calling appendLine, so a slow resolve step let the
    // column drift >1s past body.ts on ~4.3% of live `messages` rows. Any
    // `WHERE ts >= $since` pushdown compared against body.ts (what
    // application code, e.g. filterInbox, has always used) would then
    // silently drop those rows. Stamping from `line.ts` makes column and body
    // agree BY CONSTRUCTION for every future row. (Existing divergent rows are
    // one-time-repaired by migration 546; `id` — not `ts` — is the append-order
    // cursor everywhere in this codebase, e.g. coord-inbox-bus.ts, so this
    // does not disturb ordering semantics.)
    // RETURNING id (P-009): the bigserial is this store's sequence number, and
    // the ONE moment it is knowable without a follow-up read. `intent_event_id`
    // on tool_invocations points at exactly this row, so a caller that appends
    // an intent declaration can cache the pointer here instead of re-querying
    // for "the row I just wrote" — which under concurrent appends by the same
    // writer is not even reliably answerable.
    const rows = await sql<{ id: string | number }[]>`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      VALUES (${this.resolveWs()}, ${surface}, ${writerKey}, ${line.msg_id}, ${JSON.stringify(line)}::text::jsonb, ${line.harness_slug ?? null}, ${line.ts}::timestamptz)
      RETURNING id
    `;
    // postgres-js returns bigint columns as strings (raw-serializers.ts) — a
    // silent NaN here would poison the pointer, so coerce explicitly and
    // degrade to null rather than stamping a bad id.
    const raw = rows[0]?.id;
    const id = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(id) ? id : null;
    }, this.opts.contentionRetry);
  }

  /**
   * Claim a line idempotently without adding a schema-level unique index for
   * the append-only `messages` surface. The transaction-scoped advisory lock
   * serializes only callers for this workspace/surface/msg_id; the existing
   * row is read and, when absent, inserted on the same connection.
   */
  async appendLineIfAbsent(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
    hooks?: {
      /** Producers validating several sources can require one coherent snapshot. */
      transactionOptions?: 'isolation level repeatable read';
      /** Prepare a fresh line on the SAME transaction as its append. Replays skip preparation. */
      prepare?: (tx: import('postgres').Sql | import('postgres').TransactionSql) => Promise<CoordEnvelope>;
      /** A producer's commit-boundary assertion; throwing rolls back the append. */
      afterAppend?: (tx: import('postgres').Sql | import('postgres').TransactionSql) => Promise<void>;
    },
  ): Promise<AppendLineIfAbsentResult> {
    return withPgContentionRetry(async () => {
      await this.opts.ensureSchema();
      const sql = this.opts.getSql();
      const workspaceId = this.resolveWs();
      // PostgreSQL text parameters cannot contain NUL bytes. The old
      // delimiter-separated key used NUL as an in-process composite-key
      // separator, then bound that string as text, so every idempotent
      // append failed before it could read or insert the line
      // (`invalid byte sequence for encoding "UTF8": 0x00`). JSON's
      // deterministic escaping keeps the tuple unambiguous while ensuring
      // even caller-provided NULs become the six printable characters
      // `\u0000` before the value crosses the driver boundary.
      const lockKey = JSON.stringify([workspaceId, surface, line.msg_id]);
      const append = async (tx: import('postgres').Sql | import('postgres').TransactionSql) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const existing = await tx<{ id: string | number; body: unknown; ts: Date; msg_id: string }[]>`
          SELECT id, body, ts, msg_id
            FROM harness_shared.coord_event_log
           WHERE workspace_id = ${workspaceId}
             AND surface = ${surface}
             AND msg_id = ${line.msg_id}
           ORDER BY id ASC
           LIMIT 1
        `;
        if (existing.length > 0) {
          const raw = existing[0].id;
          const sequence = typeof raw === 'number' ? raw : Number(raw);
          return {
            created: false,
            sequence: Number.isFinite(sequence) ? sequence : null,
            envelope: parseBody(existing[0].body, existing[0]),
          };
        }
        const prepared = hooks?.prepare ? await hooks.prepare(tx) : line;
        if (prepared.msg_id !== line.msg_id) throw new Error('append preparation changed replay identity');
        const inserted = await tx<{ id: string | number }[]>`
          INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
          VALUES (${workspaceId}, ${surface}, ${writerKey}, ${prepared.msg_id}, ${JSON.stringify(prepared)}::text::jsonb, ${prepared.harness_slug ?? null}, ${prepared.ts}::timestamptz)
          RETURNING id
        `;
        await hooks?.afterAppend?.(tx);
        const raw = inserted[0]?.id;
        const sequence = typeof raw === 'number' ? raw : Number(raw);
        return {
          created: true,
          sequence: Number.isFinite(sequence) ? sequence : null,
          envelope: prepared,
        };
      };
      if (!hooks?.transactionOptions) return sql.begin(append);
      // Repeatable-read snapshots must begin AFTER replay serialization. An
      // advisory lock taken inside that transaction would freeze a waiter's
      // snapshot before the winning insert and admit a duplicate on release.
      const reserved = await sql.reserve();
      try {
        await reserved`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
        // postgres.js ReservedSql's declarations inherit begin(), but its
        // runtime exposes only the query tag and release(). Keep every command
        // on that reserved connection and explicitly settle the transaction.
        await reserved.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          const result = await append(reserved);
          await reserved.unsafe('COMMIT');
          return result;
        } catch (error) {
          await reserved.unsafe('ROLLBACK');
          throw error;
        }
      } finally {
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
        } finally {
          reserved.release();
        }
      }
    }, this.opts.contentionRetry);
  }

  async readLines(surface: LineSurface, _opts: ReadLinesOpts = {}): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // `filesBack` is an fs-rotation hint; a single table has no rotation, so
    // we read everything (the interface explicitly allows ignoring it).
    //
    // WI-3937: this used to be an UNBOUNDED full-surface read on EVERY call
    // (~28k bodies/call; 285k calls / 8.04B rows / 48h of DB time in
    // pg_stat_statements) — the furnace that saturated the shared embedded PG
    // and starved the bg-host substrate drain into its 120s PASS TIMEOUT
    // (P-059 RED). LINE surfaces are append-only with a monotonic bigserial
    // `id`, so we now do ONE full read per (workspace, surface) per process —
    // plus a TTL'd re-check (READLINES_CACHE_FULL_REFRESH_MS) so rare GC
    // deletions fold out — and afterwards only the `id > watermark - overlap`
    // delta. EI-21918895581219651: the TTL'd re-check is now a CHEAP indexed
    // COUNT, not an unconditional full re-read — see the comment at the TTL
    // branch below. The overlap window re-reads the last READLINES_CACHE_OVERLAP_IDS
    // ids to catch a row whose bigserial id was assigned before our snapshot
    // but whose transaction committed after it; `recentIds` dedupes the
    // overlap (and any interleaved concurrent delta read — new rows are always
    // added to the set before a later reader processes the same delta).
    //
    // CONTRACT: the returned ARRAY is a fresh copy per call, but the envelope
    // OBJECTS are shared across calls — callers must treat envelopes as
    // read-only (they always received fresh parses before and never mutated
    // them). Kill switch: PAPERCUSP_COORD_READLINES_CACHE=0.
    if (!readLinesCacheEnabled()) {
      const rows = await readCoordLogRows(sql, this.resolveWs(), surface);
      return rows.map((r) => parseBody(r.body, r));
    }

    const ws = this.resolveWs();
    const key = `${ws}::${surface}`;
    const now = Date.now();
    let entry = this.readLinesCache.get(key);

    if (entry && now - entry.fullReadAtMs > readLinesCacheRefreshMs()) {
      // EI-21918895581219651: the TTL exists SOLELY to fold out rare GC deletions
      // (message-log-gc runs once/day, cron '0 5 4 * * *') — appends are already
      // caught on EVERY call by the delta leg below, independent of this TTL. So
      // paying the full O(surface) body-fetch-and-sort unconditionally every 5
      // minutes was buying almost nothing: measured live, this exact branch (the
      // `SELECT id, body, ts, msg_id ... ORDER BY id ASC` with no LIMIT) produced
      // a 389k-row / 277MB parallel-seq-scan-and-sort taking 8.6s-32.9s, recurring
      // roughly every 5-10 minutes on a persistent process, forever, growing with
      // the log. A COUNT served by the (workspace_id, surface, id) index tells us
      // CHEAPLY whether anything was actually deleted since our last full read:
      // appends can only ever grow the live count above what we already hold (the
      // delta leg accounts for those independently of this TTL), so a live count
      // BELOW what we're caching is the only way a genuine deletion shows up here.
      const countRows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.coord_event_log
         WHERE workspace_id = ${ws} AND surface = ${surface}
      `;
      const liveCount = countRows[0]?.n ?? 0;
      if (liveCount < entry.rows.length) {
        // Disarm first: the idle timer's closure would otherwise keep this whole
        // superseded snapshot alive beside the rebuilt one until it fired.
        clearTimeout(entry.idleTimer);
        entry = undefined; // a deletion happened — fall through to the full rebuild below
      } else {
        // Nothing deleted — re-arm the TTL clock without paying for the body
        // fetch; the delta leg below still folds in anything appended since.
        entry.fullReadAtMs = now;
      }
    }

    if (!entry) {
      // Full (re)read — first call for this key, or a deletion was detected above.
      // Single-flight: a caller arriving while it runs awaits the same read.
      let priming = this.readLinesPriming.get(key);
      if (!priming) {
        priming = (async () => {
          // The full rebuild itself is keyset-paged; int8 `id` arrives as a STRING
          // from postgres-js — Number() everywhere.
          const rows = await readCoordLogRows(sql, ws, surface);
          const recentIds = new Set<number>();
          for (let i = Math.max(0, rows.length - READLINES_CACHE_RECENT_IDS); i < rows.length; i++) {
            recentIds.add(Number(rows[i].id));
          }
          const fresh: ReadLinesCacheEntry = {
            maxId: rows.length > 0 ? Number(rows[rows.length - 1].id) : 0,
            rows: rows.map((r) => parseBody(r.body, r)),
            recentIds,
            fullReadAtMs: now,
          };
          this.readLinesCache.set(key, fresh);
          return fresh;
        })().finally(() => this.readLinesPriming.delete(key));
        this.readLinesPriming.set(key, priming);
      }
      const fresh = await priming;
      armIdleEviction(this.readLinesCache, key, fresh);
      return fresh.rows.slice();
    }

    // Delta read: only rows past the watermark, minus the overlap window.
    const sinceId = Math.max(0, entry.maxId - READLINES_CACHE_OVERLAP_IDS);
    const rows = await readCoordLogRows(sql, ws, surface, sinceId);
    for (const r of rows) {
      const idNum = Number(r.id);
      if (entry.recentIds.has(idNum)) continue; // already folded (overlap / concurrent delta)
      entry.rows.push(parseBody(r.body, r));
      entry.recentIds.add(idNum);
      if (idNum > entry.maxId) entry.maxId = idNum;
    }
    // Bound the dedupe set: rebuild from the newest ids once it doubles past
    // target. Kept ids ≫ the overlap window, so dedupe coverage never lapses.
    if (entry.recentIds.size > READLINES_CACHE_RECENT_IDS * 2) {
      const keep = [...entry.recentIds].sort((a, b) => a - b).slice(-READLINES_CACHE_RECENT_IDS);
      entry.recentIds = new Set(keep);
    }
    armIdleEviction(this.readLinesCache, key, entry);
    return entry.rows.slice();
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // WI-3826: the FIRST insert stamps `ts` from `record.ts` (same reasoning as
    // appendLine — column agrees with body by construction). A re-put (ON CONFLICT)
    // keeps its deliberate `ts = now()` — that path means the event was genuinely
    // TOUCHED again (e.g. an escalation resolve), and its ts is meant to reflect
    // that touch, not the original envelope's timestamp.
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      VALUES (${this.resolveWs()}, ${surface}, NULL, ${msgId}, ${JSON.stringify(record)}::text::jsonb, ${record.harness_slug ?? null}, ${record.ts}::timestamptz)
      ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
      DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
    `;
  }

  /**
   * WI-10769: the atomic claim. `ON CONFLICT DO NOTHING ... RETURNING` yields a row
   * ONLY when this statement actually inserted, so N concurrent callers see exactly
   * one `true` — decided by Postgres, with no read-then-write window for them to
   * race through. This is the property `putEvent` structurally cannot offer: it
   * upserts, so every caller succeeds and none can tell whether it was first.
   *
   * NOTE the partial-index predicate is repeated here exactly as in `putEvent` —
   * the unique index is `WHERE surface IN ('handoffs','escalations')`, and a
   * conflict target that does not match the index's predicate does not resolve to
   * it (Postgres raises "no unique or exclusion constraint matching"), so this
   * method is only meaningful for those two surfaces.
   */
  async putEventIfAbsent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<boolean> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    try {
      const rows = await sql`
        INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
        VALUES (${this.resolveWs()}, ${surface}, NULL, ${msgId}, ${JSON.stringify(record)}::text::jsonb, ${record.harness_slug ?? null}, ${record.ts}::timestamptz)
        ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
        DO NOTHING
        RETURNING 1 AS inserted
      `;
      return rows.length > 0;
    } catch (e) {
      // A unique violation on a NON-arbiter index still means "someone already holds
      // this key", so it is a lost claim, not a failure. This table carries a SECOND
      // partial unique index — `coord_event_log_fed_uq (workspace_id, msg_id) WHERE
      // harness_slug IS NOT NULL AND body->>'notify_kind' IS NULL` — and an
      // `ON CONFLICT` naming one arbiter does NOT suppress a conflict raised by a
      // different index. Measured 2026-08-08: 19 of 562 recent `escalations` rows
      // populate `harness_slug`, so that index really does cover part of this
      // surface. Without this catch those rows would throw under exactly the
      // concurrency this method exists to make safe.
      if ((e as { code?: string })?.code === '23505') return false;
      throw e;
    }
  }

  async putEvents(
    surface: EventSurface,
    records: ReadonlyArray<{ msgId: string; record: CoordEnvelope }>,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const ws = this.resolveWs();
    // The batch win (escalation-drain WI-346 / round3 P-001): write N records in
    // ONE statement instead of N separate `putEvent` INSERTs. Per-row putEvent
    // costs N round-trips AND — inside a DBOS step-budgeted reconcile — N steps,
    // capping a drain tick at a few hundred. One multi-row INSERT is one
    // round-trip + one DBOS step, so a large backlog drains in a single tick.
    //
    // Bind the rows as parallel text[] arrays and expand with `unnest`. `body`
    // goes through `::text::jsonb` per-row exactly like putEvent/appendLine: the
    // explicit text cast forces postgres-js to store a real jsonb OBJECT under
    // BOTH the prod handle and a fresh/testcontainer pool (agent-insight
    // postgres-js-jsonb-binding). Same ON CONFLICT upsert as putEvent — caller
    // must pass distinct msgIds within one batch (a re-put of an existing id
    // upserts; two identical ids in ONE batch would trip the ON CONFLICT
    // "cannot affect row a second time" — escalation resolves use fresh msg_ids).
    // WI-3826: `ts` travels alongside `body`/`harness_slug` in the same unnest, so the
    // FIRST insert of each row stamps ts from ITS OWN record.ts (matches putEvent).
    const msgIds = records.map((r) => r.msgId);
    const bodies = records.map((r) => JSON.stringify(r.record));
    const harnessSlugs = records.map((r) => r.record.harness_slug ?? null);
    const timestamps = records.map((r) => r.record.ts);
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      SELECT ${ws}, ${surface}, NULL, t.msg_id, t.body::text::jsonb, t.harness_slug, t.ts::timestamptz
        FROM unnest(${msgIds}::text[], ${bodies}::text[], ${harnessSlugs}::text[], ${timestamps}::text[])
          AS t(msg_id, body, harness_slug, ts)
      ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
      DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
    `;
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // WI-3993 — the WI-3937 class, EVENT-surface leg. This was the LAST raw
    // unbounded full-surface body read left in the seam (WI-3937 cached
    // readLines; EI-1548 clamped readEventsBounded): every call streamed the
    // whole surface (`escalations` ≈ 27k rows / 14MB), and on 2026-07-10 one
    // such read stuck on a jammed client event loop (wait_event=ClientWrite,
    // 276s+) held the coord server down ~30min. Same cure as readLines — ONE
    // full read per (workspace, surface) per process + a TTL'd re-check, then
    // deltas only — adapted for event-surface semantics (see ReadEventsCacheEntry:
    // upsert ts-leg, replace-by-msg_id, GC fold-out). EI-21918895581219651: the
    // TTL'd re-check is a CHEAP indexed COUNT, not an unconditional full
    // re-read — see the comment at the TTL branch below.
    //
    // CONTRACT (unchanged from the pre-cache read): fresh array per call,
    // envelope OBJECTS shared across calls (callers treat them as read-only),
    // `id ASC` order. Kill switch: PAPERCUSP_COORD_READEVENTS_CACHE=0.
    if (!readEventsCacheEnabled()) {
      const rows = await readCoordLogRows(sql, this.resolveWs(), surface);
      return rows.map((r) => parseBody(r.body, r));
    }

    const ws = this.resolveWs();
    const key = `${ws}::${surface}`;
    const now = Date.now();
    let entry = this.readEventsCache.get(key);

    if (entry && now - entry.fullReadAtMs > readEventsCacheRefreshMs()) {
      // EI-21918895581219651 (the readLines-leg sibling of this same class): the
      // TTL exists SOLELY to fold out rare GC deletions (escalation-log-gc, which
      // never advances id/ts) — new AND upserted rows are already caught on EVERY
      // call by the delta leg below, independent of this TTL. Paying the full
      // O(surface) body-fetch-and-sort unconditionally every 5 minutes buys almost
      // nothing given GC's own cadence. A COUNT served by the
      // (workspace_id, surface, id) index tells us CHEAPLY whether anything was
      // actually deleted since our last full read: appends/upserts can only ever
      // hold the live count steady or grow it (the delta leg accounts for those
      // independently of this TTL — upserts don't change the row COUNT at all), so
      // a live count BELOW what we're caching is the only way a genuine deletion
      // shows up here.
      const countRows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.coord_event_log
         WHERE workspace_id = ${ws} AND surface = ${surface}
      `;
      const liveCount = countRows[0]?.n ?? 0;
      if (liveCount < entry.byMsgId.size) {
        clearTimeout(entry.idleTimer); // same reason as readLines
        entry = undefined; // a deletion happened — fall through to the full rebuild below
      } else {
        // Nothing deleted — re-arm the TTL clock without paying for the body
        // fetch; the delta leg below still folds in anything appended/upserted since.
        entry.fullReadAtMs = now;
      }
    }

    if (!entry) {
      // Full (re)read — first call for this key, or a deletion was detected above.
      // Single-flight, exactly like readLines.
      let priming = this.readEventsPriming.get(key);
      if (!priming) {
        priming = (async () => {
          // The full rebuild itself is keyset-paged; int8 `id` arrives as a STRING
          // from postgres-js — Number().
          const rows = await readCoordLogRows(sql, ws, surface);
          const byMsgId = new Map<string, { id: number; envelope: CoordEnvelope }>();
          let maxId = 0;
          for (const r of rows) {
            const idNum = Number(r.id);
            byMsgId.set(r.msg_id, { id: idNum, envelope: parseBody(r.body, r) });
            if (idNum > maxId) maxId = idNum;
          }
          const fresh: ReadEventsCacheEntry = { maxId, byMsgId, lastReadStartMs: now, fullReadAtMs: now };
          this.readEventsCache.set(key, fresh);
          return fresh;
        })().finally(() => this.readEventsPriming.delete(key));
        this.readEventsPriming.set(key, priming);
      }
      const fresh = await priming;
      armIdleEviction(this.readEventsCache, key, fresh);
      return sortedEventEnvelopes(fresh);
    }

    // Delta read: NEW rows past the id watermark (minus the commit-order
    // overlap window, same rationale as readLines) OR rows UPSERTED in place
    // since the last read (their `ts = now()` stamp — the leg an id watermark
    // alone would miss, serving a stale body forever). Both legs are
    // over-inclusive by design; the replace-by-msg_id fold makes re-reads
    // idempotent.
    const sinceId = Math.max(0, entry.maxId - READLINES_CACHE_OVERLAP_IDS);
    const sinceTs = new Date(entry.lastReadStartMs - READEVENTS_CACHE_TS_SKEW_MS).toISOString();
    const rows = await sql<{ id: string | number; body: unknown; ts: Date; msg_id: string }[]>`
      SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws} AND surface = ${surface}
         AND (id > ${sinceId} OR ts > ${sinceTs}::timestamptz)
       ORDER BY id ASC
    `;
    for (const r of rows) {
      const idNum = Number(r.id);
      entry.byMsgId.set(r.msg_id, { id: idNum, envelope: parseBody(r.body, r) });
      if (idNum > entry.maxId) entry.maxId = idNum;
    }
    entry.lastReadStartMs = now;
    armIdleEviction(this.readEventsCache, key, entry);
    return sortedEventEnvelopes(entry);
  }

  async readEventsBounded(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Hard-clamp the LIMIT so a caller can never re-open the unbounded-read hole
    // this method exists to close (EI-1548). ORDER BY id DESC rides the
    // coord_event_log_surface_id (workspace_id, surface, id) index.
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kindPredicate(sql, kinds)}
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async readLinesBounded(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Line surfaces (`messages`/`plan-events`) live in the SAME coord_event_log
    // table, so this is the line parallel of readEventsBounded: newest-first,
    // hard-clamped LIMIT, ORDER BY id DESC riding the coord_event_log_surface_id
    // index. The since_ts / plan_slug pushdown (EI-1737 / fleet-concurrency-first
    // P-005) keeps the watermark-advancing coord:plan-events delta (turn start,
    // ×fleet) reading only its tail instead of the whole ~3.5MB surface. Optional
    // `AND`s — an omitted filter inlines to an empty fragment (no-op).
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const sinceTs = typeof opts.sinceTs === 'string' && opts.sinceTs ? opts.sinceTs : null;
    const planSlug = typeof opts.planSlug === 'string' && opts.planSlug ? opts.planSlug : null;
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kindPredicate(sql, kinds)}
         ${sinceTs ? sql`AND body->>'ts' > ${sinceTs}` : sql``}
         ${planSlug ? sql`AND body->>'plan_slug' = ${planSlug}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface} AND msg_id = ${msgId}
       LIMIT 1
    `;
    return rows.length > 0 ? parseBody(rows[0].body, rows[0]) : null;
  }

  /**
   * WI-3880: the true incremental-pagination sibling of `readEventsBounded`.
   * `id` is the table's real bigserial PK — a persistent, monotonic
   * append-order cursor — so `beforeId` (`AND id < $beforeId`) lets a caller
   * walk arbitrarily deep into history instead of being capped at one
   * fixed-size window. Fetches `limit + 1` rows to detect `exhausted` (whether
   * anything OLDER than the returned page remains) without a second
   * round-trip, then trims the extra row off the returned page.
   */
  async readEventsBoundedCursor(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[]; beforeId?: number; beforeTs?: string; beforeMsgId?: string },
  ): Promise<CoordLogCursorPage> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const beforeId =
      typeof opts.beforeId === 'number' && Number.isFinite(opts.beforeId) ? Math.floor(opts.beforeId) : null;
    const beforeTs = typeof opts.beforeTs === 'string' && opts.beforeTs ? opts.beforeTs : null;
    const beforeTsPredicate = beforeTs
      ? opts.beforeMsgId
        ? sql`AND (body->>'ts')::timestamptz <= ${beforeTs}::timestamptz`
        : sql`AND (body->>'ts')::timestamptz < ${beforeTs}::timestamptz`
      : sql``;
    const rows = await sql<{ id: number; body: unknown; ts: Date; msg_id: string }[]>`
      SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kindPredicate(sql, kinds)}
         ${beforeTsPredicate}
         ${beforeId !== null ? sql`AND id < ${beforeId}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit + 1}
    `;
    const exhausted = rows.length <= limit;
    const page = rows.slice(0, limit);
    // `id` is bigserial (int8); postgres-js returns int8 columns as a STRING
    // (not a JS number) to avoid precision loss outside Number.MAX_SAFE_INTEGER.
    // Normalize to a real number here — this table will never approach 2^53
    // rows — so a caller's round-tripped `beforeId` (typeof === 'number') binds
    // correctly on the next call instead of silently failing the `typeof
    // opts.beforeId === 'number'` guard above and dropping the cursor filter.
    return {
      rows: page.map((r) => ({ id: Number(r.id), envelope: parseBody(r.body, r) })),
      exhausted,
    };
  }

  /** The line-surface sibling of {@link readEventsBoundedCursor} — same
   *  `id < beforeId` cursor, plus the existing time/plan pushdowns. */
  async readLinesBoundedCursor(
    surface: LineSurface,
    opts: {
      limit: number;
      sinceTs?: string;
      planSlug?: string;
      kinds?: string[];
      beforeId?: number;
      beforeTs?: string;
      beforeMsgId?: string;
    },
  ): Promise<CoordLogCursorPage> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const sinceTs = typeof opts.sinceTs === 'string' && opts.sinceTs ? opts.sinceTs : null;
    const planSlug = typeof opts.planSlug === 'string' && opts.planSlug ? opts.planSlug : null;
    const beforeId =
      typeof opts.beforeId === 'number' && Number.isFinite(opts.beforeId) ? Math.floor(opts.beforeId) : null;
    const beforeTs = typeof opts.beforeTs === 'string' && opts.beforeTs ? opts.beforeTs : null;
    const beforeTsPredicate = beforeTs
      ? opts.beforeMsgId
        // Line-surface column ts is stamped from body.ts on write; keep the
        // boundary bucket for the caller's exact composite msg_id tie-break.
        ? sql`AND ts <= ${beforeTs}::timestamptz`
        : sql`AND ts < ${beforeTs}::timestamptz`
      : sql``;
    const rows = await sql<{ id: number; body: unknown; ts: Date; msg_id: string }[]>`
      SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kindPredicate(sql, kinds)}
         ${sinceTs ? sql`AND body->>'ts' > ${sinceTs}` : sql``}
         ${planSlug ? sql`AND body->>'plan_slug' = ${planSlug}` : sql``}
         ${beforeTsPredicate}
         ${beforeId !== null ? sql`AND id < ${beforeId}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit + 1}
    `;
    const exhausted = rows.length <= limit;
    const page = rows.slice(0, limit);
    // See the same Number(...) normalization note in readEventsBoundedCursor.
    return {
      rows: page.map((r) => ({ id: Number(r.id), envelope: parseBody(r.body, r) })),
      exhausted,
    };
  }
}
