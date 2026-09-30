/**
 * event-loop-sentinel.ts — detect a BLOCKED main event loop from OFF the loop.
 *
 * Sibling of `memory-watchdog.ts`, and deliberately placed beside it: they are
 * the two halves of "the host stopped serving". The watchdog bounds RSS; this
 * bounds *liveness*. Neither subsumes the other, and this file exists because
 * we proved the watchdog cannot cover this case.
 *
 * ## Why this is not the memory watchdog (measured, EI-19465075959589134)
 *
 * `papercup-staging-api.service` (:3170) blocked its event loop at
 * 2026-08-03 16:14:17Z and stayed wedged 30+ min. It was tempting — and wrong —
 * to call this memory pressure. The wedged pid's own journal, over the 19 min
 * before the block:
 *
 *     16:09:17  rssMb 3156      16:11:47  rssMb 2844
 *     16:09:47  rssMb 3014      16:13:47  rssMb 2013   <- below warnMb=2400
 *     16:10:17  rssMb 2829      16:14:17  WEDGE
 *
 * It wedged at **2013 MiB** — a third of its 3200 MiB limit, under the soft
 * warn line, and *falling*. An off-thread RSS sampler would have reported a
 * perfectly healthy host. The signal that separates wedged from healthy is not
 * memory; it is whether the loop is still turning.
 *
 * ## The fate-sharing defect this fixes
 *
 * `memory-watchdog.ts` samples via `managedSetInterval` — a timer ON the very
 * event loop whose blockage is the failure it ultimately exists to prevent (its
 * own header names multi-second GC stalls as the thing that "intermittently
 * broke everything"). When the loop blocks, the watchdog's callback stops
 * firing too. A detector that shares fate with the thing it detects is not a
 * detector. So this one runs on a `worker_threads` Worker, which has its own
 * event loop and is unaffected by a block on the main thread.
 *
 * ## Why a COUNTER in shared memory, not a timestamp, and not postMessage
 *
 * - **Not `postMessage`**: the reply would be queued on the blocked loop. A
 *   liveness probe that needs the subject to answer cannot detect a subject
 *   that has stopped answering.
 * - **Not a wall-clock timestamp**: `Date.now()` deltas across an NTP step
 *   would manufacture staleness out of nothing and could kill a healthy host.
 * - **A monotonically incrementing counter in a `SharedArrayBuffer`**: the main
 *   thread bumps it via `Atomics.store` from a timer; the sentinel reads it via
 *   `Atomics.load`. The only shared fact is *"did it move?"*. All timing is
 *   measured in the sentinel's OWN clock, so cross-thread clock skew and wall
 *   clock jumps are structurally out of scope rather than handled.
 *
 * Reported staleness is therefore a LOWER BOUND (time since the sentinel
 * observed a change, not since the change happened). That error is in the safe
 * direction: it under-reports, so it can only ever delay a kill, never hasten
 * one.
 *
 * This module is the PURE decision core — no timers, no clocks, no signals, no
 * worker. Everything that can kill a process is a caller's concern, so the
 * decision itself stays exhaustively testable. Keep it that way.
 */

/**
 * Layout of the sentinel's SharedArrayBuffer. Index 0 is the heartbeat counter
 * the main thread bumps every `heartbeatIntervalMs` (the sentinel's core
 * liveness signal). Indices 1-4 are LAST-KNOWN loop-lag percentiles (rounded
 * ms), published by `event-loop-lag-monitor.ts` on its own timer.
 *
 * WHY: the lag monitor's reader shares fate with the loop it watches (see that
 * file's header) — during an actual wedge it never runs again, so it cannot
 * report the one number that would explain the incident. But the LAST value it
 * read before the block began is still informative, and the sentinel's worker
 * thread keeps running through the block. So the lag monitor publishes into
 * this same SAB on every tick (a plain `Atomics.store`, no reply needed — this
 * is push, not the postMessage round-trip the file header rules out), and the
 * worker reads it via `Atomics.load` at the moment it decides to warn or kill,
 * turning a silent wedge into "last observed p95 lag Xms, N ms before this
 * kill" instead of nothing at all.
 *
 * Both ends import this module for the indices so the layout cannot drift
 * between publisher and reader.
 */
export const SENTINEL_SAB_INT32_LEN = 5;
export const SENTINEL_SAB_IDX = {
  HEARTBEAT: 0,
  LAG_P50_MS: 1,
  LAG_P95_MS: 2,
  LAG_P99_MS: 3,
  LAG_MAX_MS: 4,
} as const;

/** Tunables for the sentinel's decision. All times in milliseconds. */
export interface LoopSentinelThresholds {
  /**
   * How stale the heartbeat must be before the loop counts as WEDGED.
   * Must comfortably exceed the main thread's heartbeat interval — a loop is
   * routinely busy for tens of ms, and a GC pause of a second or two is normal
   * under load and self-recovers. This is the "seconds, not milliseconds" line.
   */
  wedgeAfterMs: number;
  /**
   * Consecutive WEDGED observations before acting. Debounce: a single long
   * synchronous task (a big JSON.stringify, a mark-compact) must not recycle a
   * host that is about to come back.
   */
  observationsToAct: number;
  /**
   * Grace period after the sentinel starts, during which it never acts. Boot
   * is legitimately busy and the heartbeat may not be armed yet.
   */
  startupGraceMs: number;
  /**
   * Staleness at which to emit a warning (observability only, never acts).
   * Default behaviour when omitted: half of `wedgeAfterMs`.
   */
  warnAfterMs?: number;
}

/** Sentinel state carried between observations. Immutable — the decider returns a new one. */
export interface LoopSentinelState {
  /** Heartbeat counter value at the last observation. */
  lastCounter: number;
  /** Sentinel-local clock reading when the counter was last seen to CHANGE. */
  lastChangeAtMs: number;
  /** Consecutive observations at or past `wedgeAfterMs`. */
  consecutiveStale: number;
  /** Sentinel-local clock reading when the sentinel started. */
  startedAtMs: number;
  /**
   * Has the counter EVER been observed to move?
   *
   * Load-bearing safety property — see `decideLoopSentinelAction`. A counter
   * that has never moved cannot distinguish "the loop wedged before we started
   * watching" from "the heartbeat was never wired up / failed to arm". Killing
   * on the second reading would turn a defect in THIS module into a boot loop
   * for the whole host, which is strictly worse than the wedge it prevents.
   */
  sawHeartbeat: boolean;
}

/** One reading, taken by the sentinel on its own timer. */
export interface LoopSentinelObservation {
  /** The heartbeat counter, as read from shared memory this tick. */
  counter: number;
  /** The sentinel's OWN monotonic clock reading for this tick. */
  nowMs: number;
}

export type LoopSentinelAction =
  /** Loop is turning (or stale but within tolerance). Nothing to do. */
  | { kind: 'ok'; stalenessMs: number }
  /** Within the post-start grace window — never acts, however stale. */
  | { kind: 'grace'; stalenessMs: number }
  /** Stale past `warnAfterMs` but not yet actionable. Log it. */
  | { kind: 'warn'; stalenessMs: number; consecutiveStale: number }
  /**
   * Wedged, but the heartbeat has NEVER been observed to move, so we cannot
   * tell a wedged loop from an unarmed heartbeat. Escalate loudly; never kill.
   * The external probe (`dev:service_health`, which reads unaccepted
   * connections off the LISTEN socket from a DIFFERENT process) is the correct
   * detector for a host that was never alive.
   */
  | { kind: 'escalate-never-started'; stalenessMs: number; consecutiveStale: number }
  /** Wedged past every threshold, with a confirmed prior heartbeat. Kill. */
  | { kind: 'kill'; stalenessMs: number; consecutiveStale: number; reason: string };

export interface LoopSentinelDecision {
  state: LoopSentinelState;
  action: LoopSentinelAction;
}

/** Fresh state for a sentinel starting at `nowMs` with the counter reading `counter`. */
export function initialLoopSentinelState(
  nowMs: number,
  counter: number,
): LoopSentinelState {
  return {
    lastCounter: counter,
    lastChangeAtMs: nowMs,
    consecutiveStale: 0,
    startedAtMs: nowMs,
    sawHeartbeat: false,
  };
}

const resolveWarnAfterMs = (t: LoopSentinelThresholds): number =>
  t.warnAfterMs ?? Math.floor(t.wedgeAfterMs / 2);

/**
 * The whole decision, as a pure reducer. No clocks, no I/O, no side effects —
 * `nowMs` and `counter` are supplied by the caller, so every branch below is
 * reachable from a test with plain numbers.
 *
 * Ordering of the guards is deliberate and is the safety argument:
 *
 *  1. A counter that MOVED is unconditionally healthy — checked first, so no
 *     later branch can act on a loop that is demonstrably turning.
 *  2. The startup grace window suppresses everything — checked before any
 *     staleness maths, so boot can never kill.
 *  3. `sawHeartbeat === false` downgrades a kill to an escalation — checked
 *     before the kill branch, so a miswired heartbeat can never kill.
 *  4. Only then can staleness + debounce produce a kill.
 *
 * Each guard is a strict narrowing of the previous one, so adding a threshold
 * later cannot accidentally widen what kills.
 */
export function decideLoopSentinelAction(
  state: LoopSentinelState,
  obs: LoopSentinelObservation,
  thresholds: LoopSentinelThresholds,
): LoopSentinelDecision {
  // (1) The counter moved: the loop is turning. Unconditionally healthy —
  // reset the debounce and latch `sawHeartbeat` so future wedges are killable.
  if (obs.counter !== state.lastCounter) {
    return {
      state: {
        ...state,
        lastCounter: obs.counter,
        lastChangeAtMs: obs.nowMs,
        consecutiveStale: 0,
        sawHeartbeat: true,
      },
      action: { kind: 'ok', stalenessMs: 0 },
    };
  }

  // Staleness is measured entirely in the sentinel's own clock: time since WE
  // observed a change. A lower bound on true staleness, erring safe.
  const stalenessMs = Math.max(0, obs.nowMs - state.lastChangeAtMs);

  // (2) Startup grace: boot is legitimately busy, and the heartbeat timer may
  // not be armed yet. Never act, however stale it looks.
  if (obs.nowMs - state.startedAtMs < thresholds.startupGraceMs) {
    return { state, action: { kind: 'grace', stalenessMs } };
  }

  // Not yet wedged. Reset the debounce — a run of near-misses must not
  // accumulate into a kill; only CONSECUTIVE wedged observations count.
  if (stalenessMs < thresholds.wedgeAfterMs) {
    const next = { ...state, consecutiveStale: 0 };
    return stalenessMs >= resolveWarnAfterMs(thresholds)
      ? { state: next, action: { kind: 'warn', stalenessMs, consecutiveStale: 0 } }
      : { state: next, action: { kind: 'ok', stalenessMs } };
  }

  const consecutiveStale = state.consecutiveStale + 1;
  const next = { ...state, consecutiveStale };

  // Debounce not yet satisfied — wedged, but give it another tick to recover.
  if (consecutiveStale < thresholds.observationsToAct) {
    return { state: next, action: { kind: 'warn', stalenessMs, consecutiveStale } };
  }

  // (3) The safety guard. We are past every threshold, but if the heartbeat has
  // NEVER moved we cannot distinguish a wedged loop from an unarmed heartbeat,
  // and killing on the latter converts a bug in this module into a host boot
  // loop. Escalate instead; the out-of-process probe covers never-started.
  if (!state.sawHeartbeat) {
    return {
      state: next,
      action: { kind: 'escalate-never-started', stalenessMs, consecutiveStale },
    };
  }

  // (4) Confirmed: the loop was turning, then stopped, and has stayed stopped
  // across the debounce. This is the wedge.
  return {
    state: next,
    action: {
      kind: 'kill',
      stalenessMs,
      consecutiveStale,
      reason:
        `event loop blocked ${stalenessMs}ms (>= ${thresholds.wedgeAfterMs}ms) ` +
        `across ${consecutiveStale} consecutive observations after a confirmed heartbeat`,
    },
  };
}
