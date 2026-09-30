/**
 * lib/p2p/push-nudge.ts — P-303 (p2p-work-distribution-2026-07-02): PUSH-AS-NUDGE.
 *
 * The standing puller (P-103) is the CORRECTNESS path: it pulls available offers
 * on its OWN schedule regardless of any push. Push-as-nudge is a pure LATENCY
 * optimization — when an offer becomes available for a fleet, the publisher host
 * optimistically WAKES the opted-in receiver's standing puller (via the wake
 * bridge) so it pulls NOW instead of at its next poll tick.
 *
 * INVARIANTS — why a nudge can NEVER affect correctness:
 *   - LATENCY ONLY: a nudge that is dropped, rate-capped, lost, duplicated, or
 *     delayed changes only WHEN the puller runs — never WHETHER or WHAT it pulls.
 *     The receiver re-derives the whole pull decision from the (re-fetched,
 *     re-validated) offer via standing-puller `evaluatePull`; this module never
 *     imports that decision. So dropping every nudge degrades latency, never
 *     safety (the poll still delivers the offer).
 *   - ADVISORY PAYLOAD: the nudge body is DATA, never a claim. A forged/hostile
 *     nudge can at worst trigger one extra (rate-capped) pull evaluation — cheap
 *     and safe (H17: the puller is deterministic host-authority code that
 *     re-validates the offer itself).
 *   - M9 WAKE-DoS CAP: wake is a token-burning DoS vector, so nudges are
 *     rate-capped PER GRANTOR (the peer whose grant authorizes the fleet), metered
 *     SEPARATELY from the pull path — reusing the generic `@papercusp/rate-limit`
 *     soft bucket keyed `nudge:<grantorRef>` over an IN-PROCESS store (a hot wake
 *     path must not touch PG). Over-cap ⇒ the nudge is dropped; the puller's own
 *     poll still delivers the offer (latency, not loss).
 *   - COALESCE: a burst of offer-available signals for the SAME fleet within a
 *     short window collapses to ONE nudge (don't wake N times for one burst).
 *
 * The live emit is a DI seam ({@link registerNudgeWaker} / fail-soft no-op until
 * the cross-machine wake wires it, mirroring overwatch/wake-bridge.ts). The live
 * cross-machine wake + flag-gated cutover are a follow-up; the live proof is
 * P-305/LIVE-2. Pure decision helpers (coalesce, key derivation) are deterministic
 * (nowMs injected); the rate limiter uses its own clock by design.
 */

import {
  createRateLimiter,
  type RateLimiter,
  type SoftBucketConfig,
  type BucketStore,
  type BucketPayload,
} from '@papercusp/rate-limit';

/** Emitted by a publisher host when a fleet gains a claimable offer. */
export interface OfferAvailableSignal {
  /** The fleet the offer belongs to (H5 owner-prefixed slug). */
  fleetSlug: string;
  /** The grantor ref whose grant authorizes this fleet — the M9 rate-cap key. */
  grantorRef: string;
  /** ADVISORY hint only: the offer id. Data, never trusted as a claim — the
   *  receiver re-fetches + re-validates the offer (H17). */
  offerHintId?: string | null;
  /** Server-clock ms the offer became available. */
  availableAtMs: number;
}

/** The advisory wake-nudge delivered to a receiver's standing puller. */
export interface PullerNudge {
  fleetSlug: string;
  /** Advisory hint the receiver MAY use to prioritize WHICH offer to re-check; it
   *  is re-fetched + re-validated, never trusted (H17). null when absent. */
  offerHintId: string | null;
  reason: 'offer-available';
}

/** An opted-in receiver to wake — an opaque ref the live waker resolves to a
 *  session / host / coord recipient. This module treats it as an opaque token. */
export interface NudgeTarget {
  ref: string;
}

/** Why a nudge was NOT emitted (every reason is a SAFE latency-only drop). */
export type NudgeDropReason = 'no-receivers' | 'coalesced' | 'rate-capped';

export interface NudgeDispatchResult {
  fleetSlug: string;
  /** The advisory nudge that was (or would have been) sent; null on no-receivers. */
  nudge: PullerNudge | null;
  /** Target refs a wake was fired for. */
  emitted: string[];
  /** Non-fatal per-target wake errors (the seam swallows them; recorded for obs). */
  wakeErrors: { ref: string; error: string }[];
  /** Set when the whole dispatch was dropped (not emitted). */
  dropped: NudgeDropReason | null;
  /** Present on a 'rate-capped' drop — seconds until the grantor's cap refills. */
  retryAfterS?: number;
}

// ── M9 per-grantor wake rate-cap ────────────────────────────────────────────

/** Default M9 cap: at most 30 nudges per grantor per minute. Generous enough that
 *  a healthy publisher never hits it, tight enough that a wake-storm is capped —
 *  and correctness never depends on it (the puller's poll is the floor). */
export const DEFAULT_NUDGE_RATE_CAP: SoftBucketConfig = { windowMs: 60_000, capacity: 30 };

/** The soft-bucket key for a grantor's nudge cap (M9 — metered per grantor). */
export function nudgeRateCapKey(grantorRef: string): string {
  return `nudge:${grantorRef}`;
}

/** A minimal in-process {@link BucketStore} for the nudge cap — the hot wake path
 *  must not touch PG (cf. swarm-guard's per-connection limiter, D-004). Tracks a
 *  `touched` ms per key so `gcStale` can drop idle grantors. Self-contained (no
 *  transport-layer coupling); pass a custom store to share/federate the cap. */
export function createInMemoryNudgeStore(): BucketStore {
  const m = new Map<string, { payload: BucketPayload; touched: number }>();
  return {
    async read(key) {
      return m.get(key)?.payload ?? null;
    },
    async write(key, payload) {
      m.set(key, { payload, touched: Date.now() });
    },
    async delete(key) {
      m.delete(key);
    },
    async gcStale(olderThanMs) {
      for (const [k, v] of m) if (v.touched < olderThanMs) m.delete(k);
    },
    async clearPrefix(prefix) {
      for (const k of m.keys()) if (k.startsWith(prefix)) m.delete(k);
    },
  };
}

/** A nudge rate limiter over an in-process store (default). Inject a store to
 *  share/federate the cap across a host's publishers. */
export function createNudgeRateLimiter(cap: SoftBucketConfig = DEFAULT_NUDGE_RATE_CAP): RateLimiter {
  return createRateLimiter({ store: createInMemoryNudgeStore(), soft: cap });
}

// ── per-fleet coalescing (pure, nowMs-injected) ─────────────────────────────

export const DEFAULT_NUDGE_COALESCE_WINDOW_MS = 2_000;

/** Per-fleet last-nudge timestamps. A burst within the coalesce window collapses
 *  to one wake. Kept as a plain Map so the caller owns the lifetime. */
export interface NudgeCoalescer {
  lastNudgeMs: Map<string, number>;
}

export function createNudgeCoalescer(): NudgeCoalescer {
  return { lastNudgeMs: new Map() };
}

/** True when a nudge for `fleetSlug` should be COALESCED (dropped) because one was
 *  already emitted within `windowMs`. Pure predicate — does NOT record. */
export function isWithinCoalesceWindow(
  coalescer: NudgeCoalescer,
  fleetSlug: string,
  nowMs: number,
  windowMs: number = DEFAULT_NUDGE_COALESCE_WINDOW_MS,
): boolean {
  const last = coalescer.lastNudgeMs.get(fleetSlug);
  return last != null && nowMs - last < windowMs;
}

/** Record that a nudge was emitted for `fleetSlug` at `nowMs` (call only after a
 *  nudge is actually admitted, so a rate-capped burst doesn't suppress the next). */
export function recordNudge(coalescer: NudgeCoalescer, fleetSlug: string, nowMs: number): void {
  coalescer.lastNudgeMs.set(fleetSlug, nowMs);
}

/** Build the advisory nudge for an offer-available signal (pure). */
export function buildPullerNudge(signal: OfferAvailableSignal): PullerNudge {
  return {
    fleetSlug: signal.fleetSlug,
    offerHintId: signal.offerHintId ?? null,
    reason: 'offer-available',
  };
}

// ── DI-seam waker (mirrors overwatch/wake-bridge.ts) ─────────────────────────

/** The live cross-machine puller waker — registered at boot by the wake wiring.
 *  Until then every nudge is a fail-soft no-op (the poll still delivers). */
export interface NudgeWaker {
  /** Fire an optimistic wake at one receiver's standing puller. */
  wake(nudge: PullerNudge, target: NudgeTarget): Promise<unknown>;
}

export interface NudgeWakeOutcome {
  /** False ⇒ no waker registered yet; the call was a no-op (latency only). */
  wired: boolean;
  result?: unknown;
  /** A wired waker that threw — swallowed (a nudge failure must never break the
   *  publisher; correctness is the puller's poll). */
  error?: string;
}

let registeredWaker: NudgeWaker | null = null;

/** Register (or clear with null) the live nudge waker. Idempotent last-write-wins,
 *  like the overwatch wake-bridge seam. */
export function registerNudgeWaker(waker: NudgeWaker | null): void {
  registeredWaker = waker;
}

export function isNudgeWakerWired(): boolean {
  return registeredWaker != null;
}

/** Fire one nudge through the seam. Fail-soft: no waker ⇒ { wired:false }; a
 *  throwing waker ⇒ { wired:true, error } — never rejects. */
export async function requestPullerNudge(
  nudge: PullerNudge,
  target: NudgeTarget,
  waker: NudgeWaker | null = registeredWaker,
): Promise<NudgeWakeOutcome> {
  if (!waker) return { wired: false };
  try {
    const result = await waker.wake(nudge, target);
    return { wired: true, result };
  } catch (e) {
    return { wired: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── the composed dispatch ────────────────────────────────────────────────────

export interface DispatchPullerNudgeArgs {
  signal: OfferAvailableSignal;
  /** The opted-in receivers to wake (resolved by the caller — P-016/opt-in). */
  receiverTargets: readonly NudgeTarget[];
  /** M9 per-grantor cap (reused @papercusp/rate-limit soft bucket). */
  limiter: RateLimiter;
  /** Per-fleet coalescer state (caller owns its lifetime). */
  coalescer: NudgeCoalescer;
  nowMs: number;
  coalesceWindowMs?: number;
  /** Override the registered waker (tests / explicit wiring). */
  waker?: NudgeWaker | null;
}

/**
 * Dispatch a push-nudge for an offer-available signal: no-receivers → coalesce →
 * M9 per-grantor rate-cap → optimistic wake of every opted-in receiver. Every exit
 * is a structured result and this NEVER throws — a nudge failure must not break the
 * publisher (correctness is the receiver's standing-puller poll, not this path).
 */
export async function dispatchPullerNudge(args: DispatchPullerNudgeArgs): Promise<NudgeDispatchResult> {
  const { signal, receiverTargets, limiter, coalescer, nowMs } = args;
  const windowMs = args.coalesceWindowMs ?? DEFAULT_NUDGE_COALESCE_WINDOW_MS;
  const waker = args.waker !== undefined ? args.waker : registeredWaker;
  const base: NudgeDispatchResult = {
    fleetSlug: signal.fleetSlug,
    nudge: null,
    emitted: [],
    wakeErrors: [],
    dropped: null,
  };

  if (receiverTargets.length === 0) {
    return { ...base, dropped: 'no-receivers' };
  }

  const nudge = buildPullerNudge(signal);

  // COALESCE first — a coalesced nudge must not burn a rate-cap token.
  if (isWithinCoalesceWindow(coalescer, signal.fleetSlug, nowMs, windowMs)) {
    return { ...base, nudge, dropped: 'coalesced' };
  }

  // M9 per-grantor cap. checkSoft both checks AND consumes a token on ok.
  const cap = await limiter.checkSoft(nudgeRateCapKey(signal.grantorRef));
  if (!cap.ok) {
    return { ...base, nudge, dropped: 'rate-capped', retryAfterS: cap.retryAfterS };
  }

  recordNudge(coalescer, signal.fleetSlug, nowMs);

  const emitted: string[] = [];
  const wakeErrors: { ref: string; error: string }[] = [];
  for (const target of receiverTargets) {
    const outcome = await requestPullerNudge(nudge, target, waker);
    if (outcome.error) wakeErrors.push({ ref: target.ref, error: outcome.error });
    else if (outcome.wired) emitted.push(target.ref);
    // wired:false (no live waker) ⇒ silently a no-op — the poll still delivers.
  }
  return { ...base, nudge, emitted, wakeErrors, dropped: null };
}
