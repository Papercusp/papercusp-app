/**
 * Host seam for `@papercusp/locks`.
 *
 * The package owns the entire SU-locks substrate — its own `papercusp_su`
 * side-database, connection pools, migration runner, advisory-lock
 * serialization, grant cascade, wait subsystem, and background janitor.
 * The ONE thing it does NOT know is how to resolve the embedded-pg admin
 * URL for the host's running Postgres instance; that is the embedding
 * application's concern, injected here. This keeps the package free of any
 * `@papercusp/@restart` runtime dependency other than the
 * `@papercusp/file-claim` interface it implements.
 *
 * Deliberately narrow (BRIEF-locks-extraction-2026-05-30, D-010): the seam
 * is a single `() => url` callback, NOT a shared transaction handle. Locks
 * keeps its own DB + pool + `pg_advisory_xact_lock` — that isolation is the
 * point. `coordinationDomain` is an opaque caller-supplied string and is
 * never derived from a workspace/harness noun inside the package.
 */
/**
 * Per-workspace transaction timeouts (PG lock_timeout / statement_timeout, in ms) applied inside
 * inWorkspaceTxn. live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
 */
export interface TxnTimeouts {
  /** pg_advisory_xact_lock wait cap (lock_timeout). */
  lockTimeoutMs: number;
  /** Per-statement cap (statement_timeout). */
  statementTimeoutMs: number;
}

/**
 * The baked defaults — the per-workspace txn wrapper's safe floor (5s/5s), the values that shipped
 * before db:txn-timeouts. Used whenever the host wires no getTxnTimeouts callback (the locks package
 * standalone, or tests). MUST stay in lock-step with operator-core's TXN_TIMEOUTS_DEFAULTS.
 */
export const DEFAULT_TXN_TIMEOUTS: TxnTimeouts = { lockTimeoutMs: 5000, statementTimeoutMs: 5000 };

export interface LocksHost {
  /**
   * Resolve the embedded-pg admin URL for the host's MAIN database (the
   * one the operator normally connects to). The SU side-database URL is
   * derived from it by swapping the database-name path component to
   * `papercusp_su`; bootstrap (`CREATE DATABASE`) connects to this main URL
   * directly. Called per use (not cached here) so the host can run its own
   * connection change-detection.
   */
  getAdminBaseUrl: () => string;
  /**
   * OPTIONAL: resolve the per-workspace transaction timeouts (lock_timeout /
   * statement_timeout in ms) applied inside inWorkspaceTxn. Called per-txn —
   * keep it SYNC + zero-await (the host backs it with its own cache). Omitted
   * ⇒ the baked DEFAULT_TXN_TIMEOUTS (5s/5s), byte-identical to pre-config
   * behavior. Still a value callback, NOT a shared handle — consistent with
   * the deliberately-narrow seam. live-configurability-audit-2026-06-20 P-020.
   */
  getTxnTimeouts?: () => TxnTimeouts;
}

let _host: LocksHost | null = null;

/**
 * Wire the host seam. The embedding application calls this once at startup,
 * before any locks API is used (the operator's host-adapter barrel calls it
 * at module load — see `apps/operator/lib/agent-tools/locks/configure.ts`).
 */
export function configureLocks(host: LocksHost): void {
  _host = host;
}

/** Internal: read the configured host, throwing if unconfigured. */
export function locksHost(): LocksHost {
  if (!_host) {
    throw new Error(
      '@papercusp/locks: configureLocks() must be called before using the locks API',
    );
  }
  return _host;
}

/**
 * Resolve the effective per-workspace transaction timeouts (lock_timeout / statement_timeout in ms)
 * applied inside inWorkspaceTxn. Returns the wired host's getTxnTimeouts() if present, else the baked
 * DEFAULT_TXN_TIMEOUTS. FAIL-SAFE: a missing host, a missing callback, a throw, or a non-finite value
 * all fall back to the 5s/5s default — a config read must never break or unexpectedly change the txn
 * window. live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
 */
export function txnTimeouts(): TxnTimeouts {
  const h = _host;
  if (!h?.getTxnTimeouts) return DEFAULT_TXN_TIMEOUTS;
  try {
    const t = h.getTxnTimeouts();
    return {
      lockTimeoutMs: Number.isFinite(t?.lockTimeoutMs) ? t.lockTimeoutMs : DEFAULT_TXN_TIMEOUTS.lockTimeoutMs,
      statementTimeoutMs: Number.isFinite(t?.statementTimeoutMs)
        ? t.statementTimeoutMs
        : DEFAULT_TXN_TIMEOUTS.statementTimeoutMs,
    };
  } catch {
    return DEFAULT_TXN_TIMEOUTS;
  }
}
