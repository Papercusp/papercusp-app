/**
 * wake-bridge.ts — the B-07 ↔ B-04 wake seam (overwatch-role-2026-06-15).
 *
 * B-07 (`kettle:start` / `kettle:pause`) owns the control STATE
 * (control-state.ts) but NOT the wake-launch — that is B-04 (C-3: the invoke path
 * that spawns role=overwatch with its computed brief injected, plus the
 * declare-next-wake). To let the control tools request an immediate wake (on
 * start) / clear a pending one (on pause) WITHOUT a hard compile-time dependency
 * on the not-yet-landed loop module, B-04 REGISTERS its waker here at boot and the
 * control tools call through this seam.
 *
 * Until B-04 wires it, every call is a fail-soft no-op (`{ wired: false }`) — the
 * started bit + cadence (control-state.ts) are the durable truth the loop and
 * watchdog gate on regardless, exactly how the hive watchdog re-arms a wake
 * purely from `hive_started`. So B-07 is fully functional + testable today, and
 * lights up the moment B-04 calls `registerOverwatchWaker(...)`.
 *
 * This is a boot-time DI seam (a function pointer wired once at module load), not
 * durable state — it is NOT a storage-policy violation (cf. the watchdog's `deps`
 * injection).
 */

/** Request payload for an immediate overwatch wake. */
export interface OverwatchWakeRequest {
  /** Why the overwatch is being woken — becomes the kickoff context. */
  reason: string;
  /** The hive home-harness slug the overwatch supervises (D-005, per-hive). */
  harness: string;
  workspaceId: string;
}

/** Target for clearing a pending overwatch wake. */
export interface OverwatchWakeTarget {
  harness: string;
  workspaceId: string;
}

/** The waker B-04 registers — the live wake-launch + pending-wake clear. */
export interface OverwatchWaker {
  /** Fire / coalesce an overwatch wake now (the start-responsiveness path). */
  requestWake(req: OverwatchWakeRequest): Promise<unknown>;
  /** Clear any pending/scheduled overwatch time-wake (the pause path). */
  clearWake(target: OverwatchWakeTarget): Promise<unknown>;
}

/** Result of a seam call: whether a waker was wired, and its outcome/error. */
export interface OverwatchWakeOutcome {
  /** False ⇒ B-04 has not registered a waker yet; the call was a no-op. */
  wired: boolean;
  result?: unknown;
  /** A wired waker that threw — swallowed (the control tool must not fail on it). */
  error?: string;
}

let registered: OverwatchWaker | null = null;

/**
 * B-04 calls this at module load to plug in the real wake-launch. Pass `null` to
 * unregister (test teardown / hot-reload).
 */
export function registerOverwatchWaker(waker: OverwatchWaker | null): void {
  registered = waker;
}

/** Whether a live waker is wired (B-04 landed + registered). */
export function isOverwatchWakerWired(): boolean {
  return registered !== null;
}

/** Request an immediate overwatch wake through the seam — fail-soft, never throws. */
export async function requestOverwatchWake(req: OverwatchWakeRequest): Promise<OverwatchWakeOutcome> {
  if (!registered) return { wired: false };
  try {
    return { wired: true, result: await registered.requestWake(req) };
  } catch (e) {
    return { wired: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Clear a pending overwatch wake through the seam — fail-soft, never throws. */
export async function clearOverwatchWake(target: OverwatchWakeTarget): Promise<OverwatchWakeOutcome> {
  if (!registered) return { wired: false };
  try {
    return { wired: true, result: await registered.clearWake(target) };
  } catch (e) {
    return { wired: true, error: e instanceof Error ? e.message : String(e) };
  }
}
