/**
 * Workspace-context wrapper for harness_shared.* queries.
 *
 * Every read/write against a workspace-scoped table must execute inside
 * a transaction with `SET LOCAL app.workspace_id` set. This module provides
 * the canonical wrapper.
 *
 * Usage:
 *
 *   import { withWorkspace } from '@papercusp/db-org/workspace-context';
 *   const result = await withWorkspace(workspaceId, async (tx) => {
 *     return await tx`SELECT * FROM harness_shared.projects`;
 *   });
 *
 * The `tx` parameter is a postgres-js Sql tagged-template that runs
 * inside the transaction with the GUC set. NEVER reach for the bare-pool
 * `db` import inside the callback — the tx-only ESLint rule will reject
 * that, because a fresh checkout would have no GUC and bypass RLS.
 */

import type { Sql, TransactionSql } from 'postgres';
import {
  getOrgPg,
  getOrgPgApp,
  getHarnessPg,
  pgbouncerEnabled,
  withAcquisitionDeadline,
  retryOnRetryableDbDeadline,
  DbCallDeadlineError,
  DEFAULT_TX_ACQUIRE_DEADLINE_MS,
} from './connection';
import { slugToSchemaName } from './schema';
import { retryBeforeCallbackStarts } from './connect-retry';

export interface WorkspaceTxOptions {
  /**
   * If true, skip setting `app.workspace_id` (admin-only escape hatch
   * for migrations that intentionally span workspaces). Default false.
   *
   * Calls passing this MUST be using a connection that BYPASSES RLS
   * (i.e. harness_admin role). Do not use from application code.
   */
  bypassRlsForAdmin?: boolean;
  /** Diagnostic hook: BEGIN has completed, then transaction-local setup is ready.
   * The caller's callback starts only after `ready`. */
  onAcquisitionPhase?: (phase: 'begin' | 'ready') => void;
}

/**
 * Run a callback inside a transaction with `app.workspace_id` set.
 *
 * @param workspaceId  Auth-derived workspace identifier. Must be non-empty.
 * @param fn           Callback receiving the transaction-bound Sql client.
 * @param opts         See {@link WorkspaceTxOptions}.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: Sql) => Promise<T>,
  opts: WorkspaceTxOptions = {},
): Promise<T> {
  if (!workspaceId && !opts.bypassRlsForAdmin) {
    throw new Error(
      'withWorkspace: workspaceId is empty. Auth-derive it from the bearer token; do not pass empty.',
    );
  }
  // Default path: harness_app role, SUBJECT to RLS. The GUC inside the
  // transaction is the load-bearing workspace filter.
  // Admin-bypass path: harness_admin role, RLS bypassed (intentional for
  // migrations and cross-workspace tooling).
  const { sql } = opts.bypassRlsForAdmin ? getOrgPg() : getOrgPgApp();
  // EI-9279: retry a CONNECTION_CLOSED/CONNECT_TIMEOUT hitting a stale pooled
  // connection — but ONLY while `markStarted()` proves the caller's own `fn`
  // hasn't run any query yet (see connect-retry.ts header for why this is
  // provably safe: BEGIN + the SET_CONFIG statements below are side-effect-free,
  // and postgres-js's sql.begin() awaits BEGIN's round trip before invoking the
  // callback at all).
  // P-022 / D-020: bound the ACQUISITION phase (connect + BEGIN + SET_CONFIG),
  // never the caller's own `fn`. Against a dead endpoint postgres-js retries a
  // pool's first connect forever and never rejects the pending query, so every
  // call here blocked at `sql.begin()` BEFORE its handler ran — that is how
  // 100% of MCP dispatch (coord:whoami included) wedged on 2026-08-03 while
  // /api/health stayed at 2ms on the unaffected ADMIN pool. The deadline sits
  // OUTSIDE retryBeforeCallbackStarts on purpose, so it bounds total
  // acquisition across all retry attempts rather than each attempt separately.
  const acquireLabel = `withWorkspace:acquire(${opts.bypassRlsForAdmin ? 'admin' : 'app'})`;
  // EI-19485014132257783: the POOL, not the call site — these are the labels
  // getOrgPg()/getOrgPgApp() hand buildClient(), so they match the
  // `pcusp:<label>:p<pid>` application_name a reader will grep pg_stat_activity
  // for. Passing it makes a deadline breach report MEASURED waiting/held counts
  // rather than the 3-step manual probe the message used to hand out.
  const acquirePool = opts.bypassRlsForAdmin ? 'org-admin' : 'org-app';
  return retryOnRetryableDbDeadline(() =>
    withAcquisitionDeadline<T>(
      ({ disarm, expired }) =>
        retryBeforeCallbackStarts((markStarted) =>
    // postgres-js's `sql.begin` callback receives a TransactionSql which
    // is a subset of Sql; the cast is safe for the operations we perform
    // (templated queries + .unsafe).
    (sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      opts.onAcquisitionPhase?.('begin');
      // postgres-js's TransactionSql is a SUBSET of Sql — it omits
      // `.options` (the parsers/serializers config). drizzle-orm's
      // `drizzle(client)` reads `client.options.parsers` in its
      // constructor, so any `drizzle(tx)` inside a withWorkspace callback
      // throws "Cannot read properties of undefined (reading 'parsers')"
      // (2026-05-22 P5 follow-up — broke harness:list and every other
      // agent-mcp read tool, plus the operator scan-lock). parsers /
      // serializers are connection-scoped, so point the TransactionSql at
      // the parent connection's options object — that satisfies
      // `drizzle(tx)` and is a no-op for raw `tx\`...\`` queries (the
      // parent's options were already drizzle-mutated by getOrgPgApp()).
      const txOpts = txSql as unknown as { options?: unknown };
      txOpts.options ??= (sql as unknown as { options?: unknown }).options;
      // C1-2 of backend-connection-scaling-2026-06-17: under PgBouncer transaction
      // pooling the connect-time search_path is NOT preserved (server connections are
      // shared across clients), so set it per-transaction — mirrors getOrgPg/getOrgPgApp's
      // connect-time value. Gated on pgbouncerEnabled() (the SAME predicate as
      // maybePgbouncer) so the direct-connection default (which already carries the
      // connect-time search_path) is byte-for-byte unchanged, and the pooled path
      // always re-applies the search_path in lockstep with the URL rerouting. This
      // makes the HOT path (every agent tool call) pooler-correct.
      if (pgbouncerEnabled()) {
        // PgBouncer drops connection-local search_path, and app reads also need
        // the transaction-local RLS scope. Set both in one round trip when
        // they are both required; the two settings are independent.
        if (opts.bypassRlsForAdmin) {
          await txSql`SELECT set_config('search_path', 'harness_shared, papercusp_shared, public', true)`;
        } else {
          await txSql`SELECT set_config('search_path', 'harness_shared, papercusp_shared, public', true),
                             set_config('app.workspace_id', ${workspaceId}, true)`;
        }
      } else if (!opts.bypassRlsForAdmin) {
        await txSql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      }
      // Promise.race does NOT cancel the losing promise: if the acquisition
      // deadline already fired, the caller has its DbCallDeadlineError and is
      // no longer awaiting us. Throwing here rolls the transaction back rather
      // than running `fn` — and its side effects — with nobody listening.
      if (expired()) {
        throw new DbCallDeadlineError(
          acquireLabel,
          DEFAULT_TX_ACQUIRE_DEADLINE_MS,
          DEFAULT_TX_ACQUIRE_DEADLINE_MS,
          acquirePool,
        );
      }
      // Past this point the caller's own work begins and may legitimately run
      // long (a search, a test run), so the acquisition deadline must not apply.
      opts.onAcquisitionPhase?.('ready');
      disarm();
      markStarted();
      return await fn(txSql);
    }) as unknown) as Promise<T>
      , { pool: acquirePool }),
      { label: acquireLabel, pool: acquirePool },
    ),
  );
}

/**
 * Convenience: run a single query in a workspace context. Useful for
 * one-off reads that don't need the multi-statement transaction.
 */
export async function withWorkspaceQuery<T>(
  workspaceId: string,
  query: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withWorkspace(workspaceId, query);
}

/**
 * Run a callback against a harness's per-schema tables/views using a transaction
 * with a per-transaction `SET LOCAL search_path` — the PgBouncer-transaction-safe
 * equivalent of the connect-time search_path that {@link getHarnessPg} sets on its
 * pooled connection. C1-2 of backend-connection-scaling-2026-06-17.
 *
 * Same app role and same search_path order as getHarnessPg. It does NOT set
 * `app.workspace_id`: the per-harness views scope by their baked-in slug and run
 * in the view owner's RLS context (and `harness_issues_consolidated` has no RLS),
 * which is exactly how the getHarnessPg path resolves rows today — verified by the
 * harness-schema integration test. Identifier-quoted the same way connection.ts
 * builds its search_path.
 */
export async function withHarnessSchema<T>(slug: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const searchPath = [slugToSchemaName(slug), 'harness_shared', 'papercusp_shared', 'public']
    .map((s) => `"${s.replace(/"/g, '""')}"`)
    .join(', ');
  const { sql } = getOrgPgApp();
  // P-022 / D-020: same acquisition deadline as withWorkspace — this path takes
  // the SAME APP pool, so it shares the dead-endpoint hang exactly.
  const acquireLabel = `withHarnessSchema:acquire(${slug})`;
  // Same APP pool as withWorkspace (getOrgPgApp above), so the acquire registry
  // must attribute both to the SAME pool — that shared queue is the whole point
  // of the measurement (EI-19485014132257783).
  const acquirePool = 'org-app';
  // EI-9279: same provably-safe retry as withWorkspace above — see connect-retry.ts.
  return retryOnRetryableDbDeadline(() =>
    withAcquisitionDeadline<T>(
      ({ disarm, expired }) =>
        retryBeforeCallbackStarts((markStarted) =>
    (sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      // Mirror withWorkspace's options-pointer fix so drizzle(tx) (if ever used) works.
      const txOpts = txSql as unknown as { options?: unknown };
      txOpts.options ??= (sql as unknown as { options?: unknown }).options;
      await txSql`SELECT set_config('search_path', ${searchPath}, true)`;
      if (expired()) {
        throw new DbCallDeadlineError(
          acquireLabel,
          DEFAULT_TX_ACQUIRE_DEADLINE_MS,
          DEFAULT_TX_ACQUIRE_DEADLINE_MS,
          acquirePool,
        );
      }
      disarm();
      markStarted();
      return await fn(txSql);
    }) as unknown) as Promise<T>
      , { pool: acquirePool }),
      { label: acquireLabel, pool: acquirePool },
    ),
  );
}

/**
 * Per-harness-schema query, correct in BOTH connection modes. This is the
 * drop-in replacement for `const { sql } = getHarnessPg(slug); … sql\`…\``.
 *
 *   - Default (direct connection): uses the existing getHarnessPg() pool whose
 *     search_path is set at connect time — byte-identical to today.
 *   - Under PgBouncer (pgbouncerEnabled()): wraps in a transaction with a
 *     per-transaction search_path, because transaction pooling does not preserve
 *     the connect-time one.
 *
 * Multiple statements that must share the harness search_path (e.g. an upsert loop
 * + a reconcile DELETE) MUST go in ONE harnessQuery() callback so they run in the
 * same transaction under PgBouncer. That alone is NOT sufficient for true
 * atomicity (a TOCTOU-sensitive SELECT-then-INSERT, say) across BOTH connection
 * modes — direct mode hands you the bare pool, not a transaction — so for that
 * shape use {@link harnessTransaction} instead of calling `sql.begin()` yourself.
 */
export function harnessQuery<T>(slug: string, fn: (q: Sql) => Promise<T>): Promise<T> {
  if (pgbouncerEnabled()) return withHarnessSchema(slug, fn);
  return fn(getHarnessPg(slug).sql);
}

/**
 * Multi-statement ATOMIC write against a harness's per-schema tables, correct in
 * BOTH connection modes — the transactional counterpart of {@link harnessQuery}.
 *
 * Do NOT wrap `harnessQuery`'s callback in your own `sql.begin(...)` — under
 * PgBouncer (pooled mode) the handle `harnessQuery` hands you is ALREADY a
 * postgres.js transaction handle (`withHarnessSchema` opened it to set the
 * per-transaction search_path), and a transaction handle exposes `savepoint`,
 * not `begin`: nesting `.begin()` on it throws
 * `TypeError: sql.begin is not a function` at runtime, not at compile time — the
 * exact trap `withCensusStatementTimeout` documents hitting in
 * work-items-admission-census.ts (WI-1194246). Under direct connection the
 * handle is the bare pool, which DOES need an explicit `.begin()` for the
 * statements to share one transaction.
 *
 * `harnessTransaction` picks the right one for you: call `.begin()` only when
 * the handle offers it (direct mode); otherwise it is already transaction-scoped
 * (pooled mode) and `fn`'s statements share that transaction for free. Same
 * `'begin' in sql ? sql.begin(fn) : fn(sql)` idiom already used in
 * conversations-store.ts / slack-flagship.ts /
 * learning-governor/store.ts / modes/store.ts / plan-dependency-admission-transaction.ts.
 */
export function harnessTransaction<T>(slug: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return harnessQuery(slug, (sql) => {
    // harnessQuery's own signature says `sql: Sql`, but under PgBouncer it is
    // ALREADY a TransactionSql (withHarnessSchema opened the transaction) —
    // the exact mismatch this function exists to paper over at runtime. Cast
    // to the honest union so 'begin' in s narrows properly in BOTH branches
    // (mirrors conversations-store.ts / slack-flagship.ts,
    // whose getSql() is typed Sql | TransactionSql to begin with).
    const s = sql as unknown as Sql | TransactionSql;
    return ('begin' in s ? s.begin(fn) : fn(s)) as Promise<T>;
  });
}
