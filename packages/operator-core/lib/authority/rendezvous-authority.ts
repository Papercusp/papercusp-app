/**
 * rendezvous-authority — P-021 (cross-machine-coord-parity-and-trust-2026-07-01):
 * per-scope-key authority selection by RENDEZVOUS HASHING (HRW, "highest random
 * weight") + short lease stickiness, the successor to the single global
 * `argmin(device_pubkey)` in lock-authority.selectAuthorityFromRows.
 *
 * WHY. The global argmin makes ONE peer (the lexicographically-lowest live
 * device_pubkey) the authority for EVERY scope — a load bottleneck AND a churn
 * amplifier: if that one peer flaps, EVERY lock/claim scope's authority flips at
 * once. Rendezvous hashing assigns each scope key INDEPENDENTLY to
 * `argmax_peer H(scopeKey, device_pubkey)`: authority load spreads ~uniformly
 * across the peer set, and a peer join/leave only reassigns the ~1/N scopes that
 * peer won (or would win) — every other scope is untouched. That is HRW's
 * signature minimal-disruption property, and it is exactly the churn confinement
 * the global argmin lacks.
 *
 * DETERMINISM. Like the argmin, the winner is a PURE function of the
 * already-federated `shared_presence` rows + a stable hash — no election, no RPC,
 * no shared mutable state — so every peer computes the SAME authority per scope
 * independently. The freshness / dedup / self / excluded rules are byte-identical
 * to selectAuthorityFromRows; ONLY the winner pick differs (HRW argmax vs argmin).
 *
 * FLAG-GATED, WIRED (WI-1491). {@link selectAuthorityRendezvous} is called live from
 * lock-authority.ts's `lockAuthorityFor` / `lockAuthorityForHive` behind the
 * `HRW_RENDEZVOUS_AUTHORITY` flag (dark by default — see libs/flags/src/types.ts,
 * KNOWN_DARK_FLAGS 'cutover' case): OFF keeps the byte-identical global argmin;
 * ON switches to this module's per-scope-key HRW winner, with `LockAuthorityDeps.
 * scopeKey` (defaulting to the harness/hive slug, so every existing call site works
 * unchanged) as the scope key. {@link applyLeaseStickiness} is proven here but NOT
 * yet wired live — it needs a federated lease store (a follow-up; see its own doc).
 */

import type { AuthorityResolution, SelfSwarmIdentity } from './lock-authority';

/** A live presence row, reshaped for selection (same shape as lock-authority's
 *  internal LivePeerRow — kept local so this module has no cross-import coupling
 *  and can be unit-tested standalone). */
export interface RendezvousPeerRow {
  device_pubkey: string;
  github_user_id: number;
  machine_label: string;
  last_seen_ms: number;
}

/**
 * Deterministic 32-bit string hash (FNV-1a + an xmur3-style avalanche finalizer).
 * Pure integer math (Math.imul / >>> 0), so it produces the SAME value on every
 * peer + platform — the property HRW needs to be agreement-free. The finalizer
 * mixes the bits so adjacent keys (`scope:devA`, `scope:devB`) don't cluster.
 */
export function hash32(str: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  // avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The HRW weight of a (scopeKey, device) pair — higher wins the scope. The scope
 * and device are folded into ONE hash so each scope key gets an INDEPENDENT
 * ranking of the peers (that independence is what spreads load + confines churn).
 * A NUL separator keeps `a`+`bc` distinct from `ab`+`c`.
 */
export function rendezvousWeight(scopeKey: string, devicePubkey: string): number {
  return hash32(`${scopeKey}\x00${devicePubkey}`);
}

/**
 * The PURE rendezvous authority-selection core (P-021 twin of
 * selectAuthorityFromRows): from a scope's presence rows + this peer's identity +
 * the SCOPE KEY, pick the peer with the highest HRW weight for that key. Freshness
 * cutoff, per-pubkey dedup (freshest wins), unconditional self candidacy, and the
 * `excluded` (relay-confirmed-dead) drop are identical to the argmin path — only
 * the winner rule changes.
 */
export function selectAuthorityRendezvous(
  rows: readonly RendezvousPeerRow[],
  self: SelfSwarmIdentity | null,
  nowMs: number,
  staleMs: number,
  scopeKey: string,
  excluded?: ReadonlySet<string>,
): AuthorityResolution {
  const cutoff = nowMs - staleMs;
  const byPubkey = new Map<string, RendezvousPeerRow>();
  for (const r of rows) {
    if (!r.device_pubkey || r.last_seen_ms <= cutoff) continue;
    if (excluded?.has(r.device_pubkey)) continue;
    const prior = byPubkey.get(r.device_pubkey);
    if (!prior || r.last_seen_ms > prior.last_seen_ms) byPubkey.set(r.device_pubkey, r);
  }
  if (self && !byPubkey.has(self.devicePubkey)) {
    byPubkey.set(self.devicePubkey, {
      device_pubkey: self.devicePubkey,
      github_user_id: self.githubUserId,
      machine_label: '(self)',
      last_seen_ms: nowMs,
    });
  }

  const candidates = [...byPubkey.values()];
  if (candidates.length === 0) {
    // No swarm, no self identity — single box. We are the authority.
    return { isSelf: true, liveCount: 0 };
  }

  // argmax(HRW weight); tie-break by the LOWER device_pubkey so a weight collision
  // still resolves identically on every peer (deterministic total order).
  let winner = candidates[0];
  let winnerW = rendezvousWeight(scopeKey, winner.device_pubkey);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const w = rendezvousWeight(scopeKey, c.device_pubkey);
    if (w > winnerW || (w === winnerW && c.device_pubkey < winner.device_pubkey)) {
      winner = c;
      winnerW = w;
    }
  }

  const isSelf = self != null && winner.device_pubkey === self.devicePubkey;
  if (isSelf) return { isSelf: true, liveCount: candidates.length };
  return {
    isSelf: false,
    liveCount: candidates.length,
    peer: {
      devicePubkey: winner.device_pubkey,
      githubUserId: winner.github_user_id,
      machineLabel: winner.machine_label,
    },
  };
}

/** A held authority lease for a scope (who holds it + when they took it). In the
 *  live wiring this is read from a federated lease row so every peer agrees; the
 *  selector below stays pure over it. */
export interface AuthorityLease {
  devicePubkey: string;
  sinceMs: number;
}

/**
 * Lease stickiness — damp authority flapping. Keep the INCUMBENT authority for a
 * scope for `leaseMs` after it took the scope, even when HRW now prefers another
 * live peer, AS LONG AS the incumbent is STILL a live candidate. This stops a
 * transient weight-order change (a peer briefly joining, a clock wobble, a beat
 * arriving out of order) from thrashing the authority mid-lease. Returns the
 * device_pubkey that should hold authority.
 *
 * Cross-peer deterministic when the `incumbent` lease is shared state (the live
 * path reads a federated lease record); the function itself is pure. When the
 * incumbent has gone stale (not in `liveDevicePubkeys`) or the lease has expired,
 * it yields to the fresh HRW winner immediately — stickiness never keeps a DEAD
 * authority.
 */
export function applyLeaseStickiness(
  hrwWinner: string,
  liveDevicePubkeys: ReadonlySet<string>,
  incumbent: AuthorityLease | null,
  nowMs: number,
  leaseMs: number,
): string {
  if (
    incumbent &&
    incumbent.devicePubkey !== hrwWinner &&
    liveDevicePubkeys.has(incumbent.devicePubkey) &&
    nowMs - incumbent.sinceMs < leaseMs
  ) {
    return incumbent.devicePubkey; // still leased + alive → sticky, no flap
  }
  return hrwWinner;
}
