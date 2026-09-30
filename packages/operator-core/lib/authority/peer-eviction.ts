/**
 * peer-eviction — wire the φ-accrual + SWIM failure detector into the lock
 * authority so a CRASHED authority is evicted promptly, instead of waiting out
 * the 90s staleness window (P-016 of shared-hive-hardening-2026-06-13).
 *
 * # The gap this closes
 *
 * Authority selection (./lock-authority `selectAuthorityFromRows`) drops a peer
 * from candidacy only once its presence goes stale (`DEFAULT_AUTHORITY_STALE_MS`,
 * 90s). The generic `@papercusp/failure-detector` lib already ships φ-accrual +
 * SWIM indirect probing, but until now nothing wired the relay probe — so no peer
 * could confirm another dead, and eviction degraded to bare φ (i.e. the 90s
 * staleness floor was the only mechanism). This module binds the lib's
 * {@link indirectProbe} + {@link decideEviction} over the SAME `PeerRpcTransport`
 * seam the file-lock RPCs ride (B-01's Hyperswarm-mux transport / the HTTP
 * transport, via the composite), so a peer that relays confirm dead is excluded
 * from candidacy BEFORE the staleness window elapses.
 *
 * # The safety policy (deliberately stricter than the lib's bare-φ option)
 *
 * `decideEviction` will evict on a high φ ALONE when no relay vouches (the
 * `no-relays-high-phi` / `confirmed-dead` reasons). We do NOT take that path on
 * our own blindness: a peer is evicted early ONLY when at least one REACHABLE
 * relay fails to confirm it alive (`confirmed-dead`). When there are no relays, or
 * every relay is itself unreachable (e.g. no transport / addressing not yet
 * wired), the verdict is INCONCLUSIVE → keep the peer → the 90s staleness floor
 * is unchanged. This guarantees:
 *   - Single box / no transport → no behavior change (the common case).
 *   - We never falsely evict a live authority just because WE can't see it — a
 *     witness must agree. Fail-open (D-004) still holds either way.
 *   - A real crash in a ≥3-peer hive (witnesses exist + agree dead) → prompt
 *     eviction, the brief's goal.
 *
 * # How it stays off the hot path
 *
 * `beforeSelect` (called from `lockAuthorityFor`) is SYNC: it feeds the φ
 * detectors from the presence rows already in hand and returns the CACHED evicted
 * set. The relay probes run in a throttled, fire-and-forget background
 * `refresh` — so eviction takes effect on the NEXT resolution after a probe round
 * (≤ a couple seconds), never blocking an acquire. A monitor is installed at boot
 * only behind the `papercusp-authority-eviction-probe` flag; with none installed
 * (the default in tests + pre-boot) authority selection is byte-identical to
 * before.
 */

import {
  PhiAccrualDetector,
  indirectProbe,
  decideEviction,
  PHI_REVOKE_THRESHOLD,
  type PhiAccrualOptions,
  type RelayProbe,
  type EvictionDecision,
} from '@papercusp/failure-detector';
import type { PeerRef } from './lock-authority';
import { getPeerRpcTransport, PeerUnreachableError } from './peer-rpc-transport';

/** The authority RPC op kind the relay probe sends — "is `targetPubkey` alive
 *  from your vantage?". Registered by the relay side (./peer-probe-op). */
export const PEER_PROBE_OP_KIND = 'peer.probe';

/** SWIM relay fan-out: probe at most this many relays per suspected target. */
export const DEFAULT_PROBE_FANOUT = 3;

/** Render a peer in probe-result labels (the README's `label` extractor). */
export function peerLabel(p: PeerRef): string {
  return p.machineLabel || p.devicePubkey.slice(0, 8);
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** A presence observation feeding the φ detector: a peer + when it was last seen. */
export interface PresenceObservation {
  peer: PeerRef;
  lastSeenMs: number;
}

/**
 * Build a {@link RelayProbe} over the registered `PeerRpcTransport`: ask `relay`
 * (via a `peer.probe` RPC) whether `target` is alive from its vantage. A reachable
 * relay answers `{ alive }`; an unreachable relay (no channel / no address /
 * timeout) throws `PeerUnreachableError`, which `indirectProbe` records as "no
 * signal" (neither alive nor dead) rather than a false "dead".
 */
export function transportRelayProbe(scope: string): RelayProbe<PeerRef> {
  return async (relay: PeerRef, target: PeerRef): Promise<boolean> => {
    const raw = await getPeerRpcTransport().rpc(relay, {
      harnessSlug: scope,
      kind: PEER_PROBE_OP_KIND,
      payload: { targetPubkey: target.devicePubkey },
    });
    return !!(raw && typeof raw === 'object' && (raw as { alive?: unknown }).alive === true);
  };
}

export interface AuthorityEvictionMonitorOpts {
  /** φ threshold for the EXPENSIVE eviction action. Default {@link PHI_REVOKE_THRESHOLD} (8). */
  threshold?: number;
  /** Min ms between background refreshes per scope (hot-path throttle). Default 2000. */
  refreshThrottleMs?: number;
  /** Relays probed per suspected target (SWIM k). Default {@link DEFAULT_PROBE_FANOUT}. */
  probeFanout?: number;
  /** φ detector tuning passed to each per-peer {@link PhiAccrualDetector}. */
  phiOptions?: PhiAccrualOptions;
  /** Override the relay probe (tests inject a deterministic one). Default:
   *  {@link transportRelayProbe} over the registered transport. */
  relayProbe?: (scope: string) => RelayProbe<PeerRef>;
}

/**
 * Per-process eviction monitor: maintains a φ detector per peer (fed from
 * presence observations) and a cached evicted-pubkey set per scope, refreshed by
 * throttled background relay probes.
 */
export class AuthorityEvictionMonitor {
  private readonly detectors = new Map<string, PhiAccrualDetector>();
  private readonly lastSeen = new Map<string, number>();
  private readonly evictedByScope = new Map<string, Set<string>>();
  private readonly lastRefreshAt = new Map<string, number>();
  private readonly refreshing = new Set<string>();
  private readonly threshold: number;
  private readonly refreshThrottleMs: number;
  private readonly probeFanout: number;
  private readonly phiOptions?: PhiAccrualOptions;
  private readonly relayProbeFor: (scope: string) => RelayProbe<PeerRef>;

  constructor(opts: AuthorityEvictionMonitorOpts = {}) {
    this.threshold = opts.threshold ?? PHI_REVOKE_THRESHOLD;
    this.refreshThrottleMs = opts.refreshThrottleMs ?? 2000;
    this.probeFanout = opts.probeFanout ?? DEFAULT_PROBE_FANOUT;
    this.phiOptions = opts.phiOptions;
    this.relayProbeFor = opts.relayProbe ?? ((scope) => transportRelayProbe(scope));
  }

  /** Feed presence observations: a peer whose `last_seen` advanced records a
   *  heartbeat (the φ detector learns the inter-arrival distribution). */
  observe(observations: PresenceObservation[], _nowMs: number): void {
    for (const { peer, lastSeenMs } of observations) {
      if (!peer.devicePubkey) continue;
      const prev = this.lastSeen.get(peer.devicePubkey);
      if (prev != null && lastSeenMs <= prev) continue;
      this.lastSeen.set(peer.devicePubkey, lastSeenMs);
      let det = this.detectors.get(peer.devicePubkey);
      if (!det) {
        det = new PhiAccrualDetector(this.phiOptions);
        this.detectors.set(peer.devicePubkey, det);
      }
      det.heartbeat(lastSeenMs);
    }
  }

  /** Current suspicion φ for a peer (0 if never observed). */
  phi(devicePubkey: string, nowMs: number): number {
    return this.detectors.get(devicePubkey)?.phi(nowMs) ?? 0;
  }

  /** The cached evicted-pubkey set for a scope — the SYNC read selection consults. */
  excludedPubkeys(scope: string): ReadonlySet<string> {
    return this.evictedByScope.get(scope) ?? EMPTY_SET;
  }

  /**
   * Hot-path entry from `lockAuthorityFor`: observe presence (feed φ), kick a
   * throttled background eviction refresh when warranted, and return the CURRENT
   * cached evicted set. SYNC — never awaits a probe; eviction lands on the next
   * resolution after the background refresh completes.
   */
  beforeSelect(
    scope: string,
    observations: PresenceObservation[],
    selfPubkey: string | null,
    nowMs: number,
  ): ReadonlySet<string> {
    this.observe(observations, nowMs);
    const excluded = this.excludedPubkeys(scope);

    // Refresh only when something is suspicious (a non-self peer past threshold)
    // OR there is an existing eviction to potentially CLEAR (self-heal on recovery).
    const anySuspect = observations.some(
      ({ peer }) => peer.devicePubkey !== selfPubkey && this.phi(peer.devicePubkey, nowMs) >= this.threshold,
    );
    if (anySuspect || excluded.size > 0) {
      const last = this.lastRefreshAt.get(scope) ?? 0;
      if (nowMs - last >= this.refreshThrottleMs && !this.refreshing.has(scope)) {
        this.lastRefreshAt.set(scope, nowMs);
        void this.refresh(scope, observations, selfPubkey, nowMs).catch(() => {
          /* background, best-effort: a probe failure leaves the prior cache */
        });
      }
    }
    return excluded;
  }

  /**
   * Recompute a scope's evicted set by probing each suspected peer's liveness over
   * relays, then replace the cached set. Re-entrancy-guarded per scope. Returns
   * the new evicted set.
   */
  async refresh(
    scope: string,
    observations: PresenceObservation[],
    selfPubkey: string | null,
    nowMs: number,
  ): Promise<ReadonlySet<string>> {
    if (this.refreshing.has(scope)) return this.excludedPubkeys(scope);
    this.refreshing.add(scope);
    try {
      const peers = observations.map((o) => o.peer).filter((p) => p.devicePubkey && p.devicePubkey !== selfPubkey);
      const probe = this.relayProbeFor(scope);
      const evicted = new Set<string>();
      for (const target of peers) {
        const relays = peers.filter((p) => p.devicePubkey !== target.devicePubkey);
        const decision = await this.decide(target, relays, probe, nowMs);
        if (decision.evict) evicted.add(target.devicePubkey);
      }
      this.evictedByScope.set(scope, evicted);
      return evicted;
    } finally {
      this.refreshing.delete(scope);
    }
  }

  /**
   * The eviction decision for one peer (the README's snippet, with our
   * relay-confirmation safety policy):
   *   - φ < threshold → keep (`alive-direct`).
   *   - no relays, or every relay unreachable (no signal) → keep — INCONCLUSIVE,
   *     never evict on our own blindness; the 90s staleness floor remains.
   *   - a relay vouches alive → keep (`alive-indirect`).
   *   - φ high AND ≥1 reachable relay, none vouching → evict (`confirmed-dead`).
   */
  async decide(
    target: PeerRef,
    relays: PeerRef[],
    probe: RelayProbe<PeerRef>,
    nowMs: number,
  ): Promise<EvictionDecision> {
    const phi = this.phi(target.devicePubkey, nowMs);
    if (phi < this.threshold) return { evict: false, reason: 'alive-direct' };
    if (relays.length === 0) return { evict: false, reason: 'alive-direct' };

    const result = await indirectProbe(target, relays, probe, { k: this.probeFanout, label: peerLabel });
    // No relay produced a signal (all unreachable) → we are blind, not the target
    // dead. Inconclusive → keep (the staleness floor, unchanged). This is stricter
    // than decideEviction's bare-φ `confirmed-dead`, by design.
    if (result.confirmedBy.length === 0 && result.deadBy.length === 0) {
      return { evict: false, reason: 'alive-direct' };
    }
    return decideEviction(phi, result, this.threshold);
  }

  /** Test/diagnostic: the φ detector count + tracked scopes. */
  stats(): { peers: number; scopes: number } {
    return { peers: this.detectors.size, scopes: this.evictedByScope.size };
  }
}

// ── Module singleton (mirrors the peer-rpc-transport pattern) ────────────────

let _monitor: AuthorityEvictionMonitor | null = null;

/** Install the eviction monitor at boot (behind the feature flag). Pass null to
 *  uninstall → authority selection reverts to staleness-only (byte-identical to
 *  pre-P-016). */
export function setAuthorityEvictionMonitor(monitor: AuthorityEvictionMonitor | null): void {
  _monitor = monitor;
}
/** The installed monitor, or null (no eviction → staleness-only selection). */
export function getAuthorityEvictionMonitor(): AuthorityEvictionMonitor | null {
  return _monitor;
}
/** Test-only: reset the installed monitor. */
export function __resetAuthorityEvictionMonitorForTests(): void {
  _monitor = null;
}
