/**
 * lib/p2p/fleet-leader-election-service.ts — P-302 LIVE-WIRING layer (WI-1978).
 *
 * Binds the PURE {@link electFleetLeader} (fleet-leader-election.ts) to the REAL
 * federated read/announce surfaces P-301 (WI-1747) landed, so the LIVE-2 drill
 * (P-305) becomes runnable. The pure election stays agreement-free + deterministic;
 * this class is only the I/O orchestration around one `recompute` call.
 *
 * COMPOSES (all injected — the class knows no concrete store/transport):
 *   - presence: `listPresence` (live impl = queryFederatedPresenceRows over
 *     harness_shared.shared_presence, P-301) → {@link FleetMemberDevice}[]
 *   - roster: `roster.members` + `roster.currentEpoch` (scope-roster.ts, C4 epoch)
 *   - lease: a {@link FleetLeaderLeaseStore} — the incumbent every peer must agree
 *     on. In-memory here (single box / tests); the LIVE-2 seam is a FEDERATED
 *     PG-backed impl (a migration on the shared substrate), deferred + coordinated.
 *   - announce: a {@link LeadershipAnnouncer} (coord:send in the live wiring) — fired
 *     ONLY on a leader-device change (latency, not correctness; M9-friendly).
 *
 * DORMANT BY CONSTRUCTION: nothing calls `recompute` on a live tick yet — exactly the
 * rendezvous-authority "NOT YET WIRED" posture — so there is NO flag, NO migration,
 * and NO risk to the live election path. The remaining LIVE-2 seams are: (1) a
 * federated PG lease store, (2) a scheduled recompute tick, (3) the flag-gated
 * cutover. Each is an injected boundary here.
 */

import {
  electFleetLeader,
  leadershipAnnouncement,
  nextLeaseFromDecision,
  type FleetMemberDevice,
  type FleetLeaderLease,
  type FleetLeadershipDecision,
  type LeadershipAnnouncement,
} from './fleet-leader-election';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import type { SelfSwarmIdentity } from '../authority/lock-authority';

/** Staleness window a device must be seen within to be a candidate (mirrors
 *  lock-authority's DEFAULT_AUTHORITY_STALE_MS; local const to avoid a runtime
 *  import of the heavy lock-authority module — this file stays light). */
export const DEFAULT_LEADER_STALE_MS = 90_000;
/** How long a live incumbent keeps the fleet past its takeover (anti-flap). */
export const DEFAULT_LEADER_LEASE_MS = 30_000;

/** The federated leadership-lease store. In-memory here; the LIVE-2 seam is a
 *  federated PG table so every peer reads the SAME incumbent. */
export interface FleetLeaderLeaseStore {
  read(scope: ScopeId): Promise<FleetLeaderLease | null>;
  /** Persist the new lease; `null` clears the row (leadership vacated). */
  write(scope: ScopeId, lease: FleetLeaderLease | null): Promise<void>;
}

/** The roster read (scope-roster.ts), narrowed to what the election needs. */
export interface FleetRosterRead {
  members(scope: ScopeId): Promise<number[]>;
  currentEpoch(scope: ScopeId): Promise<number>;
}

/** Emit a leadership change on the coord plane (coord:send in the live wiring). */
export type LeadershipAnnouncer = (scope: ScopeId, announcement: LeadershipAnnouncement) => Promise<void>;

export interface FleetLeaderElectionDeps {
  /** Federated member devices for the scope (live impl = queryFederatedPresenceRows). */
  listPresence(scope: ScopeId): Promise<readonly FleetMemberDevice[]>;
  roster: FleetRosterRead;
  leaseStore: FleetLeaderLeaseStore;
  announce: LeadershipAnnouncer;
  /** This peer's swarm identity, or null (gh-unauthenticated / no device key). */
  self: SelfSwarmIdentity | null;
  now(): number;
  staleMs?: number;
  leaseMs?: number;
  /** Relay-confirmed-dead device pubkeys to drop for a scope (optional). */
  excluded?(scope: ScopeId): Promise<ReadonlySet<string> | undefined> | ReadonlySet<string> | undefined;
}

export interface RecomputeResult {
  decision: FleetLeadershipDecision;
  /** The announcement emitted (null when the leader device did not change). */
  announced: LeadershipAnnouncement | null;
  /** Whether the lease row was (re)written this recompute. */
  leaseWritten: boolean;
}

/**
 * Recompute the leader for one fleet from the current federated state, persist the
 * new lease, and announce on a leader-device change. Idempotent + safe to call on
 * any cadence (a no-change recompute writes nothing and announces nothing).
 */
export class FleetLeaderElectionService {
  constructor(private readonly deps: FleetLeaderElectionDeps) {}

  async recompute(scope: ScopeId): Promise<RecomputeResult> {
    const nowMs = this.deps.now();
    const [presence, members, rosterEpoch, incumbent, excluded] = await Promise.all([
      this.deps.listPresence(scope),
      this.deps.roster.members(scope),
      this.deps.roster.currentEpoch(scope),
      this.deps.leaseStore.read(scope),
      Promise.resolve(this.deps.excluded?.(scope)),
    ]);

    const decision = electFleetLeader({
      scope,
      rosterMemberUids: new Set(members),
      rosterEpoch,
      presence,
      self: this.deps.self,
      incumbent,
      nowMs,
      staleMs: this.deps.staleMs ?? DEFAULT_LEADER_STALE_MS,
      leaseMs: this.deps.leaseMs ?? DEFAULT_LEADER_LEASE_MS,
      excluded: excluded ?? undefined,
    });

    // Persist the next lease only when the leader device OR the roster epoch it is
    // anchored to changed — a steady-state recompute (same leader, same epoch)
    // rewrites nothing, so the cadence is cheap. A fenced (behind-read) decision
    // returns the incumbent unchanged, so it too writes nothing.
    const nextLease = nextLeaseFromDecision(decision, incumbent, nowMs);
    const leaseWritten =
      (incumbent?.devicePubkey ?? null) !== (nextLease?.devicePubkey ?? null) ||
      (incumbent?.rosterEpoch ?? null) !== (nextLease?.rosterEpoch ?? null);
    if (leaseWritten) await this.deps.leaseStore.write(scope, nextLease);

    // Announce ONLY on a leader-device change (latency, not correctness).
    const announced = leadershipAnnouncement(decision, incumbent);
    if (announced) await this.deps.announce(scope, announced);

    return { decision, announced, leaseWritten };
  }
}

/** In-memory lease store (single box / tests). The LIVE-2 seam is a federated PG
 *  impl so cross-machine peers agree on the incumbent. */
export function createInMemoryLeaderLeaseStore(): FleetLeaderLeaseStore {
  const m = new Map<string, FleetLeaderLease>();
  const key = (s: ScopeId): string => `${s.ownerGithubUserId}/${s.slug}`;
  return {
    async read(scope) {
      return m.get(key(scope)) ?? null;
    },
    async write(scope, lease) {
      if (lease == null) m.delete(key(scope));
      else m.set(key(scope), lease);
    },
  };
}

/**
 * Adapt a raw federated presence row (queryFederatedPresenceRows / shared_presence,
 * P-301) to the {@link FleetMemberDevice} the election consumes. Pure; the live
 * `listPresence` maps its query rows through this.
 */
export function toFleetMemberDevice(row: {
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  last_seen_ms: number;
}): FleetMemberDevice {
  return {
    device_pubkey: row.device_pubkey,
    github_user_id: row.github_user_id,
    machine_label: row.machine_label,
    last_seen_ms: row.last_seen_ms,
  };
}
