/**
 * Generic TTL-based row expiry. One sweep loop, many tables.
 *
 * Replaces ad-hoc lazy-delete + bespoke sweeper code scattered across
 * `provision/operator-claims.ts`, `auth.ts`,
 * `harness-status-sweep.ts:sweepHarnessStatusStalled`, etc. — each of
 * which had its own TTL constant + its own DELETE timing + its own
 * "what to do with expired rows" semantics.
 *
 * The model:
 *
 *   1. Writer sets `expires_at = now() + interval` on every INSERT/UPDATE.
 *   2. This module runs a periodic sweep: `DELETE FROM <table> WHERE
 *      expires_at < now()` for every registered table.
 *   3. Readers can stop checking expiry inline — by the time a row
 *      reaches them via Zero/PG, it's still live (or it's gone).
 *
 * Some tables don't want DELETE on expiry — they want a `status` flip
 * (e.g. `harness_status` goes 'running' → 'stalled' rather than
 * disappearing). Those register with `onExpire: 'mark-stalled'` and
 * the sweep does an UPDATE instead.
 *
 * Pinned to globalThis (anti-pattern A18 compliance with Next.js dev
 * module re-eval). Idempotent registration; idempotent start. SIGTERM
 * cleans up the timer.
 *
 * Future: when pg_cron is available on the database, this whole module
 * becomes a one-time `pg_cron.schedule(...)` call per registered table.
 * Writers don't change.
 */

import { getOrgPg } from '@papercusp/db-org';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

// not a DBOS candidate (dbos-scheduler-consolidation-2026-06-03 D-002 / P-011):
// this sweeps a process-local in-memory registry of TTL'd entries — a detached
// DBOS cron can't see in-process Maps. It would only qualify if the registry
// moved to PG (out of scope). Stays in-process.
const SWEEP_INTERVAL_MS = 30_000;

export type ExpirySweepKind =
  | { kind: 'delete' }
  | {
      kind: 'mark-status';
      column: string;
      from: string;
      to: string;
      timestampColumn?: string;
    };

export interface ExpirableRegistration {
  /** Fully-qualified table name, e.g. `harness_shared.operator_scan_locks`. */
  table: string;
  /** Column whose value, when in the past, indicates the row is expired. */
  expiresAtColumn?: string;
  /**
   * Type of the expires column. `'timestamptz'` (default) compares with
   * `now()`. `'unix-ms'` (bigint milliseconds since epoch) compares with
   * `(extract(epoch from now()) * 1000)::bigint` — used by `papercusp_auth`
   * which stores timestamps as bigints.
   */
  columnType?: 'timestamptz' | 'unix-ms';
  /** What the sweep does when a row is expired. Defaults to delete. */
  onExpire?: ExpirySweepKind;
  /** Optional: sweep less often than the global interval. */
  intervalMs?: number;
}

interface RegistryState {
  registrations: Map<string, ExpirableRegistration>;
  timer: ManagedHandle | null;
  stopped: boolean;
  lastTickAt: Map<string, number>;
}

type _G = { __expirableRegistry?: RegistryState };
const _g = globalThis as unknown as _G;

function state(): RegistryState {
  if (!_g.__expirableRegistry) {
    _g.__expirableRegistry = {
      registrations: new Map(),
      timer: null,
      stopped: false,
      lastTickAt: new Map(),
    };
  }
  return _g.__expirableRegistry;
}

/**
 * Register a table for periodic expiry sweeping. Idempotent — re-registering
 * the same table replaces the previous registration.
 */
export function registerExpirable(reg: ExpirableRegistration): void {
  state().registrations.set(reg.table, reg);
}

/**
 * Manual one-shot sweep for a single registered table. Used by tests + by
 * routes that want to run the sweep on demand (e.g. just before listing rows
 * to avoid showing expired ones during the up-to-30s sweep gap).
 */
export async function sweepOne(table: string): Promise<void> {
  const reg = state().registrations.get(table);
  if (!reg) return;
  await sweepRegistration(reg);
}

async function sweepRegistration(reg: ExpirableRegistration): Promise<void> {
  const { sql } = getOrgPg();
  const expiresCol = reg.expiresAtColumn ?? 'expires_at';
  const onExpire = reg.onExpire ?? { kind: 'delete' };
  // SQL fragment that evaluates to "now" in the column's units.
  const nowExpr = reg.columnType === 'unix-ms'
    ? `(extract(epoch from now()) * 1000)::bigint`
    : `now()`;

  try {
    if (onExpire.kind === 'delete') {
      // sql.unsafe lets us interpolate the table identifier — postgres-js
      // doesn't have a Knex-style identifier helper. The table name comes
      // from a closed registry (not user input), so this is safe.
      await sql.unsafe(
        `DELETE FROM ${reg.table} WHERE ${expiresCol} < ${nowExpr}`,
      );
    } else {
      const tsCol = onExpire.timestampColumn;
      await sql.unsafe(
        `UPDATE ${reg.table}
            SET ${onExpire.column} = $1
                ${tsCol ? `, ${tsCol} = $2` : ''}
          WHERE ${onExpire.column} = $3
            AND ${expiresCol} < ${nowExpr}`,
        tsCol
          ? [onExpire.to, Date.now(), onExpire.from]
          : [onExpire.to, onExpire.from],
      );
    }
  } catch (e) {
    // 42P01 = undefined_table. Some registered tables (e.g. operator_claims)
    // are created by provision / ensure-schema, which can run AFTER the sweep
    // loop has already started — so the first ticks hit a not-yet-existing
    // table. That's an expected transient at boot (the next tick succeeds once
    // the table exists), so swallow it silently; warn loudly on everything else.
    if ((e as { code?: string })?.code !== '42P01') {
      console.warn(
        `[expirable-registry] sweep failed for ${reg.table}:`,
        (e as Error)?.message ?? e,
      );
    }
  }
}

async function tick(): Promise<void> {
  const s = state();
  const now = Date.now();
  for (const reg of s.registrations.values()) {
    const last = s.lastTickAt.get(reg.table) ?? 0;
    const interval = reg.intervalMs ?? SWEEP_INTERVAL_MS;
    if (now - last < interval) continue;
    s.lastTickAt.set(reg.table, now);
    await sweepRegistration(reg);
  }
}

/**
 * Start the periodic sweeper. Idempotent. Call once at module-graph init
 * (alongside `ensureHarnessFsWatcher`, `ensureHarnessStatusSweep`).
 */
export function ensureExpirableRegistry(): RegistryState {
  const s = state();
  if (s.timer) return s;

  s.timer = managedSetInterval('expirable-registry-sweep', SWEEP_INTERVAL_MS, () => {
    tick().catch((e) =>
      console.warn('[expirable-registry] tick failed:', (e as Error)?.message ?? e),
    );
  }, { category: 'global-sweep' });

  // Cold-boot tick fires immediately so anything stale at startup gets
  // cleared without the operator having to wait 30s for the first sweep.
  void tick().catch(() => {});

  const shutdown = () => stopExpirableRegistry();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return s;
}

export function stopExpirableRegistry(): void {
  const s = state();
  if (s.timer) s.timer.stop();
  s.timer = null;
  s.stopped = true;
}
