/**
 * pot-git/gate/gate-trust.ts — DG-4: gate-trust resolution + the spot-check
 * policy (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8 P-047,
 * D-011).
 *
 * TWO SEPARABLE QUESTIONS the distributed gate asks about a verdict:
 *   - ADMISSION (DG-1, at receive): is the fact well-formed, signed, and from
 *     an admitted member device? The projection answers it; a failing fact is
 *     never stored.
 *   - TRUST (THIS module, at aggregation): does the stored fact COUNT toward
 *     green(S)? Only when the signer maps to a member the OWNER explicitly
 *     gate-granted (comms-trust.ts `gate` column, mig 443 — separable from
 *     `steer` by construction). FAIL-CLOSED at every hop.
 *
 * SPOT CHECKS (the lying-peer detector): the aggregator re-runs a fraction of
 * peer-verdicted shards locally and compares outcomes. Selection is
 * DETERMINISTIC from a seed (the staging sha): every honest member computes
 * the SAME spot-check set for a given sha — so the aggregation stays
 * re-verifiable by any member (the DG-5 "any member can re-verify" property) —
 * yet the set is unpredictable before the sha exists, so a dishonest runner
 * cannot know in advance which shards will be checked. A pass/fail mismatch on
 * the same (shard_id, inputs_hash) is the signal that feeds a gate-grant
 * revocation (an owner decision — this module only detects).
 *
 * Pure: node:crypto + verdicts.ts shapes; PG/membership reads are injected
 * seams so the DG-5 aggregator (and tests) compose without coupling.
 */

import { createHash } from 'node:crypto';
import type { GateVerdict } from './verdicts';

/** Domain-separation tag for the spot-check selection ranking. */
export const SPOT_CHECK_SELECT_DOMAIN = 'papercusp-pot-git-gate-spot-check-v1';

export interface GateTrustDeps {
  /** Map a SIGNER device pubkey → its admitted member (null = unadmitted).
   *  Production binds the comms-tier-gate device map (hive_members attestations). */
  resolveSignerMembership: (devicePubkey: string) => Promise<{ githubUserId: number | null }>;
  /** The owner's explicit gate grant for a member (comms-trust.ts hasGateGrant). */
  hasGateGrant: (githubUserId: number) => Promise<boolean>;
}

/**
 * Does this signer device's verdict COUNT toward green? device → admitted
 * member → explicit gate grant. FAIL-CLOSED: unadmitted device, missing grant,
 * or a resolve error all answer false (and never throw — aggregation must not
 * die on a trust read).
 */
export async function isGateTrustedDevice(
  devicePubkey: string,
  deps: GateTrustDeps,
): Promise<boolean> {
  if (!devicePubkey) return false;
  try {
    const member = await deps.resolveSignerMembership(devicePubkey);
    if (member.githubUserId == null) return false;
    return await deps.hasGateGrant(member.githubUserId);
  } catch {
    return false;
  }
}

export interface SpotCheckSelection {
  /** The shards to re-run locally, ranked selection order. */
  selected: string[];
  /** How many the fraction asked for (ceil(fraction × n), clamped to n). */
  quota: number;
}

/**
 * Deterministically select the spot-check shards for one aggregation round.
 * Ranking: sha256(domain \n seed \n shardId) ascending — a verifiable
 * pseudo-random order fixed by the seed (use the staging sha S so every member
 * derives the identical set for green(S)). `fraction` ∈ [0, 1]; the quota is
 * ceil(fraction × n) so any fraction > 0 checks AT LEAST one shard.
 * Deterministic + total: duplicate shard ids collapse, order of input is
 * irrelevant.
 */
export function selectSpotChecks(input: {
  shardIds: readonly string[];
  fraction: number;
  seed: string;
}): SpotCheckSelection {
  const unique = [...new Set(input.shardIds)];
  const fraction = Number.isFinite(input.fraction) ? Math.min(Math.max(input.fraction, 0), 1) : 0;
  const quota = fraction === 0 ? 0 : Math.min(unique.length, Math.ceil(fraction * unique.length));
  if (quota === 0) return { selected: [], quota: 0 };
  const ranked = unique
    .map((shardId) => ({
      shardId,
      rank: createHash('sha256')
        .update(`${SPOT_CHECK_SELECT_DOMAIN}\n${input.seed}\n${shardId}`, 'utf8')
        .digest('hex'),
    }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  return { selected: ranked.slice(0, quota).map((r) => r.shardId), quota };
}

export type SpotCheckOutcome =
  | { kind: 'confirmed' }
  /** Same shard, same inputs — DIFFERENT outcome: the lying/flaky-peer signal. */
  | { kind: 'mismatch'; peerVerdict: 'pass' | 'fail'; localVerdict: 'pass' | 'fail' }
  /** The two runs weren't over the same work — not comparable, not a signal. */
  | { kind: 'incomparable'; reason: 'different-shard' | 'different-inputs' | 'different-repo' };

/**
 * Compare a peer's verdict with the local re-run of the same shard. Only a
 * same-(repo, shard, inputs) pair is comparable — an inputs_hash difference
 * means the two runs saw different trees (e.g. raced a staging advance), which
 * is NOT evidence of dishonesty.
 */
export function compareSpotCheck(peer: GateVerdict, local: GateVerdict): SpotCheckOutcome {
  if (peer.repo_key !== local.repo_key) return { kind: 'incomparable', reason: 'different-repo' };
  if (peer.shard_id !== local.shard_id) return { kind: 'incomparable', reason: 'different-shard' };
  if (peer.inputs_hash !== local.inputs_hash) {
    return { kind: 'incomparable', reason: 'different-inputs' };
  }
  if (peer.verdict === local.verdict) return { kind: 'confirmed' };
  return { kind: 'mismatch', peerVerdict: peer.verdict, localVerdict: local.verdict };
}
