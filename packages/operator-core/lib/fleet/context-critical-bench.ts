/**
 * context-critical-bench — P-009's claim-path half, wired to the canonical bench park.
 *
 * WHAT THIS CLOSES. `decideContextPressureGate` already REFUSES to serve a caller at
 * critical context pressure, and that refusal is correct and stays untouched. What it
 * does not do is observe what happens next: the refused member is told to compact and
 * left to re-pull on its own. A member with an armed loop simply re-fires into the same
 * refusal, so the lane shows an idle member, the leader sees no park, and nothing
 * converges. This module parks the refused member on its OWN recovery condition and
 * gives that park a deadline, so the state is visible and bounded either way.
 *
 * WAKE KEY — `session:compacted:<owner>`, a catalogued family (EVENT_CATALOG
 * 'session-compacted', exists:true) emitted when THAT session finishes a compaction.
 * It is the member's own recovery condition, it is per-owner so no peer's transition
 * wakes it, and — the property D-009 required — it cannot fire DURING the compaction
 * window, because it is what marks the end of one. The two keys D-009 explicitly ruled
 * out fail exactly that test: `work-item:claimable` re-wakes the member immediately
 * (it pulled BECAUSE work exists), and a fleet `controlResumeGate` reads null on an
 * active fleet, making a park on it a no-op dressed as a feature.
 *
 * DEADLINE — the recovery GUARANTEE, not a hint. If the member never compacts (it
 * crashed, or its host never fired the bridge), the deadline is the only thing that
 * brings it back, so it is never null here. That is the one place this caller
 * deliberately differs from a leader-driven bench, which may park indefinitely because
 * a leader is watching it.
 */
import { decideContextCriticalBench } from './member-recovery';
import { registerBenchPark, hasActiveBench, type BenchParkDeps } from './bench-park';
import type { ContextPressureBucket } from '../agent-tools/coordination/context-pressure';

/**
 * One compaction window plus slack. A carry-respawn settles in minutes; this bounds how
 * long a member that never compacts can stay parked before it is woken to try again.
 * Sized to be generous rather than tight: waking a member that IS mid-compaction costs
 * one wasted turn, while too long a deadline strands it, so the asymmetry favours slack.
 */
export const CONTEXT_CRITICAL_BENCH_TIMEOUT_SEC = 15 * 60;

export function contextCompactedWakeKey(ownerId: string): string {
  return `session:compacted:${ownerId}`;
}

export interface AutoBenchResult {
  benched: boolean;
  reason: string;
  wakeEvent: string | null;
  /** The await row's primary key — numeric, the same value fleet:bench reports as `bench_id`. */
  benchId?: number;
  expiresTs?: string | null;
  /** False when the park exists but has no wake handle — it will only resume on the deadline. */
  registered?: boolean;
}

/** Typed against the real functions — see the note on BenchParkDeps for why. */
export interface AutoBenchDeps {
  listParkedAwaitsForSubscribers: (
    ids: readonly string[],
  ) => Promise<ReadonlyArray<{ subscriberId: string; eventKey: string; note: string | null }>>;
  registerBenchPark: typeof registerBenchPark;
  captureWakeHandleForOwner: BenchParkDeps['captureWakeHandleForOwner'];
  registerAwait: BenchParkDeps['registerAwait'];
}

/**
 * Park a refused critical-context caller. NEVER throws and never rethrows: the caller's
 * refusal is the load-bearing result and must ship whether or not this succeeds.
 *
 * Fail-CLOSED on bench, fail-OPEN on work — the same asymmetry the gate itself uses. An
 * unreadable await table is treated as "may already be benched" and skips the park,
 * because double-parking a member is worse than not parking it: the refusal alone still
 * leaves it exactly as well off as it was before this module existed.
 */
export async function autoBenchContextCriticalCaller(
  input: { ownerId: string; bucket: ContextPressureBucket | null },
  deps: AutoBenchDeps,
): Promise<AutoBenchResult | null> {
  try {
    let alreadyBenched: boolean;
    try {
      const rows = await deps.listParkedAwaitsForSubscribers([input.ownerId]);
      alreadyBenched = hasActiveBench(rows, input.ownerId);
    } catch {
      // Unreadable — assume benched rather than risk a second park.
      return { benched: false, reason: 'bench state unreadable; skipped rather than double-park', wakeEvent: null };
    }

    const wakeEvent = contextCompactedWakeKey(input.ownerId);
    const decision = decideContextCriticalBench({
      claimRefused: true,
      bucket: input.bucket,
      wakeEvent,
      alreadyBenched,
    });
    if (!decision.bench) {
      return { benched: false, reason: decision.reason, wakeEvent: null };
    }

    const park = await deps.registerBenchPark(
      {
        member: input.ownerId,
        eventKey: decision.wakeEvent ?? wakeEvent,
        // An auto-bench stages NO assignment — the member resumes on the claims it
        // already holds. Staging is a leader's act.
        stagedAssignment: '',
        timeoutSec: CONTEXT_CRITICAL_BENCH_TIMEOUT_SEC,
        // The one thing an auto-bench must never do: a leader may have parked this
        // member on a gate with a staged assignment, and superseding it here would
        // silently destroy that staging with the leader never learning of it.
        supersedePriorBenches: false,
      },
      {
        captureWakeHandleForOwner: deps.captureWakeHandleForOwner,
        registerAwait: deps.registerAwait,
      },
    );

    return {
      benched: true,
      reason: decision.reason,
      wakeEvent: park.eventKey,
      benchId: park.benchId,
      expiresTs: park.expiresTs,
      registered: park.registered,
    };
  } catch (error) {
    return {
      benched: false,
      reason: `bench registration failed (refusal unaffected): ${error instanceof Error ? error.message : String(error)}`,
      wakeEvent: null,
    };
  }
}
