/**
 * db-health.ts — the inference gateway's DURABLE-WRITE health tracker (EI-19303809952284205).
 *
 * THE DETECTOR GAP THIS CLOSES
 * ----------------------------
 * The gateway's DB-touching side-paths are all deliberately fire-and-forget: they must never
 * throw back into the request hot path, so each one ends in a `.catch(log)`. That is correct —
 * but the catch logs to the GATEWAY'S OWN journal and stops there, and nobody reads another
 * process's journal.
 *
 * On 2026-08-01 the gateway lost its Postgres connection (`ECONNREFUSED 127.0.0.1:20216` — a
 * dead embedded-PG port it had cached at boot ~13.7 days earlier). For HOURS:
 *
 *   - every account usage-window observation was dropped, so `operator_account_pool` froze and
 *     the owner's Accounts tab showed 5-7h-old numbers;
 *   - the account pool could not be loaded AT ALL, so the gateway collapsed to a single
 *     synthetic `local` credential — every account pin silently ignored, `healthyAccounts: 0`;
 *   - the scale-out reaction was inert.
 *
 * 134 failures in a 20-minute sample, continuous. Nothing alarmed. `/healthz` reported
 * `ok: true` the entire time, because it only ever described the REQUEST path. The owner found
 * it by noticing a UI panel looked stale.
 *
 * This module is the missing state: each durable-path outcome is recorded here, and the
 * snapshot is folded into `stats()` — which backs BOTH `/healthz` and `/stats`, so every
 * existing prober and the operator's system-health `tokens` panel see it with no new endpoint.
 *
 * WHY A MODULE SINGLETON
 * ----------------------
 * The recording sites (launch.ts's window projector / pool-reload poll / rate-hint refresh, and
 * the account-scale observer) are composed independently of the gateway server object, and the
 * reader (`stats()`) lives inside it. A process-local singleton is the only thing that joins
 * them without threading a handle through every call site. This is in-process EPHEMERAL
 * telemetry, not durable state — the storage policy's Postgres-by-default rule is about state
 * that must survive a restart, and a health streak explicitly must not (a restarted gateway has
 * no opinion about the previous process's DB).
 *
 * WHAT "UNHEALTHY" MEANS HERE — deliberately not "one write failed"
 * ----------------------------------------------------------------
 * `ok` flips false only when a streak is BOTH long enough (`FAILURE_STREAK`) and sustained long
 * enough (`SUSTAIN_MS`). A single blip must not 503 a gateway that is serving traffic perfectly
 * well; the incident this exists for ran for hours, so a two-minute floor loses nothing real and
 * buys immunity to transient reconnects. The pool-reload poll runs every 60s regardless of
 * traffic, so the streak advances even on a completely idle gateway — which matters, because the
 * traffic-driven projection write does not.
 *
 * `connectionLevel` separates "the DB is GONE" (ECONNREFUSED / terminated / DNS) from "a write
 * failed for some other reason". Both are alarmable and both count toward `ok`; the flag exists
 * so a reader can say WHICH without re-parsing the error string.
 */

/** The durable side-paths that are instrumented. Each is a distinct symptom of the same fault,
 *  and each was independently silent during the 2026-08-01 incident. */
export type DbOp =
  /** launch.ts makeWindowProjector — the account usage-window write. Traffic-driven; this is the
   *  stream that IS the Accounts tab's live data. */
  | 'window-projection'
  /** launch.ts pool-reload poll — reads the account pool from PG every 60s. The CONTINUOUS
   *  heartbeat: it advances the streak even when the gateway is serving nothing. */
  | 'pool-reload'
  /** launch.ts refreshGatewayHints — the rate-hint / owner-pin cold-start + resync read. */
  | 'rate-hints'
  /** account-pool-store initAccountScaleObserver — the penalty read-modify-write behind
   *  auto-scale-out. Event-driven and rare, so never rely on it alone. */
  | 'scale-observer';

export const DB_OPS: readonly DbOp[] = ['window-projection', 'pool-reload', 'rate-hints', 'scale-observer'];

/** Consecutive failures on a single op before it can be considered unhealthy. */
export const FAILURE_STREAK = (() => {
  const env = Number(process.env.PAPERCUSP_GATEWAY_DB_FAILURE_STREAK);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 3;
})();

/** How long a streak must persist before `ok` flips false. Paired with FAILURE_STREAK so a fast
 *  burst of retries cannot trip the alarm on its own. */
export const SUSTAIN_MS = (() => {
  const env = Number(process.env.PAPERCUSP_GATEWAY_DB_SUSTAIN_MS);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 120_000;
})();

/** Per-op recorded state. */
export interface DbOpHealth {
  op: DbOp;
  /** Consecutive failures since the last success. 0 = last outcome was OK (or none yet). */
  consecutiveFailures: number;
  /** When the CURRENT failure streak began. null when not currently failing. */
  failingSince: number | null;
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  /** Whether the most recent failure looked like a lost connection rather than a rejected write. */
  connectionLevel: boolean;
}

/**
 * The shape folded into `GatewayStats.db`. Every field is a fact a prober can threshold without
 * knowing anything about the gateway's internals.
 */
export interface DbHealthSnapshot {
  /** The alarmable verdict: false = at least one durable path has been failing long enough and
   *  often enough that its subsystem is inert. `/healthz` degrades on this. */
  ok: boolean;
  /** No outcome has been recorded yet (a just-booted gateway). `ok` is true here — absence of
   *  evidence must not read as a fault — but a consumer that wants to distinguish "healthy" from
   *  "hasn't looked yet" can. */
  observed: boolean;
  /** True when the most recent failures look connection-level (the DB is GONE) rather than a
   *  write being rejected by a reachable DB. */
  connectionLevel: boolean;
  /** The longest live failure streak across all ops. */
  consecutiveFailures: number;
  /** Ops currently in a failure streak, longest-running first. */
  failingOps: DbOp[];
  /** How long the oldest live failure streak has been running, ms. null when nothing is failing. */
  unhealthyForMs: number | null;
  /** Most recent success across all ops. */
  lastOkAt: number | null;
  /** Most recent failure across all ops. */
  lastFailureAt: number | null;
  /** Most recent failure message (truncated). The one line a human needs. */
  lastError: string | null;
  /** Per-op detail, for a reader diagnosing WHICH subsystem is inert. */
  ops: DbOpHealth[];
}

/** Fired on a TRANSITION only (healthy → unhealthy, unhealthy → healthy) — never per failure.
 *  launch.ts wires this to the durable escalation; the tracker itself stays IO-free. */
export type DbHealthTransitionHandler = (event: {
  healthy: boolean;
  snapshot: DbHealthSnapshot;
}) => void;

const state = new Map<DbOp, DbOpHealth>();
let transitionHandler: DbHealthTransitionHandler | undefined;
let lastVerdict = true;

function blank(op: DbOp): DbOpHealth {
  return {
    op,
    consecutiveFailures: 0,
    failingSince: null,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    connectionLevel: false,
  };
}

function entry(op: DbOp): DbOpHealth {
  let e = state.get(op);
  if (!e) {
    e = blank(op);
    state.set(op, e);
  }
  return e;
}

/**
 * Does this error mean the DB is UNREACHABLE (as opposed to reachable-but-rejecting)? Matched on
 * the message because the driver surfaces these as plain `Error`s with varying `code` handling,
 * and a false negative here only downgrades the label — never the `ok` verdict, which counts
 * every failure kind.
 */
export function isConnectionLevelError(err: unknown): boolean {
  const msg = errText(err).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('ehostunreach') ||
    msg.includes('enetunreach') ||
    msg.includes('enotfound') ||
    msg.includes('epipe') ||
    msg.includes('connection terminated') ||
    msg.includes('connection ended') ||
    msg.includes('connection closed') ||
    msg.includes('server closed the connection') ||
    msg.includes('terminating connection') ||
    msg.includes('the database system is starting up') ||
    msg.includes('the database system is shutting down') ||
    msg.includes('too many clients') ||
    msg.includes('connect_timeout') ||
    msg.includes('timeout expired')
  );
}

function errText(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  try {
    return String((err as { message?: unknown }).message ?? err);
  } catch {
    return '';
  }
}

/**
 * Record one durable-path outcome. Call on BOTH success and failure — the success path is what
 * clears a streak, so an instrumented op that only reports failures would latch the alarm on
 * forever after one blip.
 *
 * Never throws: every call site is inside a fire-and-forget `.catch()` whose entire contract is
 * that it cannot propagate.
 */
export function recordDbOutcome(op: DbOp, ok: boolean, err?: unknown, nowMs?: number): void {
  try {
    const now = nowMs ?? Date.now();
    const e = entry(op);
    if (ok) {
      e.consecutiveFailures = 0;
      e.failingSince = null;
      e.lastOkAt = now;
      e.lastError = null;
      e.connectionLevel = false;
    } else {
      e.consecutiveFailures += 1;
      e.failingSince ??= now;
      e.lastFailureAt = now;
      e.lastError = errText(err).slice(0, 300) || 'unknown error';
      e.connectionLevel = isConnectionLevelError(err);
    }
    emitTransitionIfChanged(now);
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Is this op's streak both long enough and old enough to count as unhealthy? */
function opUnhealthy(e: DbOpHealth, now: number): boolean {
  if (e.consecutiveFailures < FAILURE_STREAK) return false;
  if (e.failingSince === null) return false;
  return now - e.failingSince >= SUSTAIN_MS;
}

/** The current health snapshot. Pure — safe to call from `stats()` on every request. */
export function dbHealthSnapshot(nowMs?: number): DbHealthSnapshot {
  const now = nowMs ?? Date.now();
  const ops = [...state.values()];
  const failing = ops.filter((e) => e.consecutiveFailures > 0 && e.failingSince !== null);
  failing.sort((a, b) => (a.failingSince ?? 0) - (b.failingSince ?? 0));
  const unhealthy = ops.filter((e) => opUnhealthy(e, now));
  const oldestFailingSince = failing.length ? failing[0].failingSince : null;
  const lastOkAt = ops.reduce<number | null>((m, e) => (e.lastOkAt !== null && (m === null || e.lastOkAt > m) ? e.lastOkAt : m), null);
  const lastFailureAt = ops.reduce<number | null>(
    (m, e) => (e.lastFailureAt !== null && (m === null || e.lastFailureAt > m) ? e.lastFailureAt : m),
    null,
  );
  const mostRecentFailure = ops
    .filter((e) => e.lastFailureAt !== null && e.lastError !== null)
    .sort((a, b) => (b.lastFailureAt ?? 0) - (a.lastFailureAt ?? 0))[0];
  return {
    ok: unhealthy.length === 0,
    observed: ops.some((e) => e.lastOkAt !== null || e.lastFailureAt !== null),
    // Only claim "the DB is gone" while something is ACTUALLY failing — a stale flag from a
    // recovered episode would misdescribe a healthy gateway.
    connectionLevel: failing.length > 0 && failing.some((e) => e.connectionLevel),
    consecutiveFailures: ops.reduce((m, e) => Math.max(m, e.consecutiveFailures), 0),
    failingOps: failing.map((e) => e.op),
    unhealthyForMs: oldestFailingSince === null ? null : now - oldestFailingSince,
    lastOkAt,
    lastFailureAt,
    lastError: mostRecentFailure?.lastError ?? null,
    ops: ops.map((e) => ({ ...e })),
  };
}

/** Register the transition handler (launch.ts wires the durable escalation). One handler; a
 *  second registration replaces the first. Pass `undefined` to clear. */
export function setDbHealthTransitionHandler(handler: DbHealthTransitionHandler | undefined): void {
  transitionHandler = handler;
}

function emitTransitionIfChanged(now: number): void {
  const snap = dbHealthSnapshot(now);
  if (snap.ok === lastVerdict) return;
  lastVerdict = snap.ok;
  try {
    transitionHandler?.({ healthy: snap.ok, snapshot: snap });
  } catch {
    /* a broken handler must not break recording */
  }
}

/**
 * A streak can only advance when an op RUNS. `pool-reload` polls every 60s so it normally does,
 * but call this from a timer if you want the verdict re-evaluated (and a transition emitted) on
 * a schedule rather than only on the next outcome. Pure otherwise.
 */
export function reevaluateDbHealth(nowMs?: number): DbHealthSnapshot {
  const now = nowMs ?? Date.now();
  emitTransitionIfChanged(now);
  return dbHealthSnapshot(now);
}

/** Test-only — drop all recorded state + the handler. */
export function _resetDbHealth(): void {
  state.clear();
  transitionHandler = undefined;
  lastVerdict = true;
}
