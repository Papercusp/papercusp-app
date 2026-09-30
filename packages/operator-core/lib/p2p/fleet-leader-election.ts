/**
 * lib/p2p/fleet-leader-election.ts — P-302 (p2p-work-distribution-2026-07-02):
 * ADVISORY cross-machine fleet placement; never exclusive-effect authority.
 *
 * A fleet spans machines (P-301 federates `agent_fleets` + membership). Exactly
 * one DEVICE must lead each fleet — the cross-machine analog of the single-machine
 * `agent_fleets` leader — elected AGREEMENT-FREE so every peer computes the SAME
 * leader from the SAME federated inputs (no election RPC, no shared mutable state,
 * just a pure function of the already-federated presence rows + roster).
 *
 * COMPOSITION (reuse-first — no new algorithm is invented here):
 *   - HRW rendezvous over the fleet's live member DEVICES picks the leader
 *     (rendezvous-authority.ts {@link selectAuthorityRendezvous}, P-021). HRW's
 *     minimal-disruption property means a device join/leave only moves the ~1/N
 *     fleets that device would win — every other fleet's leader is untouched. That
 *     is the churn confinement a global argmin (one lowest-pubkey peer leads every
 *     fleet, and flaps them all at once) lacks.
 *   - Lease stickiness (rendezvous-authority.ts {@link applyLeaseStickiness}, P-021)
 *     damps leader FAILOVER FLAP: a live incumbent keeps the fleet for `leaseMs`
 *     even when HRW now prefers another live device (a device briefly joining, a
 *     clock wobble, an out-of-order beat).
 *   - Roster-epoch alignment (C4): the leadership decision is anchored to the
 *     fleet's ROSTER EPOCH (scope-roster.ts `currentEpoch` — the owner grantor
 *     high-water; a leave/revoke bumps it). Stickiness is scoped to ONE roster
 *     generation: when the epoch ADVANCES, the sticky lease from the old epoch is
 *     NOT honored — leadership is re-evaluated so a just-revoked leader loses the
 *     fleet immediately (the revoked device is already filtered out of the
 *     candidate set, and the epoch bump additionally breaks any stale stickiness
 *     that would otherwise have kept it).
 *   - Roster freshness ({@link acceptLeadershipAnnouncement}): lower membership
 *     epochs are rejected. This is NOT a leadership term or a sink fence. Two
 *     partitioned same-epoch views can both elect self. Exclusive effects need
 *     their own recipient contract (Git uses the single owning hive, F6/D-022).
 *
 * ANNOUNCE (P-302 "changes announce on the coord plane"): {@link leadershipAnnouncement}
 * computes the announcement to emit ONLY when the leader DEVICE changes — announce
 * is latency, never correctness (the standing puller pulls regardless), so an
 * epoch-only churn with an unchanged leader emits nothing (no wasted wake; M9).
 *
 * PURE. Like its rendezvous-authority parent, these are proven-in-isolation pure
 * functions. The LIVE wiring — a periodic recompute over federated `shared_presence`
 * + a coord-plane `coord:send` on change + a federated lease row + a flag-gated
 * cutover — is a thin injected layer and a follow-up; the live 2-machine proof is
 * P-305/LIVE-2. Prove the selector before touching any live election path.
 */

import {
  selectAuthorityRendezvous,
  applyLeaseStickiness,
  type RendezvousPeerRow,
  type AuthorityLease,
} from '../authority/rendezvous-authority';
import type { SelfSwarmIdentity } from '../authority/lock-authority';
import { fenceValid } from '../authority/authority-hardening';
import { type ScopeId, formatScopeId } from '../sync/pot-git/scope-repo';

/** A federated presence row for one member device (reshaped from `shared_presence`;
 *  same field shape as {@link RendezvousPeerRow} so it feeds the HRW selector
 *  directly). `github_user_id` is the device's OWNER — a device may lead a fleet
 *  only when its owner is a current roster member. */
export interface FleetMemberDevice {
  device_pubkey: string;
  /** The device owner's NUMERIC github user id (X9 — never a login). */
  github_user_id: number;
  machine_label: string;
  last_seen_ms: number;
}

/** The federated leadership lease for one fleet — read from a federated row so
 *  every peer agrees on the incumbent. Carries the roster epoch it was minted
 *  under so stickiness stays scoped to one roster generation (C4). */
export interface FleetLeaderLease {
  /** The device currently leading the fleet. */
  devicePubkey: string;
  /** The leader device owner's github user id (for the announce payload). */
  githubUserId: number | null;
  /** Server-clock ms the current leader took the fleet. */
  sinceMs: number;
  /** The roster epoch (C4) this lease was elected under. */
  rosterEpoch: number;
}

export interface FleetLeadershipDecision {
  /** The fleet scope, canonical `fleet:<uid>/<slug>` (the HRW scope key). */
  scopeKey: string;
  /** The elected leader device, or null when the fleet has no live member device. */
  leaderDevicePubkey: string | null;
  leaderGithubUserId: number | null;
  leaderMachineLabel: string | null;
  /** True when THIS peer's own device is the elected leader. */
  isSelf: boolean;
  /** Count of live member DEVICES considered (the candidate set size). */
  liveMemberDevices: number;
  /** The roster epoch (C4) this decision is anchored to. When the election
   *  DEFERRED to a newer lease (this peer's roster read was behind), this is the
   *  lease's (higher) epoch. */
  rosterEpoch: number;
  /** True when the leader DEVICE changed vs the incumbent lease (drives announce). */
  changed: boolean;
  /** True when the roster epoch advanced past the incumbent lease's epoch and so
   *  broke any stale stickiness (a membership change / revocation). */
  epochAdvanced: boolean;
  /** True when the election DEFERRED to a lease minted under a higher roster epoch
   *  than this peer can currently see (fencing: this peer's read is stale). */
  fenced: boolean;
}

export interface ElectFleetLeaderInput {
  /** The fleet being led. */
  scope: ScopeId;
  /** Current roster member github user ids (scope-roster `members`). Only devices
   *  owned by one of these may be elected leader. */
  rosterMemberUids: ReadonlySet<number>;
  /** The fleet's current roster epoch (scope-roster `currentEpoch`, C4). */
  rosterEpoch: number;
  /** Federated presence rows (one per member device, across machines). */
  presence: readonly FleetMemberDevice[];
  /** This peer's swarm identity, or null (gh-unauthenticated / no device key). */
  self: SelfSwarmIdentity | null;
  /** The federated incumbent leadership lease, or null on first election. */
  incumbent: FleetLeaderLease | null;
  nowMs: number;
  /** Freshness window — a device must be seen within this to be a candidate. */
  staleMs: number;
  /** Stickiness window — a live incumbent keeps the fleet this long past `sinceMs`. */
  leaseMs: number;
  /** Relay-confirmed-dead device pubkeys to drop (same semantics as the HRW core). */
  excluded?: ReadonlySet<string>;
}

/**
 * Elect the leader DEVICE for one fleet, cross-machine. Pure: deterministic in its
 * inputs, so every peer that sees the same federated presence + roster + lease
 * computes the identical decision.
 */
export function electFleetLeader(input: ElectFleetLeaderInput): FleetLeadershipDecision {
  const scopeKey = formatScopeId(input.scope);
  const { incumbent, rosterEpoch, nowMs } = input;

  // FENCING (Kleppmann): our roster read is BEHIND a lease already minted under a
  // higher epoch — do NOT override it with a stale election. Defer to the lease.
  if (incumbent && incumbent.rosterEpoch > rosterEpoch) {
    return {
      scopeKey,
      leaderDevicePubkey: incumbent.devicePubkey,
      leaderGithubUserId: incumbent.githubUserId,
      leaderMachineLabel: null,
      isSelf: input.self?.devicePubkey === incumbent.devicePubkey,
      liveMemberDevices: 0,
      rosterEpoch: incumbent.rosterEpoch,
      changed: false,
      epochAdvanced: false,
      fenced: true,
    };
  }

  // 1. Gate presence to LIVE devices whose OWNER is a current roster member. A
  //    non-member device — even one present in the federated swarm — cannot lead.
  const cutoff = nowMs - input.staleMs;
  const memberRows: RendezvousPeerRow[] = [];
  for (const r of input.presence) {
    if (!r.device_pubkey) continue;
    if (r.last_seen_ms <= cutoff) continue;
    if (!input.rosterMemberUids.has(r.github_user_id)) continue;
    if (input.excluded?.has(r.device_pubkey)) continue;
    memberRows.push(r);
  }

  // Self is a candidate only when its owner is a roster member.
  const selfEligible =
    input.self != null && input.rosterMemberUids.has(input.self.githubUserId) ? input.self : null;

  // No eligible device anywhere ⇒ the fleet has no leader (leadership vacated).
  if (memberRows.length === 0 && selfEligible == null) {
    return {
      scopeKey,
      leaderDevicePubkey: null,
      leaderGithubUserId: null,
      leaderMachineLabel: null,
      isSelf: false,
      liveMemberDevices: 0,
      rosterEpoch,
      changed: incumbent != null, // someone → nobody is a change
      epochAdvanced: incumbent != null && rosterEpoch > incumbent.rosterEpoch,
      fenced: false,
    };
  }

  // 2. HRW winner over the member devices (self injected iff eligible).
  const resolution = selectAuthorityRendezvous(
    memberRows,
    selfEligible,
    nowMs,
    input.staleMs,
    scopeKey,
    input.excluded,
  );

  // Resolve the HRW winner to a concrete device (pubkey + owner + label).
  let hrwPubkey: string;
  let hrwUid: number | null;
  let hrwLabel: string | null;
  if (resolution.isSelf && selfEligible) {
    hrwPubkey = selfEligible.devicePubkey;
    hrwUid = selfEligible.githubUserId;
    // Prefer the device's real presence label if it federated a row for itself.
    hrwLabel = memberRows.find((r) => r.device_pubkey === selfEligible.devicePubkey)?.machine_label ?? '(self)';
  } else if (resolution.peer) {
    hrwPubkey = resolution.peer.devicePubkey;
    hrwUid = resolution.peer.githubUserId;
    hrwLabel = resolution.peer.machineLabel;
  } else {
    // selfEligible present but not the winner and no peer returned is impossible
    // (selectAuthorityRendezvous always returns self or a peer once candidates
    // exist); fall back defensively to the first member row.
    const first = memberRows[0];
    hrwPubkey = first.device_pubkey;
    hrwUid = first.github_user_id;
    hrwLabel = first.machine_label;
  }

  // 3. Lease stickiness — scoped to ONE roster generation. An epoch ADVANCE past
  //    the incumbent's epoch drops stickiness so the election is free to move
  //    leadership after a membership change.
  const epochAdvanced = incumbent != null && rosterEpoch > incumbent.rosterEpoch;
  const liveDevicePubkeys = new Set(memberRows.map((r) => r.device_pubkey));
  if (selfEligible) liveDevicePubkeys.add(selfEligible.devicePubkey);

  const stickyIncumbent: AuthorityLease | null =
    incumbent && !epochAdvanced && incumbent.rosterEpoch === rosterEpoch
      ? { devicePubkey: incumbent.devicePubkey, sinceMs: incumbent.sinceMs }
      : null;

  const leaderPubkey = applyLeaseStickiness(hrwPubkey, liveDevicePubkeys, stickyIncumbent, nowMs, input.leaseMs);

  // Resolve the (possibly sticky) leader's owner + label from the candidate set.
  let leaderUid: number | null;
  let leaderLabel: string | null;
  if (leaderPubkey === hrwPubkey) {
    leaderUid = hrwUid;
    leaderLabel = hrwLabel;
  } else {
    // Stickiness kept the incumbent — resolve it from the live rows / self.
    const row = memberRows.find((r) => r.device_pubkey === leaderPubkey);
    if (row) {
      leaderUid = row.github_user_id;
      leaderLabel = row.machine_label;
    } else if (selfEligible && leaderPubkey === selfEligible.devicePubkey) {
      leaderUid = selfEligible.githubUserId;
      leaderLabel = '(self)';
    } else {
      leaderUid = incumbent?.githubUserId ?? null;
      leaderLabel = null;
    }
  }

  const isSelf = selfEligible != null && leaderPubkey === selfEligible.devicePubkey;
  const changed = (incumbent?.devicePubkey ?? null) !== leaderPubkey;

  return {
    scopeKey,
    leaderDevicePubkey: leaderPubkey,
    leaderGithubUserId: leaderUid,
    leaderMachineLabel: leaderLabel,
    isSelf,
    liveMemberDevices: liveDevicePubkeys.size,
    rosterEpoch,
    changed,
    epochAdvanced,
    fenced: false,
  };
}

/** Why leadership changed — carried on the coord-plane announcement. */
export type LeadershipChangeReason = 'elected' | 'failover' | 'epoch-advance' | 'vacated';

export interface LeadershipAnnouncement {
  scopeKey: string;
  /** The new leader device, or null when leadership was vacated. */
  leaderDevicePubkey: string | null;
  leaderGithubUserId: number | null;
  /** The roster epoch the new leadership is anchored to (receivers fence on this). */
  rosterEpoch: number;
  reason: LeadershipChangeReason;
}

/**
 * The coord-plane announcement to emit for a decision, or null when the leader
 * DEVICE did not change (announce is latency, not correctness — no wasted wake).
 */
export function leadershipAnnouncement(
  decision: FleetLeadershipDecision,
  incumbent: FleetLeaderLease | null,
): LeadershipAnnouncement | null {
  if (!decision.changed) return null;
  let reason: LeadershipChangeReason;
  if (decision.leaderDevicePubkey == null) reason = 'vacated';
  else if (incumbent == null) reason = 'elected';
  else if (decision.epochAdvanced) reason = 'epoch-advance';
  else reason = 'failover';
  return {
    scopeKey: decision.scopeKey,
    leaderDevicePubkey: decision.leaderDevicePubkey,
    leaderGithubUserId: decision.leaderGithubUserId,
    rosterEpoch: decision.rosterEpoch,
    reason,
  };
}

/**
 * Fencing (Kleppmann, locks-core `fenceValid`): should a peer ACCEPT an incoming
 * leadership announcement carrying `incomingEpoch`, given the highest roster epoch
 * it has seen for this fleet? A stale ex-leader's late announce (lower epoch) is
 * rejected — which is what makes a brief split-brain harmless.
 */
export function acceptLeadershipAnnouncement(incomingEpoch: number, highestSeenEpoch: number): boolean {
  return fenceValid(incomingEpoch, highestSeenEpoch);
}

/** Fold an accepted announcement into a peer's per-fleet high-water epoch (the
 *  monotonic value {@link acceptLeadershipAnnouncement} fences against). */
export function foldHighestSeenEpoch(current: number, accepted: LeadershipAnnouncement): number {
  return Math.max(current, accepted.rosterEpoch);
}

/** Build the next lease record to persist from a decision (null ⇒ leadership
 *  vacated, clear the row). The caller writes this to the federated lease store;
 *  `sinceMs` is preserved across a no-op re-election so stickiness keeps counting
 *  from the original takeover, and reset when the leader device changes. */
export function nextLeaseFromDecision(
  decision: FleetLeadershipDecision,
  incumbent: FleetLeaderLease | null,
  nowMs: number,
): FleetLeaderLease | null {
  if (decision.leaderDevicePubkey == null) return null;
  const sameLeader = incumbent != null && incumbent.devicePubkey === decision.leaderDevicePubkey;
  return {
    devicePubkey: decision.leaderDevicePubkey,
    githubUserId: decision.leaderGithubUserId,
    sinceMs: sameLeader ? incumbent!.sinceMs : nowMs,
    rosterEpoch: decision.rosterEpoch,
  };
}
