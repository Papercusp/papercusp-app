/**
 * lib/p2p/push-nudge-service.ts — P-303 LIVE-WIRING layer (WI-1978).
 *
 * A per-publisher orchestrator that OWNS the long-lived M9 rate-cap + per-fleet
 * coalescer state and dispatches a push-nudge on each offer-available event, plus a
 * coord-backed {@link NudgeWaker} factory. The pure decision/cap logic stays in
 * push-nudge.ts; this only holds the state that must persist ACROSS events.
 *
 * DORMANT BY CONSTRUCTION: nothing calls `onOfferAvailable` on a live offer path yet
 * (the publisher emit + the opted-in-receiver resolution are the LIVE-2 seams). So no
 * flag, no migration — the publisher is instantiated only when the live wiring lands.
 */

import {
  dispatchPullerNudge,
  createNudgeRateLimiter,
  createNudgeCoalescer,
  type NudgeWaker,
  type NudgeTarget,
  type PullerNudge,
  type OfferAvailableSignal,
  type NudgeCoalescer,
  type NudgeDispatchResult,
} from './push-nudge';
import type { RateLimiter, SoftBucketConfig } from '@papercusp/rate-limit';

export interface PushNudgePublisherDeps {
  now(): number;
  /** The live NudgeWaker (coord wake). Omit ⇒ dispatch falls back to the registered
   *  seam (registerNudgeWaker); null ⇒ explicit no-op. */
  waker?: NudgeWaker | null;
  cap?: SoftBucketConfig;
  coalesceWindowMs?: number;
  /** Share one rate limiter across publishers on a host (default: a fresh in-process
   *  one). The M9 cap is per grantor, so a shared limiter caps a grantor across all
   *  its fleets on this host. */
  limiter?: RateLimiter;
}

/**
 * Holds the per-publisher rate-cap + coalescer and turns an offer-available event
 * into an optimistic, rate-capped, coalesced wake of the opted-in receivers.
 */
export class PushNudgePublisher {
  private readonly limiter: RateLimiter;
  private readonly coalescer: NudgeCoalescer = createNudgeCoalescer();

  constructor(private readonly deps: PushNudgePublisherDeps) {
    this.limiter = deps.limiter ?? createNudgeRateLimiter(deps.cap);
  }

  /** Nudge the opted-in receivers that an offer became available. Never throws —
   *  a nudge failure is latency, never correctness (the puller's poll delivers). */
  onOfferAvailable(
    signal: OfferAvailableSignal,
    receiverTargets: readonly NudgeTarget[],
  ): Promise<NudgeDispatchResult> {
    return dispatchPullerNudge({
      signal,
      receiverTargets,
      limiter: this.limiter,
      coalescer: this.coalescer,
      nowMs: this.deps.now(),
      coalesceWindowMs: this.deps.coalesceWindowMs,
      waker: this.deps.waker,
    });
  }
}

/**
 * Build a {@link NudgeWaker} over an injected coord-wake fn. In the live wiring
 * `sendWake` is a coord:send with wake:'optimistic' targeted at the receiver's
 * standing-puller session — optimistic is correct because the nudge is advisory and
 * the puller's own poll is the durable backstop (a missed wake only costs latency).
 */
export function coordNudgeWaker(
  sendWake: (nudge: PullerNudge, target: NudgeTarget) => Promise<unknown>,
): NudgeWaker {
  return { wake: (nudge, target) => sendWake(nudge, target) };
}
