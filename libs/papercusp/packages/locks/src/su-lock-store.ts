/**
 * SU agent file-lock coordination — storage layer.
 *
 * Owns:
 *   - Connection pools to the `papercusp_su` side-database (tx pool +
 *     listener pool, see §8 of su-agent-coordination-v3-2026-05-14.md).
 *   - Bootstrap of `papercusp_su` against the main `papercusp` database
 *     on first call.
 *   - Migration runner (idempotent; SHARE UPDATE EXCLUSIVE on su_meta
 *     to serialize concurrent runners — audit 3 #6).
 *   - Low-level acquire/release/heartbeat/cancel/queue helpers.
 *
 * Tools (acquire.ts, release.ts, …) call these helpers; they don't
 * touch postgres-js directly.
 */

// Note: no `import 'server-only'` — the store is exercised by smoke
// scripts and unit tests that run outside any server bundle. Server-only
// gating happens in the embedding app at the tool-registration boundary
// (the operator's agent-tools/index.ts, only loaded by its route handler).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { locksHost } from './config';
import {
  sweepResourceExpired,
  sweepResourceWaitersExpired,
} from './resource-lock-store';

/**
 * Tx type re-export. Store helpers take `Sql`; callers inside
 * `inWorkspaceTxn` pass a `TransactionSql` (assignable via a single
 * cast at the wrapper boundary — see in-workspace-txn.ts).
 */
export type SuSqlTxn = Sql;
export type SuTransactionSql = TransactionSql<Record<string, unknown>>;

/**
 * SU-locks feature key in the advisory-lock registry (see
 * `sql/advisory-lock-keys.md`). The workspace gate uses
 * `hashtext('su:'||domain)` and path-scoped transactions add one lock for
 * each `hashtext('su:'||domain||':'||path)`. Lives here so both the per-call
 * txn wrapper (`in-workspace-txn.ts`) and the background janitor share one
 * definition.
 */
export const SU_LOCKS_FEATURE_KEY = 101;

// ───────── Connection pools ─────────

/**
 * Resolve the URL for the SU side-database. Same host/port/role as the
 * main papercusp DB, different database name.
 *
 * The plan calls for a separate `papercusp_su` role, but operationally
 * that requires password-file management for embedded PG where there
 * is no external network surface — marginal value, real complexity.
 * We reuse `harness_admin` (the existing role with full access to the
 * embedded PG instance) and keep ONLY the database separate. Workload
 * isolation, drop-and-recreate, and per-database backup retention are
 * preserved; the grant-isolation goal is dropped as YAGNI.
 */
function suUrl(): string {
  const main = locksHost().getAdminBaseUrl();
  // Replace the path component (the database name) with `papercusp_su`.
  // URLs look like: postgresql://user:pass@host:port/dbname?params
  return main.replace(/\/[^/?]+(\?|$)/, '/papercusp_su$1');
}

function mainUrl(): string {
  // For bootstrap (CREATE DATABASE) we must NOT be connected to the
  // db we're creating. The injected admin URL targets the main db.
  return locksHost().getAdminBaseUrl();
}

let txPool: Sql | null = null;
let listenerPool: Sql | null = null;
let bootstrapped = false;

/**
 * EI-18122461766429683: this package has no dependency on `@papercusp/db-org`
 * (adding one just for this would be a new cross-package edge for two lines of
 * options), so this is a deliberate INLINE local copy of
 * `@papercusp/db-org`'s `longLivedPoolConnectionOptions(label)` — same shape,
 * same rationale: (1) tags the connection with a `pcusp:<label>:p<pid>`
 * application_name so it is attributable in `pg_stat_activity` / `dev:pg_health`
 * (postgres-js always overrides a database-level `ALTER DATABASE ... SET
 * application_name` default with its own startup parameter, so that alone —
 * see `mainUrl()`'s ALTER DATABASE elsewhere in this codebase — does not
 * work); (2) applies the WI-3816 dead-client zombie-detection GUC
 * (`client_connection_check_interval`) + tightened TCP keepalives, so a
 * long-lived pool whose OWNING PROCESS dies without a clean `.end()` (crash,
 * `dev:restart`, SIGKILL — common on this dev box) gets reaped by the BACKEND
 * itself instead of sitting idle forever (this pair of pools was the single
 * largest attributable contributor to the server-wide connection-saturation
 * crit: 28 idle, unattributed `postgres.js` connections on `papercusp_su`).
 * Keep this in sync with `@papercusp/db-org`'s copy if either changes.
 */
function suPoolConnectionOptions(label: string): {
  onnotice: () => void;
  connection: Record<string, string>;
} {
  const appName = `pcusp:${label}:p${process.pid}`.slice(0, 63);
  return {
    onnotice: () => {},
    connection: {
      application_name: appName,
      client_connection_check_interval: '30000',
      tcp_keepalives_idle: '30',
      tcp_keepalives_interval: '10',
      tcp_keepalives_count: '3',
    },
  };
}

/**
 * Seconds an idle TRANSACTIONAL connection may live. Mirrors `poolIdleTimeoutSec()`
 * in `@papercusp/db-org` (this package deliberately does not depend on it — see the
 * keep-in-sync note on {@link suPoolConnectionOptions}), including its env knob.
 *
 * ⚠ postgres-js defaults `idle_timeout` to 0 = NEVER CLOSE. `getTxPool` is a purely
 * transactional pool with `max: 10`, so on that default every process parked up to 10
 * backends for its entire lifetime: measured live 2026-07-26, 34 idle `su-lock-tx`
 * connections on `papercusp_su` (some idle 25+ min), the second-largest consumer of a
 * saturated 343/512 `max_connections`. The zombie-detection GUCs above only reap
 * connections whose OWNING PROCESS DIED — they do nothing for a live process holding
 * idle backends, which is this.
 */
const TX_POOL_IDLE_TIMEOUT_SEC = Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_TIMEOUT) || 30);

export function getTxPool(): Sql {
  if (!txPool) {
    txPool = postgres(suUrl(), {
      ...suPoolConnectionOptions('su-lock-tx'),
      max: 10,
      idle_timeout: TX_POOL_IDLE_TIMEOUT_SEC,
      prepare: false,
      // Run our SET LOCAL inside each txn; don't let postgres-js auto-prepare
      // statements across connections (the SET LOCAL won't carry).
    });
  }
  return txPool;
}

export function getListenerPool(): Sql {
  if (!listenerPool) {
    listenerPool = postgres(suUrl(), {
      ...suPoolConnectionOptions('su-lock-listener'),
      max: 20, // Cap on concurrent workspace listeners — audit reviewer #3
      // LISTEN connections are idle BY DESIGN (they hold a subscription and do nothing
      // between notifications), so they must NEVER be reaped for idleness — closing one
      // silently drops the subscription. Declared explicitly rather than relying on
      // postgres-js's 0 default, so the choice is visible and the guard test can see it.
      idle_timeout: 0,
      prepare: false,
    });
  }
  return listenerPool;
}

/**
 * EI-19404227117727730: force-recreate the listener pool's underlying
 * connection — the escape hatch `workspace-listener.ts` reaches for when a
 * LISTEN/UNLISTEN operation on it times out.
 *
 * postgres-js multiplexes ALL `sql.listen()`/`unlisten()` calls for a pool
 * through ONE dedicated internal connection (`listen.sql`, memoized per `Sql`
 * instance — see `node_modules/postgres/src/index.js`'s `listen()`), and that
 * connection's `listen.channels` bookkeeping is entirely in-process: if the
 * connection dies WITHOUT postgres-js detecting the close (a silent
 * pgbouncer/network drop rather than a clean FIN — this box's su-lock-tx pool
 * has independently confirmed "pooler error: server conn crashed?" drops, see
 * the `withConnectionRetry` doc comment in `agent-tools/db/migrate.ts`), every
 * future `listen()`/`unlisten()` call for ANY channel on that pool queues
 * behind the same dead promise and hangs forever — no error, no timeout, no
 * PG-visible activity, because the command never reaches the server. Ending
 * the pool and nulling the singleton is the only way back: the next
 * `getListenerPool()` call builds a fresh `Postgres(...)` instance, which
 * means a fresh closure-scoped `listen` function (and therefore fresh,
 * unpoisoned `listen.channels`/`listen.sql` state — these are per-instance,
 * not module-global).
 *
 * `.end({ timeout: 1 })` cannot itself re-introduce the hang this exists to
 * clear: postgres-js forcibly destroys the socket after 1s if it won't close
 * cleanly, and any rejection is swallowed (fire-and-forget) — the caller only
 * needs the singleton nulled out, not the old connection's teardown awaited.
 */
export function resetListenerPoolAfterTimeout(): void {
  const stale = listenerPool;
  listenerPool = null;
  if (stale) void stale.end({ timeout: 1 }).catch(() => {});
}

/**
 * Test-only — close pools and reset state. Used by vitest hooks to
 * recycle the connection set between disposable PG instances.
 */
export async function _resetForTests(): Promise<void> {
  // The background-janitor timer lives in workspace-listener.ts now
  // (file-locking #4); its test teardown is _resetListenersForTests().
  //
  // Detach the memos SYNCHRONOUSLY before draining: callers fire this
  // without awaiting (sync beforeAll helpers), and nulling only after
  // `await end()` leaves a window where getTxPool() hands out a pool
  // that is mid-shutdown — every query on it then dies CONNECTION_ENDED
  // (seen live in su-locks-omp.integration.test.ts).
  const oldTxPool = txPool;
  const oldListenerPool = listenerPool;
  txPool = null;
  listenerPool = null;
  bootstrapped = false;
  if (oldTxPool) await oldTxPool.end({ timeout: 1 });
  if (oldListenerPool) await oldListenerPool.end({ timeout: 1 });
}

// ───────── Bootstrap + migrations ─────────

// The package OWNS its migrations: `sql/` normally lives adjacent to this
// module at `packages/locks/src/sql/`. A server bundle copies those files next
// to the generated host module, so that adjacent directory remains the primary
// source in both src-as-entry and bundled execution.
//
// EI-20511768945438743: a failed release swap can roll the source checkout back
// while leaving the already-running process's generated `dist-host/` directory
// absent. If locks are imported lazily after that swap, import.meta.url still
// points at the now-missing bundle and the first locks:* call used to crash on
// readdirSync(dist-host/sql), even though the release checkout's canonical lock
// sources were intact. Walk ancestors for that canonical source tree as a
// recovery source; do not use process.cwd(), which belongs to the embedding app
// and is not a stable package locator.
export function resolveLocksSqlDir(moduleDir: string): string {
  const adjacent = path.join(moduleDir, 'sql');
  if (fs.existsSync(adjacent)) return adjacent;

  let ancestor = moduleDir;
  for (;;) {
    const source = path.join(
      ancestor,
      'libs',
      'papercusp',
      'packages',
      'locks',
      'src',
      'sql',
    );
    if (fs.existsSync(source)) return source;

    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  // Preserve the historical error location when neither supported layout is
  // present; readdirSync below then fails loudly instead of silently skipping
  // unapplied lock migrations.
  return adjacent;
}

const SQL_DIR = resolveLocksSqlDir(
  path.dirname(fileURLToPath(import.meta.url)),
);

/**
 * Ensures `papercusp_su` exists and migrations are applied. Idempotent.
 * Called lazily on the first locks:* invocation per process.
 *
 * Steps:
 *   1. Probe `papercusp_su` existence via the main db. If missing, run
 *      `001-bootstrap.sql` (CREATE DATABASE — outside any txn).
 *   2. Connect to papercusp_su; take SHARE UPDATE EXCLUSIVE on su_meta
 *      (creating it first if needed); apply every NNN-*.sql whose
 *      number isn't in su_meta yet.
 *   3. Stamp the schema_version key in su_meta.
 */
export async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;

  // Step 1: probe the side db, create if absent.
  const main = postgres(mainUrl(), { max: 1, prepare: false });
  try {
    const rows = await main<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM pg_database WHERE datname = 'papercusp_su'
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      // CREATE DATABASE can't run inside any transaction. postgres-js
      // wraps `.unsafe()` in an implicit txn by default; `.simple()`
      // disables that. We also split the bootstrap into separate calls
      // because PG won't accept other statements in the same simple
      // batch as CREATE DATABASE (each must stand alone).
      await main.unsafe('CREATE DATABASE papercusp_su').simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET idle_in_transaction_session_timeout = '30s'",
      ).simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET application_name = 'papercusp-su'",
      ).simple();
    }
  } finally {
    await main.end({ timeout: 1 });
  }

  // Step 2 + 3: connect to papercusp_su and apply migrations.
  const sql = getTxPool();

  // su_meta must exist before we can take SHARE UPDATE EXCLUSIVE on it.
  // Bootstrap it outside the lock — CREATE TABLE IF NOT EXISTS is safe
  // concurrently (the loser just no-ops).
  await sql`
    CREATE TABLE IF NOT EXISTS su_meta (
      key   text PRIMARY KEY,
      value text NOT NULL
    )
  `;

  // Now serialize the migration runner across processes.
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE MODE`;

    const appliedRows = await tx<Array<{ key: string }>>`
      SELECT key FROM su_meta WHERE key LIKE 'migration:%'
    `;
    const applied = new Set(appliedRows.map((r) => r.key));

    const files = fs
      .readdirSync(SQL_DIR)
      .filter((f) => /^\d{3}-.*\.sql$/.test(f))
      .filter((f) => !f.endsWith('-bootstrap.sql'))
      .sort();

    for (const file of files) {
      const key = `migration:${file}`;
      if (applied.has(key)) continue;

      const sqlText = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      // postgres-js `unsafe` runs as a single multi-statement script.
      // We're inside a txn so any failure rolls back the whole file.
      await tx.unsafe(sqlText);

      await tx`
        INSERT INTO su_meta (key, value) VALUES (${key}, ${new Date().toISOString()})
        ON CONFLICT (key) DO NOTHING
      `;
    }
  });

  bootstrapped = true;
  // The background expiry sweep (file-locking #4) is armed by
  // inWorkspaceTxn on the first mutating locks:* op — its timer lives
  // in workspace-listener.ts, the module that owns the locks
  // subsystem's long-lived background state.
}

// ───────── Path validation (app-side; trigger is belt-and-suspenders) ─────────

// Path validation + canonicalization moved to ./path-normalize.ts
// (file-locking #2 follow-up — one named module owns the rules).
// Re-exported here so existing `from '../su-lock-store'` importers
// keep resolving.
export {
  InvalidPathError,
  MAX_PATH_LEN,
  validatePath,
  canonicalizePath,
  normalizePaths,
} from './path-normalize';

// ───────── Janitor — expiry sweep ─────────

/**
 * Workspace-scoped expiry sweep: delete this workspace's expired lock
 * rows and flip its orphaned 'waiting' waiters (wait_until elapsed, the
 * agent crashed mid-wait) to 'expired'. Returns true if anything moved,
 * so the caller can decide whether to run grant_cascade.
 *
 * file-locking #4: replaces the former global janitor, which ran a
 * DELETE across EVERY workspace on every acquire/release/heartbeat
 * call. That global scan now lives only in the 30s background janitor
 * (runBackgroundJanitorOnce); the per-call hot path sweeps just the
 * workspace (or paths) it actually touches.
 *
 * Timeout-agnostic: inherits the caller's SET LOCAL statement_timeout.
 */
export async function sweepWorkspaceExpired(
  tx: Sql,
  coordinationDomain: string,
): Promise<boolean> {
  const expiredLocks = await tx<Array<{ path: string }>>`
    DELETE FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING path
  `;
  // Orphaned 'waiting' waiters whose wait_until has passed but no one
  // marked them expired (bug #19). The head-waiter check now filters
  // waiters by wait_until so a stale row no longer BLOCKS acquires,
  // but it still must be cleaned up here / by the background janitor.
  const orphanWaiters = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE coordination_domain = ${coordinationDomain}
       AND status = 'waiting'
       AND wait_until <= clock_timestamp()
    RETURNING ticket_id
  `;
  return expiredLocks.length > 0 || orphanWaiters.length > 0;
}

/**
 * Path-narrow expiry sweep for the acquire hot path (file-locking #4).
 * Sweeps ONLY the rows touching the paths this acquire is contending —
 * an index-perfect (coordination_domain, path) delete. The orphaned-waiter
 * flip is likewise restricted to waiters whose path set overlaps
 * `paths`.
 *
 * Expired rows on paths NOT in this set are intentionally left for the
 * background janitor — they cannot affect this acquire's outcome (the
 * upsert steals expired rows on the requested paths; the head-waiter
 * check filters dead waiters by wait_until).
 *
 * Timeout-agnostic: inherits the caller's SET LOCAL statement_timeout.
 */
export async function sweepPathsExpired(
  tx: Sql,
  coordinationDomain: string,
  paths: string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  const expiredLocks = await tx<Array<{ path: string }>>`
    DELETE FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND EXISTS (
         SELECT 1
           FROM unnest(${paths}::text[]) AS requested(path)
          WHERE lock_path_overlaps(agent_file_locks.path, requested.path)
       )
       AND expires_ts <= clock_timestamp()
    RETURNING path
  `;
  const orphanWaiters = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE coordination_domain = ${coordinationDomain}
       AND status = 'waiting'
       AND wait_until <= clock_timestamp()
       AND lock_paths_overlap(paths, ${paths}::text[])
    RETURNING ticket_id
  `;
  return expiredLocks.length > 0 || orphanWaiters.length > 0;
}

/**
 * Reactive nudge: sweep this workspace's expired locks + orphaned
 * waiters and run the cascade if anything moved.
 *
 * Used by the wait loop on each ceiling tick so a waiter on a path
 * whose holder lapsed (TTL expiry, no explicit release) doesn't sit
 * idle forever. Workspace-scoped (file-locking #4) — it sweeps only
 * the caller's own workspace; other workspaces are reached by their
 * own pokes and the background janitor.
 *
 * Cheap: runs inside inWorkspaceTxn; the sweep's DELETE/UPDATE are
 * bounded by partial indexes (typically 0 rows in the steady state).
 */
export async function pokeWorkspace(tx: Sql, coordinationDomain: string): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  const swept = await sweepWorkspaceExpired(tx, coordinationDomain);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }
}

// ───────── Background janitor (file-locking #4) ─────────
//
// The 30s timer that drives this lives in workspace-listener.ts — the
// module that owns the locks subsystem's long-lived background state —
// and is armed by inWorkspaceTxn on the first mutating op. The sweep
// WORK stays here: it is storage-layer logic (tx pool, the per-
// workspace advisory lock, sweepWorkspaceExpired). The janitor uses
// the tx pool, NOT the LISTEN connection — a postgres-js listen
// connection is dedicated to LISTEN and cannot run the sweep's
// transactions; the tx pool is borrowed transiently each pass.

/**
 * One background sweep pass:
 *   1. Discover workspaces carrying expired file/resource locks, queue
 *      tickets, or orphaned waiters (one index-bounded read).
 *   2. For each, take that workspace's advisory lock NON-blockingly
 *      (pg_try_advisory_xact_lock — if a tool txn already holds it,
 *      that txn sweeps+cascades itself, or we catch it next tick),
 *      sweep, and grant_cascade if anything moved. The advisory lock
 *      is required: grant_cascade's in-memory held-paths probe is only
 *      race-free under it.
 *   3. GC terminal waiter rows older than 24h (disjoint from every
 *      reader — readQueue's completed window is queued_ts > now-24h —
 *      so no advisory lock needed).
 *
 * One workspace failing never aborts the rest of the pass. Exported so
 * tests drive it directly (deterministic) instead of waiting on the
 * wall-clock interval.
 */
export async function runBackgroundJanitorOnce(): Promise<void> {
  await ensureBootstrap();
  const sql = getTxPool();

  const dirty = await sql<Array<{ coordination_domain: string }>>`
    SELECT coordination_domain FROM agent_file_locks
      WHERE expires_ts <= clock_timestamp()
    UNION
    SELECT coordination_domain FROM agent_lock_waiters
      WHERE status = 'waiting' AND wait_until <= clock_timestamp()
    UNION
    SELECT coordination_domain FROM agent_resource_locks
      WHERE expires_ts <= clock_timestamp()
    UNION
    SELECT coordination_domain FROM agent_resource_exclusive_queue
      WHERE expires_ts <= clock_timestamp()
    UNION
    SELECT coordination_domain FROM agent_resource_waiters
      WHERE expires_ts <= clock_timestamp()
  `;

  for (const { coordination_domain } of dirty) {
    try {
      await sql.begin(async (txn) => {
        const tx = txn as unknown as Sql;
        await tx`SET LOCAL statement_timeout = '2s'`;
        const got = await tx<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            ${SU_LOCKS_FEATURE_KEY}::int,
            hashtext(${'su:' + coordination_domain})
          ) AS locked
        `;
        if (!got[0]?.locked) return; // contended — handled elsewhere
        const swept = await sweepWorkspaceExpired(tx, coordination_domain);
        if (swept) {
          await tx`SELECT grant_cascade(${coordination_domain}, clock_timestamp())`;
        }
        const resourceSwept = await sweepResourceExpired(tx, coordination_domain);
        await sweepResourceWaitersExpired(tx, coordination_domain);
        if (resourceSwept) {
          await tx`SELECT resource_grant_cascade(${coordination_domain}, clock_timestamp())`;
        }
      });
    } catch (err) {
      console.error(
        `[su-locks] background janitor: workspace ${coordination_domain} sweep failed`,
        err,
      );
    }
  }

  try {
    await sql.begin(async (txn) => {
      const tx = txn as unknown as Sql;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`
        DELETE FROM agent_lock_waiters
         WHERE status IN ('granted','expired','cancelled')
           AND queued_ts < clock_timestamp() - interval '24 hours'
      `;
    });
  } catch (err) {
    console.error('[su-locks] background janitor: terminal-waiter GC failed', err);
  }
}

// ───────── Acquire (no wait) ─────────

export interface AcquireParams {
  coordinationDomain: string;
  owner: string;
  /** Diagnostic label for the holder. `null` when the caller has no
   *  label (e.g. the FileClaimCoordinator adapter) — the owner_label
   *  column is nullable. */
  ownerLabel: string | null;
  paths: string[]; // already normalized
  intent: string;
  ttlSec: number;
  /** Durable work-item/plan goal associated with this lock, when known. */
  goalRef?: string | null;
  /** Automatic guards must not refresh or release paths held by a
   * deliberate same-owner claim. */
  automatic?: boolean;
}

export interface AcquireBusy {
  path: string;
  /** Canonical owner id of the holder (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: Date;
}

/** A failed acquire whose state changed during the final write. Callers must
 * retry the acquire from scratch; `busy` is only a best-effort snapshot and
 * may legitimately be empty because the competing row can disappear before
 * the snapshot is read. */
export type AcquireRetryReason = 'upsert_race';

export type AcquireResult =
  | {
      ok: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
      /** Paths this acquire added to the caller's existing lock set. A
       * same-owner refresh may return fewer paths here: automatic edit
       * guards must release only what they acquired, never a deliberate
       * lock that happened to cover the same path. */
      newly_held: string[];
    }
  | {
      ok: false;
      busy: AcquireBusy[];
    }
  | {
      ok: false;
      busy: AcquireBusy[];
      reason: 'queued_waiter';
    }
  | {
      ok: false;
      busy: AcquireBusy[];
      reason: AcquireRetryReason;
      retryable: true;
    };

/**
 * Atomic multi-path acquire. Inside the calling `inWorkspaceTxn`.
 *
 * Strategy:
 *   1. Head-waiter check — if any older waiter overlaps our paths, return
 *      `queued_waiter` with a fresh snapshot of active holders. Waiter rows are
 *      queue positions, not held locks, and must never enter `busy`.
 *   2. Upsert all paths (or only new paths for an automatic guard that
 *      overlaps a deliberate same-owner claim); ON CONFLICT only overwrites
 *      expired rows.
 *   3. Verify our lock_id won every path. Mismatch → busy.
 *
 * Per audit 4 #1: success path short-circuits the busy SELECT.
 */
export async function tryAcquire(
  tx: Sql,
  params: AcquireParams,
): Promise<AcquireResult> {
  const { coordinationDomain, owner, ownerLabel, paths, intent, ttlSec } = params;
  const goalRef = params.goalRef ?? null;
  const automatic = params.automatic ?? intent.startsWith('PreToolUse:');

  if (paths.length === 0) {
    return {
      ok: true,
      lock_id: crypto.randomUUID(),
      expires_ts: new Date(),
      held: [],
      newly_held: [],
    };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Step 1: path-narrow expiry sweep (file-locking #4). Only the rows
  // touching the paths THIS acquire contends — an index-perfect
  // (coordination_domain, path) delete, not the former global cross-workspace
  // scan. Fire the cascade if the sweep freed anything so a waiter
  // blocked solely behind a now-swept expired lock wakes immediately
  // rather than on the next background tick. Expired rows on other
  // paths are left for the background janitor — they cannot affect
  // this acquire's outcome.
  const swept = await sweepPathsExpired(tx, coordinationDomain, paths);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }

  // Step 2: head-waiter check.
  // Skip paths the calling owner already holds — a same-owner refresh
  // shouldn't be blocked by a waiter queued behind that owner. Subtract
  // the owner's currently-held paths from the set we head-waiter-check.
  const ownedRows = await tx<Array<{ path: string; lock_id: string; expires_ts: Date }>>`
    SELECT path, lock_id::text AS lock_id, expires_ts FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND owner = ${owner}
       AND EXISTS (
         SELECT 1
           FROM unnest(${paths}::text[]) AS requested(path)
          WHERE lock_path_overlaps(agent_file_locks.path, requested.path)
       )
       AND expires_ts > clock_timestamp()
  `;
  const ownedSet = new Set(ownedRows.map((r) => r.path));
  const newPaths = paths.filter((p) => !ownedSet.has(p));
  // A hook/guard that is entirely covered by a deliberate same-owner claim
  // is already authorized. Do not refresh that claim's TTL/intent: doing so
  // would make the short automatic lease replace the deliberate one, and a
  // matching post-hook release could then dissolve the deliberate hold.
  if (automatic && ownedRows.length > 0 && newPaths.length === 0) {
    const expiresTs = ownedRows.reduce(
      (earliest, row) => row.expires_ts < earliest ? row.expires_ts : earliest,
      ownedRows[0].expires_ts,
    );
    return {
      ok: true,
      lock_id: ownedRows[0].lock_id,
      expires_ts: expiresTs,
      held: paths,
      newly_held: [],
    };
  }
  // If the owner already holds at least one of the requested paths,
  // reuse that lock_id for the new path inserts so the entire returned
  // set shares ONE lock_id. Otherwise mixed lock_ids would mean
  // release(lock_id) only frees a subset.
  const existingLockIds = Array.from(new Set(ownedRows.map((r) => r.lock_id)));
  // If owner happens to hold multiple existing lock_ids on the
  // requested paths (acquired via separate calls), we can't unify
  // them in one upsert — pick the first and document the constraint
  // for callers.
  const reusableLockId = existingLockIds[0];
  // If every requested path is already owned by us, skip the head-waiter
  // check entirely — pure refresh.
  const queuedWaiters = newPaths.length === 0
    ? []
    : await tx<AcquireBusy[]>`
        SELECT waiting.path, w.owner, w.owner_label, w.intent,
               w.wait_until AS expires_ts
          FROM agent_lock_waiters w
          CROSS JOIN LATERAL unnest(w.paths) AS waiting(path)
         WHERE w.coordination_domain = ${coordinationDomain}
           AND w.status = 'waiting'
           -- A waiter whose wait_until has elapsed is effectively dead
           -- (crashed agent / timed-out wait) and must not block a new
           -- acquire even if the janitor hasn't swept it yet
           -- (file-locking #4 — robust regardless of sweep timing).
           AND w.wait_until > clock_timestamp()
           AND EXISTS (
             SELECT 1 FROM unnest(${newPaths}::text[]) AS requested(path)
              WHERE lock_path_overlaps(waiting.path, requested.path)
           )
           AND w.queued_ts < clock_timestamp()
         ORDER BY w.queued_ts ASC, w.ticket_id ASC
         LIMIT 50
      `;
  if (queuedWaiters.length > 0) {
    // Keep FIFO: an earlier waiter still prevents this acquire from winning.
    // But `busy` is the active agent_file_locks snapshot consumed by holder
    // enrichment and lock-wait briefs. Returning queue rows here made a
    // caller's own earlier ticket look like a live holder and used wait_until
    // as that holder's lease expiry, hiding the actual lock owner.
    const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
    return { ok: false, busy, reason: 'queued_waiter' };
  }

  // Step 2b: pre-check that every NEW path (not already ours) is
  // either free or expired. Otherwise an upsert that partially fails
  // would still refresh our existing rows as a side effect (extending
  // their TTL and clobbering their intent). We deliberately mutate
  // ONLY on full success.
  if (newPaths.length > 0) {
    const blockedRows = await tx<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND EXISTS (
           SELECT 1
             FROM unnest(${newPaths}::text[]) AS requested(path)
            WHERE lock_path_overlaps(agent_file_locks.path, requested.path)
         )
         AND expires_ts > clock_timestamp()
         AND owner != ${owner}
    `;
    if (blockedRows.length > 0) {
      const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
      return { ok: false, busy };
    }
  }

  // Step 3: atomic upsert. Deliberate re-acquires reuse an existing lock_id
  // so the returned handle covers every row this call creates or refreshes.
  // Automatic guards that overlap an existing same-owner claim use a fresh
  // id for new paths only; this keeps deliberate rows untouched and lets the
  // guard release its own paths without dissolving that claim.
  const lockId = automatic && ownedRows.length > 0
    ? crypto.randomUUID()
    : reusableLockId ?? crypto.randomUUID();
  const acquirePaths = automatic && ownedRows.length > 0 ? newPaths : paths;
  const ttlText = `${ttlSec} seconds`;

  // Step 2b above already excludes the "another live owner holds one
  // of our paths" case, so by the time we reach the upsert every path in
  // acquirePaths is either free or already-ours. The ON CONFLICT branch refreshes
  // OUR rows (or steals expired ones); the INSERT branch covers the
  // never-existed rows. The upsert takes every path in that selected set
  // — file-locking #6 removes the former `(xmax = 0) AS is_new`
  // partial-rollback machinery that became dead code when Step 2b
  // landed. (xmax is PG-internal and not part of the documented
  // stable API; the new shape avoids depending on it.)
  const upserted = await tx<Array<{ path: string; lock_id: string }>>`
    WITH wanted AS (SELECT unnest(${acquirePaths}::text[]) AS path)
    INSERT INTO agent_file_locks
      (coordination_domain, path, owner, owner_label, intent, goal_ref, lock_id, acquired_ts, expires_ts)
    SELECT
      ${coordinationDomain}, w.path, ${owner}, ${ownerLabel}, ${intent}, ${goalRef},
      ${lockId}::uuid, clock_timestamp(), clock_timestamp() + ${ttlText}::interval
    FROM wanted w
    ON CONFLICT (coordination_domain, path) DO UPDATE
      SET owner       = EXCLUDED.owner,
          owner_label = EXCLUDED.owner_label,
          intent      = EXCLUDED.intent,
          lock_id     = EXCLUDED.lock_id,
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
      -- Refresh on two conditions:
      --   1. Expired locks (anyone can steal a stale row).
      --   2. Same-owner re-acquire (consecutive edits to the same
      --      file must not lock the agent out of itself).
      WHERE agent_file_locks.expires_ts <= clock_timestamp()
         OR agent_file_locks.owner = EXCLUDED.owner
    RETURNING path, lock_id
  `;

  // Defense in depth: if the upsert returned fewer rows than requested
  // a race slipped past Step 2b (e.g. another tx inserted between our
  // pre-check and the upsert). This is not ordinary holder contention:
  // the competing row may disappear before the snapshot below, leaving
  // busy=[] even though this acquire did not win. Mark it explicitly so
  // callers retry from scratch instead of rendering an unexplained denial
  // or queueing behind a holder that is no longer confirmed.
  if (upserted.length !== acquirePaths.length) {
    const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
    return { ok: false, busy, reason: 'upsert_race', retryable: true };
  }

  const effectiveLockId = upserted[0].lock_id;
  return {
    ok: true,
    lock_id: effectiveLockId,
    expires_ts: new Date(Date.now() + ttlSec * 1000),
    held: paths,
    newly_held: newPaths,
  };
}

async function readBusySnapshot(
  tx: Sql,
  coordinationDomain: string,
  paths: string[],
  excludeOwner?: string,
): Promise<AcquireBusy[]> {
  const ownerFilter = excludeOwner
    ? tx`AND owner != ${excludeOwner}`
    : tx``;
  const rows = await tx<
    Array<{
      path: string;
      owner: string;
      owner_label: string | null;
      intent: string;
      expires_ts: Date;
    }>
  >`
    SELECT path, owner, owner_label, intent, expires_ts
      FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND EXISTS (
         SELECT 1
           FROM unnest(${paths}::text[]) AS requested(path)
          WHERE lock_path_overlaps(agent_file_locks.path, requested.path)
       )
       AND expires_ts > clock_timestamp()
       ${ownerFilter}
  `;
  return rows;
}

// ───────── Release ─────────

export interface ReleaseParams {
  coordinationDomain: string;
  owner: string;
  lockId?: string;
  /** Omit to read every path; an explicit empty array intentionally matches no paths. */
  paths?: string[];
  allMine?: boolean;
}

export async function tryRelease(
  tx: Sql,
  params: ReleaseParams,
): Promise<{ released: string[]; heldBefore: number }> {
  const { coordinationDomain, owner, lockId, paths, allMine } = params;

  await tx`SET LOCAL statement_timeout = '5s'`;

  // Sweep this workspace's expired locks + orphaned waiters so the
  // cascade below works from clean state. Release fires its own
  // unconditional cascade at the end of the function, so we ignore the
  // swept flag here (a janitor-driven cascade would be redundant).
  await sweepWorkspaceExpired(tx, coordinationDomain);

  /**
   * EI-20405390083792304: how many live locks this owner held in this domain
   * at release time — counted AFTER the expiry sweep (so an expired row is
   * never counted as held) and BEFORE the DELETE below.
   *
   * WHY THIS EXISTS: `released: []` is produced by two situations that mean
   * OPPOSITE things, and the caller could not tell them apart:
   *   (a) the owner held nothing here    → the release is a correct no-op;
   *   (b) the owner held locks but the selector matched none of them
   *       (wrong lock_id, wrong paths filter, or — the incident that filed
   *       this — a coordination domain that is not the one holding the lock)
   *       → the release SILENTLY did nothing while reporting ok:true.
   * Reporting an unqualified success for (b) is how an agent tells a blocked
   * peer "you're unblocked" while still holding the lock. `heldBefore`
   * separates them: 0 ⇒ (a); >0 with an empty `released` ⇒ (b).
   */
  const heldBeforeRows = await tx<Array<{ held: number }>>`
    SELECT count(*)::int AS held
      FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND owner = ${owner}
  `;
  const heldBefore = heldBeforeRows[0]?.held ?? 0;

  let released: Array<{ path: string }>;

  if (allMine) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND owner = ${owner}
      RETURNING path
    `;
  } else if (lockId && paths && paths.length > 0) {
    // Owner check (bug #16): lock_id alone is unguessable but it's
    // persisted in tool_invocations.result_json (audit:read can read
    // it). Require owner match so a leaked lock_id can't be used by
    // another agent to release someone else's lock.
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
         AND path = ANY(${paths}::text[])
      RETURNING path
    `;
  } else if (lockId) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
      RETURNING path
    `;
  } else {
    throw new Error('locks:release requires lock_id or all_mine');
  }

  // Run the cascade. NOTIFY fires inside; we don't need the result set.
  await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;

  return { released: released.map((r) => r.path), heldBefore };
}

// ───────── Heartbeat ─────────

export interface HeartbeatResult {
  expires_ts: Date | null;
  extended: boolean;
}

export async function tryHeartbeat(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
  lockId: string,
  ttlSec: number,
): Promise<HeartbeatResult> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Sweep this workspace's expired rows; fire the cascade if anything
  // was freed (a waiter behind a now-swept lock should wake).
  const swept = await sweepWorkspaceExpired(tx, coordinationDomain);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }
  const ttlText = `${ttlSec} seconds`;
  // Owner check (bug #17): like release, require owner match so a
  // leaked lock_id can't be used to extend someone else's TTL.
  const rows = await tx<Array<{ expires_ts: Date }>>`
    UPDATE agent_file_locks
       SET expires_ts = clock_timestamp() + ${ttlText}::interval
     WHERE coordination_domain = ${coordinationDomain}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
     RETURNING expires_ts
  `;
  if (rows.length === 0) return { expires_ts: null, extended: false };
  return { expires_ts: rows[0].expires_ts, extended: true };
}

// ───────── Queue (read-only — no advisory lock) ─────────

export interface QueueParams {
  /**
   * The lock namespace to read.
   *
   * `null` reads across **every** domain — for DIAGNOSTIC readers only (WI-5979).
   * A domain is the realpath of the repo root of whichever process resolved it
   * (`lockCoordinationDomain()` keys off `import.meta.url`), so a reader running
   * from a DIFFERENT checkout than the acquirer matches zero rows and reports a
   * genuinely-held lock as absent — silently, since an empty result is not an
   * error. That is correct for the ENFORCEMENT path (two checkouts are two
   * different files and must not serialize against each other) but wrong for any
   * "what is this agent holding?" read, where `owner` is already globally unique.
   * Every row carries `coordination_domain` so a cross-domain read can still
   * attribute blockers WITHIN a domain and never across one.
   */
  coordinationDomain: string | null;
  paths?: string[];
  owner?: string;
  includeCompleted?: boolean;
  /** Skip the pending-waiter query when a caller only needs held locks. */
  includeWaiting?: boolean;
}

export interface ActiveLockRow {
  /** The release handle returned by locks:acquire for this held lock set. */
  lock_id: string;
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  /** Durable work-item/plan goal associated with this lock, when known. */
  goal_ref: string | null;
  acquired_ts: Date;
  expires_ts: Date;
  /** The lock namespace this row lives in — see {@link QueueParams.coordinationDomain}. */
  coordination_domain: string;
}

export interface WaiterRow {
  ticket_id: string;
  owner: string;
  owner_label: string | null;
  paths: string[];
  intent: string;
  /** Durable work-item/plan goal associated with this waiter, when known. */
  goal_ref: string | null;
  queued_ts: Date;
  wait_until: Date;
  status: 'waiting' | 'granted' | 'expired' | 'cancelled';
  ahead_count?: number;
  /** Latest expiry among live, overlapping locks held by another owner. */
  holder_expires_ts?: Date | null;
  /**
   * True when this ticket's deadline precedes the current holder window. The
   * ticket remains queued because its holder may release early, but it cannot
   * be granted before expiry on the observed state.
   */
  cannot_be_granted_before_expiry?: boolean;
  /** The lock namespace this row lives in — see {@link QueueParams.coordinationDomain}. */
  coordination_domain: string;
}

export interface QueueResult {
  active_locks: ActiveLockRow[];
  waiting: WaiterRow[];
  completed?: WaiterRow[];
}

export async function readQueue(
  sqlIn: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  // Wrap in a transaction so SET LOCAL statement_timeout is scoped to
  // this read (plan §6.1: queue = 1000ms). Without a transaction,
  // SET LOCAL is a no-op; SET (without LOCAL) would leak across the
  // pool. The transaction is read-only — no advisory lock needed.
  return sqlIn.begin(async (sql) => {
    await sql`SET LOCAL statement_timeout = '1s'`;
    return readQueueInner(sql as unknown as Sql, params);
  }) as Promise<QueueResult>;
}

/** One owner's live interest in one path — held OR intended. Shaped for the
 * coordination coupling path. Holds-only reads also carry the optional
 * authoritative lock metadata used by coord:presence's include_detail lane;
 * waiter rows do not have a lock id and therefore leave those fields absent. */
export interface PathInterestRow {
  owner: string;
  node: string;
  /** The release handle, present only for an active held-lock row. */
  lock_id?: string;
  /** The lock namespace, present only for an active held-lock row. */
  coordination_domain?: string;
  /** The authoritative lease expiry, present only for an active held-lock row. */
  expires_ts?: Date;
}

/**
 * Every LIVE PATH INTEREST per owner — held locks UNION in-flight waiter tickets —
 * for a bounded owner set, across coordination domains by default.
 *
 * ⚠ THIS EXISTS BECAUSE THE OBVIOUS QUERY IS STRUCTURALLY INCAPABLE OF ITS JOB.
 * Its consumer is the `holds-a-lock-on` coupling derivation, which emits an edge
 * when two agents are interested in the SAME path. Reading only `agent_file_locks`
 * can never satisfy that predicate: `agent_file_locks_pkey` is
 * `PRIMARY KEY (coordination_domain, path)`, so at most ONE owner exists per path.
 * A mutual-exclusion table records who WON contention; it cannot record that
 * contention happened. The derivation therefore read as a clean, error-free,
 * permanently-empty signal — which is why it went unnoticed for weeks
 * (EI-20199756190949760, the third dead-source instance in that feature).
 *
 * The contention IS recorded, in `agent_lock_waiters`, whose `paths text[]` can
 * hold two owners against one path. Measured over the retained window at the time
 * this landed: 56 time-overlapping owner pairs across 4 paths, and a minute-by-minute
 * replay had this predicate non-empty for 119 of 311 minutes (38.3%), against the
 * old predicate's structural 0%.
 *
 * ⚠ GATE TICKETS ON `wait_until`, NEVER ON `status`. `status` is TRANSIENT — a
 * ticket passes through `waiting` and settles into granted/expired/cancelled within
 * seconds, so `status = 'waiting'` reads empty essentially always. Measured on the
 * live table: granted 20, expired 4, cancelled 3, **waiting 0** — filtering on it
 * would have reproduced the very defect this function exists to remove. The ticket's
 * `[queued_ts, wait_until)` interval is the honest intent window, and a settled
 * ticket inside its window still means "this agent is working these paths".
 *
 * NEVER WIDENS: the caller passes `owners` already bounded to its own roster, and
 * the coupling derivation intersects against that roster again before emitting.
 * `coordinationDomain` is a PARTITION key here, not an access control — and passing
 * one is usually WRONG for coupling: agents write locks under the proxying
 * operator's checkout while a reader resolves its own tree, so a domain-filtered
 * read returns zero by construction. Default `null` = every domain (the WI-5979
 * diagnostic-read convention).
 */
export async function readPathInterestsByOwner(
  sql: Sql,
  owners: readonly string[],
  opts?: {
    coordinationDomain?: string | null | undefined;
    /**
     * Include in-flight waiter tickets (intended paths), not just held locks.
     * DEFAULT true — it is what makes the co-interest predicate satisfiable.
     * Pass false for the `include_detail` heldFiles lane, which answers the
     * narrower question "what does this agent HOLD right now" and would be
     * actively misleading if it reported paths the agent is merely queued for.
     */
    includeIntents?: boolean | undefined;
  },
): Promise<PathInterestRow[]> {
  if (owners.length === 0) return [];
  const ownerList = [...owners];
  const domain = opts?.coordinationDomain ?? null;
  const heldDomain = domain === null ? sql`TRUE` : sql`coordination_domain = ${domain}`;
  // Build the holds-only template ONLY when it is the one being returned: a
  // postgres.js tagged template is a live Query object, so constructing the unused
  // branch would risk issuing a second, pointless round-trip against the lock DB.
  if (opts?.includeIntents === false) {
    return sql<PathInterestRow[]>`
      SELECT owner, path AS node, lock_id::text AS lock_id, coordination_domain, expires_ts
        FROM agent_file_locks
       WHERE ${heldDomain}
         AND expires_ts > clock_timestamp()
         AND owner = ANY(${ownerList}::text[])
    `;
  }
  const waitDomain = domain === null ? sql`TRUE` : sql`coordination_domain = ${domain}`;
  return sql<PathInterestRow[]>`
    SELECT owner, path AS node
      FROM agent_file_locks
     WHERE ${heldDomain}
       AND expires_ts > clock_timestamp()
       AND owner = ANY(${ownerList}::text[])
    UNION
    SELECT w.owner, p AS node
      FROM agent_lock_waiters w, LATERAL unnest(w.paths) AS p
     WHERE ${waitDomain}
       AND w.wait_until > clock_timestamp()
       AND w.owner = ANY(${ownerList}::text[])
  `;
}

async function readQueueInner(
  sql: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  const { coordinationDomain, paths, owner, includeCompleted, includeWaiting = true } = params;

  // `undefined` means "no filter"; an explicit [] means the caller requested no
  // paths and must fail closed. Treating both as the same is a dangerous broadening
  // for diagnostic callers that build an optional path list programmatically.
  const lockFilter = paths === undefined
    ? sql``
    : paths.length === 0
      ? sql`AND FALSE`
      : sql`AND EXISTS (
          SELECT 1
            FROM unnest(${paths}::text[]) AS requested(path)
           WHERE lock_path_overlaps(agent_file_locks.path, requested.path)
        )`;
  const ownerFilter = owner ? sql`AND owner = ${owner}` : sql``;
  // WI-5979: `null` = read every domain (diagnostic reads). `TRUE` rather than an
  // empty fragment so the surrounding `WHERE ... AND` chain stays well-formed.
  const domainFilter = coordinationDomain === null
    ? sql`TRUE`
    : sql`coordination_domain = ${coordinationDomain}`;

  const active = await sql<Array<ActiveLockRow>>`
    SELECT lock_id::text AS lock_id, path, owner, owner_label, intent, goal_ref, acquired_ts, expires_ts,
           coordination_domain
      FROM agent_file_locks
     WHERE ${domainFilter}
       AND expires_ts > clock_timestamp()
       ${lockFilter}
       ${ownerFilter}
     ORDER BY acquired_ts ASC
  `;

  const pathOverlap = paths === undefined
    ? sql``
    : paths.length === 0
      ? sql`AND FALSE`
      : sql`AND lock_paths_overlap(paths, ${paths}::text[])`;
  const waitingOwnerFilter = owner ? sql`AND w.owner = ${owner}` : sql``;
  const waitingDomainFilter = coordinationDomain === null
    ? sql`TRUE`
    : sql`w.coordination_domain = ${coordinationDomain}`;
  const waitingPathOverlap = paths === undefined
    ? sql``
    : paths.length === 0
      ? sql`AND FALSE`
      : sql`AND lock_paths_overlap(w.paths, ${paths}::text[])`;

  const waiting: Array<WaiterRow & { ahead_count: number }> = includeWaiting
    ? await sql<Array<WaiterRow & { ahead_count: number }>>`
    SELECT w.ticket_id, w.owner, w.owner_label, w.paths, w.intent, w.goal_ref,
           w.queued_ts, w.wait_until,
           w.status::text AS status,
           w.coordination_domain,
           holder.holder_expires_ts,
           (
             holder.holder_expires_ts IS NOT NULL
             AND w.wait_until < holder.holder_expires_ts
           ) AS cannot_be_granted_before_expiry,
           (ROW_NUMBER() OVER (PARTITION BY w.coordination_domain
                                   ORDER BY queued_ts ASC, ticket_id ASC) - 1)::int AS ahead_count
      FROM agent_lock_waiters w
      LEFT JOIN LATERAL (
        SELECT max(lock.expires_ts) AS holder_expires_ts
          FROM agent_file_locks lock
         WHERE lock.coordination_domain = w.coordination_domain
           AND lock.owner <> w.owner
           AND lock.expires_ts > clock_timestamp()
           AND EXISTS (
             SELECT 1
               FROM unnest(w.paths) AS requested(path)
              WHERE lock_path_overlaps(lock.path, requested.path)
           )
      ) AS holder ON TRUE
     WHERE ${waitingDomainFilter}
       AND w.status = 'waiting'
       ${waitingPathOverlap}
       ${waitingOwnerFilter}
     ORDER BY w.queued_ts ASC, w.ticket_id ASC
  `
    : [];

  const result: QueueResult = { active_locks: active, waiting };

  if (includeCompleted) {
    result.completed = await sql<Array<WaiterRow>>`
      SELECT ticket_id, owner, owner_label, paths, intent, goal_ref, queued_ts, wait_until,
             status::text AS status,
             coordination_domain
        FROM agent_lock_waiters
       WHERE ${domainFilter}
         AND status IN ('granted','expired','cancelled')
         AND queued_ts > clock_timestamp() - interval '24 hours'
         ${pathOverlap}
         ${ownerFilter}
       ORDER BY queued_ts DESC
       LIMIT 50
    `;
  }

  return result;
}

// ───────── Waiter insert (Phase 2 — wait path) ─────────

export const MAX_WAITERS_PER_OWNER = 10;

/** The concrete edit a blocked agent attaches to a wake_on_grant waiter ticket
 *  (EI-9033) — exactly the Edit-tool contract. On grant the bridge applies it
 *  mechanically iff `old_string` matches EXACTLY ONCE in the current file. */
export interface PendingEdit {
  /** Repo-relative POSIX path — MUST equal the ticket's single granted path. */
  file: string;
  old_string: string;
  new_string: string;
  /** Queue-time active work-item pointer used by delayed edit attribution. */
  goal_ref?: string;
}

export interface InsertWaiterParams {
  coordinationDomain: string;
  owner: string;
  ownerLabel: string;
  paths: string[];
  intent: string;
  ttlSec: number;
  maxWaitSec: number;
  /** Durable work-item/plan goal associated with this queued acquire. */
  goalRef?: string | null;
  /** Apply-on-grant (EI-9033): when set, the grant bridge applies this edit
   *  instead of waking the agent to retry. Only meaningful with wake_on_grant
   *  and a single-path ticket (`paths === [pendingEdit.file]`). */
  pendingEdit?: PendingEdit;
}

export type InsertWaiterResult =
  | { ok: true; ticket_id: string; wait_until: Date }
  // Self-grant — the path freed up between the caller's last
  // try-acquire and this insert call (race between busy-return and
  // INSERT). The waiter was NOT inserted; the caller already holds
  // the lock and should treat this like a direct acquire success.
  | {
      ok: true;
      self_granted: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
    }
  | { ok: false; reason: 'waiter_cap_exceeded' };

/**
 * Insert a row into agent_lock_waiters. Capped at MAX_WAITERS_PER_OWNER
 * per owner (per-workspace would let one runaway agent jam other
 * agents' queues; per-owner fails loudly for the misbehaving caller
 * only — reviewer #8).
 *
 * Before inserting, attempts a fresh acquire under the workspace
 * advisory lock. Closes the race between the caller's earlier
 * try-acquire-returning-busy and this INSERT — if the holder released
 * in that window, the cascade ran without our row, and our waiter
 * would sit idle on a now-free file.
 */
export async function tryInsertWaiter(
  tx: Sql,
  params: InsertWaiterParams,
): Promise<InsertWaiterResult> {
  // Self-grant attempt first.
  const acquired = await tryAcquire(tx, {
    coordinationDomain: params.coordinationDomain,
    owner: params.owner,
    ownerLabel: params.ownerLabel,
    paths: params.paths,
    intent: params.intent,
    ttlSec: params.ttlSec,
    goalRef: params.goalRef,
  });
  if (acquired.ok) {
    return {
      ok: true,
      self_granted: true,
      lock_id: acquired.lock_id,
      expires_ts: acquired.expires_ts,
      held: acquired.held,
    };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Per-owner cap. NOTE: this counts across all workspaces; runaway
  // loops anywhere stop the owner cold.
  const capRows = await tx<Array<{ at_cap: boolean }>>`
    SELECT count(*) >= ${MAX_WAITERS_PER_OWNER} AS at_cap
      FROM agent_lock_waiters
     WHERE owner = ${params.owner}
       AND status = 'waiting'
  `;
  if (capRows[0]?.at_cap) {
    return { ok: false, reason: 'waiter_cap_exceeded' };
  }

  const waitText = `${params.maxWaitSec} seconds`;
  // Keep the explicit text cast: postgres-js's default jsonb serializer
  // JSON.stringify()s string parameters, so casting an already-stringified
  // value directly to jsonb stores a JSON scalar string instead of the edit
  // object. The text cast preserves the serialized JSON as-is (and remains
  // correct when a drizzle wrapper has installed a transparent serializer).
  const pendingEditJson = params.pendingEdit ? JSON.stringify(params.pendingEdit) : null;
  const rows = await tx<Array<{ ticket_id: string; wait_until: Date }>>`
    INSERT INTO agent_lock_waiters
      (coordination_domain, owner, owner_label, paths, intent, goal_ref, ttl_sec, wait_until, pending_edit)
    VALUES
      (${params.coordinationDomain}, ${params.owner}, ${params.ownerLabel},
       ${params.paths}, ${params.intent}, ${params.goalRef ?? null}, ${params.ttlSec},
       clock_timestamp() + ${waitText}::interval,
       ${pendingEditJson}::text::jsonb)
    RETURNING ticket_id, wait_until
  `;
  return { ok: true, ticket_id: rows[0].ticket_id, wait_until: rows[0].wait_until };
}

// ───────── Apply-on-grant pending edit (EI-9033) ─────────

/** A granted ticket's claimed pending edit + the context needed to apply it. */
export interface GrantedPendingEdit {
  ticket_id: string;
  pending_edit: PendingEdit;
  granted_lock_id: string;
  coordination_domain: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  paths: string[];
}

/** Disposition of a granted ticket's pending edit, for a reconcile that did NOT
 *  win the apply latch: 'none' (never had one → normal grant wake), 'claiming'
 *  (a peer reconcile is applying → no-op), 'applied' (landed → no-op), or
 *  'fallback' (guardrail/mismatch → normal grant wake). */
export type PendingEditDisposition = 'none' | 'claiming' | 'applied' | 'fallback';

/**
 * Atomically claim a granted ticket's pending edit for application. The
 * conditional UPDATE latch (`pending_edit_status IS NULL` → 'claiming') makes
 * application EXACTLY-ONCE across the NOTIFY fast-path + the sweep backstop —
 * only the ONE caller whose UPDATE returns a row applies; every other observer
 * reads the disposition instead. Returns null when there is no UNCLAIMED
 * pending edit (none attached, already claimed, or the ticket isn't granted).
 */
export async function claimGrantedPendingEdit(
  sql: Sql,
  ticketId: string,
): Promise<GrantedPendingEdit | null> {
  const rows = await sql<
    Array<{
      ticket_id: string;
      pending_edit: PendingEdit | null;
      granted_lock_id: string | null;
      coordination_domain: string;
      owner: string;
      owner_label: string | null;
      intent: string;
      paths: string[];
    }>
  >`
    UPDATE agent_lock_waiters
       SET pending_edit_status = 'claiming'
     WHERE ticket_id = ${ticketId}::uuid
       AND status = 'granted'
       AND granted_lock_id IS NOT NULL
       AND pending_edit IS NOT NULL
       AND pending_edit_status IS NULL
    RETURNING ticket_id, pending_edit, granted_lock_id,
              coordination_domain, owner, owner_label, intent, paths
  `;
  const r = rows[0];
  if (!r || !r.pending_edit || !r.granted_lock_id) return null;
  return {
    ticket_id: r.ticket_id,
    pending_edit: r.pending_edit,
    granted_lock_id: r.granted_lock_id,
    coordination_domain: r.coordination_domain,
    owner: r.owner,
    owner_label: r.owner_label ?? null,
    intent: r.intent,
    paths: r.paths,
  };
}

/** Record the terminal outcome of a claimed pending edit (releases the latch). */
export async function setPendingEditOutcome(
  sql: Sql,
  ticketId: string,
  outcome: 'applied' | 'fallback',
): Promise<void> {
  await sql`
    UPDATE agent_lock_waiters
       SET pending_edit_status = ${outcome}
     WHERE ticket_id = ${ticketId}::uuid
  `;
}

/** Read a ticket's pending-edit disposition (for a reconcile that lost the
 *  latch). 'has pending edit but status NULL/claiming' → 'claiming' (in-flight). */
export async function readPendingEditDisposition(
  sql: Sql,
  ticketId: string,
): Promise<PendingEditDisposition> {
  const rows = await sql<Array<{ has: boolean; st: string | null }>>`
    SELECT pending_edit IS NOT NULL AS has, pending_edit_status AS st
      FROM agent_lock_waiters
     WHERE ticket_id = ${ticketId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0 || !rows[0].has) return 'none';
  const st = rows[0].st;
  if (st === 'applied') return 'applied';
  if (st === 'fallback') return 'fallback';
  return 'claiming';
}

// ───────── Waiter status read ─────────

export interface WaiterStatus {
  status: 'waiting' | 'granted' | 'released' | 'expired' | 'cancelled' | 'missing';
  granted_lock_id?: string;
  granted_expires_ts?: Date;
  paths?: string[];
}

export async function readWaiterStatus(
  sql: Sql,
  ticketId: string,
): Promise<WaiterStatus> {
  const rows = await sql<
    Array<{
      status: string;
      granted_lock_id: string | null;
      granted_expires_ts: Date | null;
      paths: string[];
      grant_is_live: boolean | null;
      grant_is_expired: boolean;
    }>
  >`
    SELECT w.status::text AS status, w.granted_lock_id, w.granted_expires_ts, w.paths,
           CASE
             WHEN w.status = 'granted' AND w.granted_lock_id IS NOT NULL THEN
               COALESCE(
                 w.granted_expires_ts > clock_timestamp()
                 AND cardinality(w.paths) > 0
                 AND cardinality(w.paths) = (
                   SELECT count(*)::int
                     FROM agent_file_locks l
                    WHERE l.coordination_domain = w.coordination_domain
                      AND l.owner = w.owner
                      AND l.lock_id = w.granted_lock_id
                      AND l.path = ANY(w.paths)
                      AND l.expires_ts > clock_timestamp()
                 ),
                 FALSE
               )
             ELSE NULL
           END AS grant_is_live,
           CASE
             WHEN w.status = 'granted' AND w.granted_lock_id IS NOT NULL
               THEN COALESCE(w.granted_expires_ts <= clock_timestamp(), FALSE)
             ELSE FALSE
           END AS grant_is_expired
      FROM agent_lock_waiters w
     WHERE w.ticket_id = ${ticketId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return { status: 'missing' };
  const r = rows[0];
  const status =
    r.status === 'granted' && r.grant_is_live === false
      ? r.grant_is_expired
        ? 'expired'
        : 'released'
      : (r.status as WaiterStatus['status']);
  return {
    status,
    granted_lock_id: r.granted_lock_id ?? undefined,
    granted_expires_ts: r.granted_expires_ts ?? undefined,
    paths: r.paths,
  };
}

/**
 * Force a waiter row to 'expired' if it's still 'waiting'. Used when
 * the wait timeout fires. Idempotent — no-op if already terminal.
 */
export async function expireWaiter(
  tx: Sql,
  ticketId: string,
): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await tx`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE ticket_id = ${ticketId}::uuid
       AND status = 'waiting'
  `;
}

// ───────── Cancel waiter ─────────

export async function tryCancelWait(
  tx: Sql,
  ticketId: string,
  owner: string,
): Promise<{ cancelled: boolean }> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Owner check prevents one agent from cancelling another's waiter.
  const rows = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'cancelled'
     WHERE ticket_id = ${ticketId}::uuid
       AND owner = ${owner}
       AND status = 'waiting'
     RETURNING ticket_id
  `;
  return { cancelled: rows.length > 0 };
}
