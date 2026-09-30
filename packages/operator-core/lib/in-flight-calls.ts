/**
 * In-flight tool-call registry — "is this agent executing RIGHT NOW, or idle?"
 *
 * WHY THIS EXISTS (EI-21548894457555139). `harness_shared.tool_invocations` is
 * written only when a call SETTLES. That is the correct shape for a ledger, but it
 * means the single most operationally useful question a fleet leader asks has no
 * instrument at all: a member sitting idle and a member 20 minutes into one long
 * call produce the SAME observable — no recent invocation row, presence 'parked'
 * (the normal state between turns), and a loop whose last turn is minutes old.
 * Reading that pair as "idle" is what produced a `dormant:true` verdict and a
 * `laneless-idle` bench suggestion for a member that was working hard.
 *
 * WHAT MAKES THIS CORRECT RATHER THAN A GUESS: every agent's MCP calls dispatch
 * through the operator process that also serves `fleet:leader-brief`, so a leader
 * reading this registry is reading its peers' real dispatch state, not an inference
 * from staleness. The registry is authoritative for the question and needs no DB
 * round-trip to answer it.
 *
 * ⚠ SCOPE CAVEAT, deliberately not papered over: this is PROCESS-LOCAL state. It
 * does not span two operator processes (:3070 release vs :3170 staging), and it is
 * empty after an operator restart. Both are acceptable — a call in flight across a
 * restart dies with the restart, so there is nothing to report — but a consumer must
 * read an empty registry as "nothing observed here", never as "every agent is idle".
 *
 * ⚠ AND THE FAILURE MODE THAT MATTERS MORE: a LEAKED entry is worse than a missing
 * one, because it actively asserts a call is running when it is not. The dispatcher
 * does not guarantee a settle for every start — `recordTelemetry` returns early for a
 * non-gate-denial call with no window key, so `recordInvocation` (where the settle
 * lands) is never reached. Rather than grow a new generic dispatch seam for that edge,
 * every read here is bounded by MAX_ENTRY_AGE_MS and the map is swept on write, so a
 * missed settle self-heals and can never accumulate. See `getLongCallsInFlight`.
 */
import { pinModuleState } from '@papercusp/module-singleton';

export interface InFlightCall {
  callId: string;
  toolName: string;
  /** coord ownerId of the agent that made the call, when the ctx carried one. */
  ownerId: string | null;
  spawnId: string | null;
  startedAt: number;
}

export interface LongCallInFlight {
  ownerId: string | null;
  toolName: string;
  ageSec: number;
  startedAt: string;
}

/**
 * Hard ceiling on how long an entry is believed. Generous on purpose: a real call
 * CAN run for a very long time here (a full affected-tests suite dispatched through
 * `testing:run` runs ~55 min), so a tight ceiling would erase exactly the long calls
 * this registry exists to reveal. Its job is only to stop a leaked entry from being
 * reported — and from being retained — forever.
 */
const MAX_ENTRY_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Belt-and-braces memory bound. The registry is normally tiny (one entry per call
 * actually in flight, which is a handful even under fleet load), so hitting this cap
 * means entries are leaking faster than the age sweep clears them; drop the oldest
 * rather than grow without limit.
 */
const MAX_ENTRIES = 2000;

interface InFlightState {
  calls: Map<string, InFlightCall>;
}

// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair: a hand-rolled pin still fixes correctness, but
// its key is invisible to listModuleDuplications(), which then reports a confident
// `[]` while this module is split — and a SPLIT registry is silently wrong here
// (writers land in one record, the leader's read in the other, so every agent reads
// as idle). `npm run lint:no-hand-rolled-module-pin` enforces this.
const __inFlight = pinModuleState<InFlightState>(
  '@papercusp/operator-core.inFlightCalls',
  () => ({ calls: new Map<string, InFlightCall>() }),
);

/** Drop entries too old to be credible, then enforce the size cap. */
function sweep(now: number): void {
  const { calls } = __inFlight;
  for (const [id, entry] of calls) {
    if (now - entry.startedAt > MAX_ENTRY_AGE_MS) calls.delete(id);
  }
  if (calls.size > MAX_ENTRIES) {
    const oldestFirst = [...calls.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (let i = 0; i < oldestFirst.length - MAX_ENTRIES; i += 1) {
      calls.delete(oldestFirst[i][0]);
    }
  }
}

/**
 * Open an in-flight entry. Called from `onDispatchStart` — before any gate or
 * handler step, so a call is visible for the whole time it can possibly be running.
 *
 * Best-effort by contract: this runs inside the dispatcher's swallow-everything
 * start hook, so it must never throw in a way that could change a tool result.
 */
export function beginInFlightCall(entry: {
  callId: string;
  toolName: string;
  ownerId?: string | null;
  spawnId?: string | null;
  startedAt?: number;
}): void {
  const startedAt = entry.startedAt ?? Date.now();
  sweep(startedAt);
  __inFlight.calls.set(entry.callId, {
    callId: entry.callId,
    toolName: entry.toolName,
    ownerId: entry.ownerId ?? null,
    spawnId: entry.spawnId ?? null,
    startedAt,
  });
}

/**
 * Close the entry this call opened. Idempotent, and a no-op for an unknown id — a
 * call that never opened an entry (no start hook, or a `replayed` call that returned
 * before dispatch) must not be an error here.
 */
export function endInFlightCall(callId: string | undefined | null): void {
  if (!callId) return;
  __inFlight.calls.delete(callId);
}

/**
 * Calls that have been running longer than `thresholdMs` — the exception-only read a
 * leader-brief surfaces. Returns nothing for the overwhelming majority of calls,
 * which settle in milliseconds.
 *
 * Entries older than MAX_ENTRY_AGE_MS are excluded AND deleted: see the leak note in
 * this module's header. That makes the read self-healing, so a missed settle degrades
 * to a bounded window of over-reporting rather than a permanent false "still running".
 */
export function getLongCallsInFlight(thresholdMs: number, now: number = Date.now()): LongCallInFlight[] {
  sweep(now);
  const out: LongCallInFlight[] = [];
  for (const entry of __inFlight.calls.values()) {
    const ageMs = now - entry.startedAt;
    if (ageMs < thresholdMs) continue;
    out.push({
      ownerId: entry.ownerId,
      toolName: entry.toolName,
      ageSec: Math.round(ageMs / 1000),
      startedAt: new Date(entry.startedAt).toISOString(),
    });
  }
  // Longest-running first: that is the order a reader triages in.
  out.sort((a, b) => b.ageSec - a.ageSec);
  return out;
}

/** Everything currently open. Diagnostics/tests; consumers want getLongCallsInFlight. */
export function listInFlightCalls(now: number = Date.now()): InFlightCall[] {
  sweep(now);
  return [...__inFlight.calls.values()];
}

/**
 * Reset between tests THROUGH the module's own seam.
 *
 * Do not reach for `globalThis[Symbol.for(...)]` in a test: that targets the storage
 * LOCATION rather than this module's state, so it keeps compiling and silently resets
 * NOTHING the moment the state moves (EI-19479108855357092).
 */
export function __resetInFlightCallsForTest(): void {
  __inFlight.calls.clear();
}
