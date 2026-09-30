/**
 * Runtime per-workspace transaction-timeout config (live-configurability-audit-2026-06-20 P-020).
 *
 * The per-workspace advisory-lock txn wrapper in @papercusp/locks (in-workspace-txn.ts) applies a
 * lock_timeout + statement_timeout — baked at 5s/5s, the values that decide whether a same-workspace
 * contention wait or a slow statement is killed (PG 55P03 / 57014 → WorkspaceContendedError). This is
 * the runtime OVERRIDE: the operator injects txnTimeoutsConfig() into the locks LocksHost seam
 * (getTxnTimeouts), so the wrapper reads these per-txn. Mid-incident you can WIDEN the window (e.g.
 * lock_timeout 5s→15s to ride out same-workspace contention) without a deploy — the most incident-
 * relevant of the §H storage/PG dials.
 *
 * Read via a module-level SYNC cache (zero-await — getTxnTimeouts is called per-txn on the mutating
 * hot path), refreshed on (a) the flag's onFlagChange (kill-switch flip + a key===null reload),
 * (b) local write (same-process immediate), (c) a ~60s .unref()'d periodic timer for bounded (≤60s)
 * cross-process + restart freshness. The module import is deliberately PURE (no import-time
 * getFlag/PG read — agent-tools/locks/configure.ts imports it on the boot path); legs (a) and (c)
 * are armed on FIRST READ rather than at import, so the import touches no flags/server binding at
 * all — see ensureLiveRefreshArmed() below for why that distinction is load-bearing.
 *
 * (This header previously cited "the ratified D-010 mechanism" as the authority for the above.
 * That citation is DANGLING: no plan decision in this workspace ratifies it — verified 2026-08-03
 * against both the `decisions` jsonb and the raw `content` column of every plan. The design is
 * sound on its own merits, which are stated here; it just was not governed by a D-010.)
 *
 * Default-ON kill-switch (FLAGS.TXN_TIMEOUTS_CONFIG): the override store is empty by default ⇒
 * txnTimeoutsConfig() returns the baked 5s/5s defaults ⇒ byte-identical. Flip the flag OFF to ignore
 * any stored override and force the defaults.
 */
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { FLAGS } from '@papercusp/flags';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface TxnTimeoutsConfig {
  /** pg_advisory_xact_lock wait cap (PG lock_timeout), in ms. */
  lockTimeoutMs: number;
  /** Per-statement cap (PG statement_timeout), in ms. */
  statementTimeoutMs: number;
}

/**
 * The baked defaults — the per-workspace txn wrapper's safe floor (5s/5s), byte-identical to the
 * literal that shipped before db:txn-timeouts. MUST stay in lock-step with @papercusp/locks'
 * DEFAULT_TXN_TIMEOUTS (the package's own standalone fallback when getTxnTimeouts is unwired).
 */
export const TXN_TIMEOUTS_DEFAULTS: TxnTimeoutsConfig = {
  lockTimeoutMs: 5000,
  statementTimeoutMs: 5000,
};

/** A partial override of the defaults (only the keys the operator set).
 *  WI-832 adds `adminPoolStatementTimeoutMs` — a SEPARATE concern that rides the same
 *  store/flag/cache: the default statement_timeout (ms) for NEW org POOL connections.
 *  EI-21866253550551759: it is a CONNECT-TIME GUC that buildConnectionOptions omits when
 *  the pool is behind PgBouncer, so under pooling it bounds only what already runs inside
 *  boundedOrgTxn / inWorkspaceTxn — never treat a stored value as proof the class is
 *  bounded (db:txn-timeouts op:get reports applied-vs-stored). It is NOT part of
 *  TxnTimeoutsConfig — that type is the per-WORKSPACE inWorkspaceTxn wrapper's pair, whose
 *  return shape the locks host destructures and must stay {lockTimeoutMs, statementTimeoutMs}. */
export type TxnTimeoutsOverride = Partial<TxnTimeoutsConfig> & {
  /** Default statement_timeout (ms) for new org pool connections. 0 / unset ⇒ no GUC
   *  (admin pool stays deliberately unbounded — today's exact behavior). Distinct from
   *  statementTimeoutMs, which bounds the per-workspace advisory-lock txn wrapper. */
  adminPoolStatementTimeoutMs?: number;
};

// ── D-010 sync cache ────────────────────────────────────────────────────────
let cachedEnabled = false;
let cachedOverride: TxnTimeoutsOverride = {};

/** The effective per-workspace txn timeouts for the locks hot path. SYNC, zero-await. */
export function txnTimeoutsConfig(): TxnTimeoutsConfig {
  ensureLiveRefreshArmed();
  if (!cachedEnabled) return TXN_TIMEOUTS_DEFAULTS;
  return {
    lockTimeoutMs: cachedOverride.lockTimeoutMs ?? TXN_TIMEOUTS_DEFAULTS.lockTimeoutMs,
    statementTimeoutMs: cachedOverride.statementTimeoutMs ?? TXN_TIMEOUTS_DEFAULTS.statementTimeoutMs,
  };
}

/**
 * WI-832: the configured default statement_timeout (ms) for NEW org pool connections —
 * injected into the low-level db connection factory via setAdminPoolStatementTimeoutProvider
 * (the layering-safe seam; connection.ts can't read this config directly). 0 ⇒ unset (the
 * admin pool stays unbounded — today's behavior). SYNC, zero-await, same kill-switch + cache
 * as txnTimeoutsConfig(). The migration runner opts out per-txn (SET LOCAL statement_timeout=0).
 */
export function adminPoolStatementTimeoutMs(): number {
  ensureLiveRefreshArmed();
  if (!cachedEnabled) return 0;
  const v = Math.trunc(cachedOverride.adminPoolStatementTimeoutMs ?? 0);
  return v > 0 ? v : 0;
}

export async function refreshTxnTimeoutsConfig(): Promise<void> {
  try {
    cachedEnabled = await getFlag(FLAGS.TXN_TIMEOUTS_CONFIG, systemDistinctId());
    cachedOverride = cachedEnabled
      ? (await readOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config')) ?? {}
      : {};
  } catch {
    // Fail-safe to the baked defaults — never let a config read change the txn window unexpectedly.
    cachedEnabled = false;
    cachedOverride = {};
  }
}
/**
 * Live-refresh wiring, armed on FIRST USE rather than at import (EI-19416650993725684).
 *
 * WHY LAZY, and why this is not merely a style choice: an `import { onFlagChange }` whose binding
 * is READ at module scope makes this module unimportable under a PARTIAL vitest mock of
 * `@papercusp/flags/server`. Vitest's mocked-module proxy throws on binding ACCESS (not on
 * invocation), so the whole test FILE dies at collection with
 *   No "onFlagChange" export is defined on the "@papercusp/flags/server" mock
 * contributing ZERO tests — a failure that names this module while pointing at a file that never
 * mentions it. 96 of the 116 operator-core test files that mock flags/server omit `onFlagChange`,
 * so every one of them is one transitive import of `agent-tools/locks/configure.ts` away from that.
 * Two already hit it (loop/arm.test.ts, work_items/complete.test.ts, WI-7411).
 *
 * ⚠ MEASURED, do not "simplify" this back: defensive forms do NOT work, because they are still
 * binding accesses — `onFlagChange?.(...)`, `typeof onFlagChange`, try/catch around the call, and
 * `import * as ns` + `ns.onFlagChange?.()` all throw identically. Moving the access inside a
 * function body is the only fix that keeps the import pure.
 *
 * Behaviour is unchanged for real consumers: the cache starts at the baked defaults and is only
 * ever populated by an async refresh, so arming at first read rather than at import cannot change
 * what any caller observes — the readers below return defaults until a refresh lands either way.
 * A process that imports this module but never reads the config now also stops paying for a timer
 * it never used.
 */
let liveRefreshArmed = false;
function ensureLiveRefreshArmed(): void {
  if (liveRefreshArmed) return;
  liveRefreshArmed = true;
  // (a): event-driven refresh — fires on the kill-switch flip + a key===null reload.
  onFlagChange((key) => {
    if (key === null || key === FLAGS.TXN_TIMEOUTS_CONFIG) void refreshTxnTimeoutsConfig();
  });
  // (c): bounded cross-process + restart freshness. .unref() so it never holds the process open.
  // P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
  managedSetInterval('config-refresh:txn-timeouts', 60_000, () => refreshTxnTimeoutsConfig(), {
    category: 'cache',
  });
}

// ── async read/write (the tool) ──────────────────────────────────────────────
export async function readTxnTimeoutsOverride(): Promise<TxnTimeoutsOverride> {
  return (await readOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config')) ?? {};
}

async function persist(next: TxnTimeoutsOverride): Promise<TxnTimeoutsOverride> {
  await writeOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config', next);
  await refreshTxnTimeoutsConfig(); // same-process immediacy
  return next;
}

/** Merge a partial override over the current one (only the 2 known keys; undefined = leave). */
export async function setTxnTimeoutsOverride(patch: TxnTimeoutsOverride): Promise<TxnTimeoutsOverride> {
  const cur = await readTxnTimeoutsOverride();
  const next: TxnTimeoutsOverride = { ...cur };
  if (patch.lockTimeoutMs !== undefined) next.lockTimeoutMs = patch.lockTimeoutMs;
  if (patch.statementTimeoutMs !== undefined) next.statementTimeoutMs = patch.statementTimeoutMs;
  if (patch.adminPoolStatementTimeoutMs !== undefined) next.adminPoolStatementTimeoutMs = patch.adminPoolStatementTimeoutMs;
  return persist(next);
}

export async function setTxnTimeoutsOverrideFull(o: TxnTimeoutsOverride): Promise<void> {
  await persist(o ?? {});
}

export async function resetTxnTimeoutsOverride(): Promise<void> {
  await persist({});
}

registerOverrideConcern({
  name: 'txn-timeouts-config',
  description:
    'runtime per-workspace transaction timeouts (lockTimeoutMs / statementTimeoutMs) over the baked 5s/5s defaults (kill-switch: papercusp-txn-timeouts-config)',
  auditAction: 'db:txn-timeouts',
  diff: async () => {
    const o = await readTxnTimeoutsOverride();
    const entries: OverrideEntry[] = [];
    for (const key of ['lockTimeoutMs', 'statementTimeoutMs'] as const) {
      if (o[key] !== undefined) {
        entries.push({ key, effective: o[key], default: TXN_TIMEOUTS_DEFAULTS[key], layer: 'pg-settings' });
      }
    }
    // WI-832: admin-pool default statement_timeout (default 0 = unset; not in the per-workspace defaults).
    if (o.adminPoolStatementTimeoutMs !== undefined) {
      entries.push({ key: 'adminPoolStatementTimeoutMs', effective: o.adminPoolStatementTimeoutMs, default: 0, layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readTxnTimeoutsOverride(),
  reset: () => resetTxnTimeoutsOverride(),
  restore: (snap) => setTxnTimeoutsOverrideFull((snap as TxnTimeoutsOverride) ?? {}),
});
