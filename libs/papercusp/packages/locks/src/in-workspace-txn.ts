/**
 * Per-workspace transaction wrapper.
 *
 * Every state-mutating tool runs through this. Provides:
 *   - A shared per-workspace gate plus deterministic per-path advisory locks
 *     for file-lock operations. Unrelated paths can proceed concurrently;
 *     global operations keep the exclusive workspace lock (key 101 in
 *     `sql/advisory-lock-keys.md`).
 *   - Safe default timeouts (overridden per-op inside the handler).
 *   - application_name tagging for pg_stat_activity visibility.
 *
 * Read-only ops (locks:queue) DO NOT use this wrapper — they don't need
 * the advisory lock and shouldn't pay its cost.
 */

import type { Sql } from 'postgres';
import { ensureBootstrap, getTxPool, SU_LOCKS_FEATURE_KEY } from './su-lock-store';
import { startBackgroundJanitor } from './workspace-listener';
import { txnTimeouts } from './config';

/**
 * Thrown when a per-workspace transaction can't proceed in time under
 * same-workspace contention: an advisory-lock wait exceeds
 * `lock_timeout` (PG `55P03`) or a statement exceeds `statement_timeout`
 * (PG `57014`). Callers map this to a structured busy result (`{ok:false}`)
 * instead of leaking a raw postgres error to the agent. The originating PG
 * error is kept on `.cause` / `.pgCode`.
 */
export class WorkspaceContendedError extends Error {
  readonly coordinationDomain: string;
  readonly pgCode: string;
  constructor(coordinationDomain: string, pgCode: string, cause: unknown) {
    super(`workspace "${coordinationDomain}" contended (pg ${pgCode}: lock/statement timeout)`);
    this.name = 'WorkspaceContendedError';
    this.coordinationDomain = coordinationDomain;
    this.pgCode = pgCode;
    this.cause = cause;
  }
}

/** PG SQLSTATEs that mean "couldn't serialize in time": lock_timeout +
 *  statement_timeout (query_canceled). */
const CONTENTION_CODES = new Set(['55P03', '57014']);

/** True under vitest / NODE_ENV=test — the background janitor timer is
 *  skipped there so no wall-clock tick can race a test's fixtures
 *  (tests drive runBackgroundJanitorOnce() directly). */
function isTestEnv(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

export interface WorkspaceTxnOptions {
  /**
   * Canonical file-lock paths touched by this transaction. When present,
   * acquire the shared workspace gate, shared advisory locks for each strict
   * ancestor, and one exclusive advisory lock per requested path, all in
   * sorted order. A request for `a/b/c.ts` therefore serializes with requests
   * for `a` and `a/b`, while sibling paths such as `a/b.ts` and `a/c.ts`
   * remain independent. An omitted/empty set keeps the historical exclusive
   * workspace scope for resource, granular, and housekeeping work.
   */
  paths?: readonly string[];
  /**
   * Per-operation timeout floors. A drain-capable caller has already declared
   * how long it is prepared to wait; forcing its advisory-lock statement back
   * to the global 5s default makes PostgreSQL cancel it, lose its FIFO queue
   * position, and re-enter at the tail on every retry. Floors preserve any
   * wider live db:txn-timeouts setting while letting that caller keep its place.
   */
  minLockTimeoutMs?: number;
  minStatementTimeoutMs?: number;
}

function timeoutWithFloor(configuredMs: number, floorMs: number | undefined): number {
  if (floorMs == null || !Number.isFinite(floorMs) || floorMs <= 0) return configuredMs;
  return Math.max(configuredMs, Math.trunc(floorMs));
}

function pathAncestors(path: string): string[] {
  if (path.length === 0) return [];
  const parts = path.split('/');
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Keep only the shallowest requested path when a transaction includes both a
 * directory/subtree and one of its descendants. The shallow path's exclusive
 * advisory lock already covers the descendant, and dropping the descendant
 * avoids trying to upgrade a shared ancestor lock to exclusive on the same
 * transaction.
 */
function uniqueSortedPaths(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const requested = Array.from(new Set(paths.filter((path) => path.length > 0))).sort();
  return requested.filter(
    (path) =>
      !requested.some(
        (ancestor) => ancestor !== path && path.startsWith(`${ancestor}/`),
      ),
  );
}

async function acquireAdvisoryScope(
  tx: Sql,
  coordinationDomain: string,
  paths: readonly string[] | undefined,
): Promise<void> {
  const scopedPaths = uniqueSortedPaths(paths);
  if (scopedPaths.length === 0) {
    // Preserve the original key for global operations and rolling
    // compatibility with processes that still use the workspace lock alone.
    await tx`SELECT pg_advisory_xact_lock(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain})
    )`;
    return;
  }

  // The shared gate prevents a path-scoped operation from racing a global
  // sweep/resource operation. The old workspace key is deliberately reused so
  // an old process holding the exclusive key still blocks new path work.
  await tx`SELECT pg_advisory_xact_lock_shared(
    ${SU_LOCKS_FEATURE_KEY}::int,
    hashtext(${'su:' + coordinationDomain})
  )`;

  // Shared locks on strict ancestors make a subtree/exact-path exclusive lock
  // conflict with descendants, while siblings can share the same directory
  // ancestor. Lock all shared ancestors before any exclusive leaves, then all
  // leaves in a stable order, so overlapping multi-path requests cannot form a
  // lock-order cycle.
  const ancestors = Array.from(
    new Set(scopedPaths.flatMap(pathAncestors)),
  ).sort();
  for (const path of ancestors) {
    await tx`SELECT pg_advisory_xact_lock_shared(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain + ':' + path})
    )`;
  }
  for (const path of scopedPaths) {
    await tx`SELECT pg_advisory_xact_lock(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain + ':' + path})
    )`;
  }
}

export async function inWorkspaceTxn<T>(
  coordinationDomain: string,
  ownerId: string,
  fn: (tx: Sql) => Promise<T>,
  options: WorkspaceTxnOptions = {},
): Promise<T> {
  await ensureBootstrap();
  // Arm the background expiry janitor on the first mutating locks:* op
  // (file-locking #4). Idempotent + cheap, so calling it every op is
  // fine; the timer module lives in workspace-listener.ts.
  if (!isTestEnv()) startBackgroundJanitor();
  const sql = getTxPool();
  // postgres-js's `begin` returns the handler's value but wraps it in
  // UnwrapPromiseArray<T>; for our non-array results the cast is safe.
  let result: unknown;
  try {
    result = await sql.begin(async (tx) => {
    // Diagnostic name visible in pg_stat_activity (set below, in the same
    // round trip as the timeouts — WI-10003631).
    // Per-workspace lock_timeout + statement_timeout. Baked 5s/5s, but runtime-settable via the
    // LocksHost getTxnTimeouts seam (db:txn-timeouts, live-configurability-audit-2026-06-20 P-020),
    // so the window can be widened mid-incident without a deploy through this very txn path.
    // set_config(name, value, is_local=true) == SET LOCAL, but takes the value as a BOUND PARAMETER
    // (a bare `SET` does not) — same form as the application_name line above. Per-op overrides still
    // come from the tool handler. txnTimeouts() is fail-safe to 5s/5s on any host/read error.
    const configuredTimeouts = txnTimeouts();
    const lockTimeoutMs = timeoutWithFloor(configuredTimeouts.lockTimeoutMs, options.minLockTimeoutMs);
    const statementTimeoutMs = timeoutWithFloor(
      configuredTimeouts.statementTimeoutMs,
      options.minStatementTimeoutMs,
    );
    await tx`SELECT set_config('application_name', ${'papercusp-su:' + ownerId}, true),
                    set_config('lock_timeout', ${`${Math.trunc(lockTimeoutMs)}ms`}, true),
                    set_config('statement_timeout', ${`${Math.trunc(statementTimeoutMs)}ms`}, true)`;
    await acquireAdvisoryScope(tx as unknown as Sql, coordinationDomain, options.paths);
    // TransactionSql has the same tagged-template surface as Sql for our
    // purposes; the cast lets store helpers take a single `Sql` type
    // rather than juggling a union that TS can't resolve as callable.
    return fn(tx as unknown as Sql);
    });
  } catch (err) {
    // Map a same-workspace contention timeout (advisory-lock lock_timeout /
    // statement_timeout) into a typed error callers turn into a structured busy
    // result — never a raw postgres error to the agent (P-015).
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === 'string' && CONTENTION_CODES.has(code)) {
      throw new WorkspaceContendedError(coordinationDomain, code, err);
    }
    throw err;
  }
  return result as T;
}
