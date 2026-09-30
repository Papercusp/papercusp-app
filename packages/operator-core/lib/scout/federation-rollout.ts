/**
 * federation-rollout.ts — P-010 (F3-2) staged ROLLOUT policy for federated
 * Scout↔gym elite/fact sharing (D-004 / D-005): HOW FAR a hive's federated
 * learning propagates, in three tiers, behind the FLAGS.FEDERATED_SCOUT_LEARNING
 * fleet-wide KILL-SWITCH (default-ON, the GITHUB_BRIDGE/P2P pattern — activation
 * is STRUCTURAL, not the flag):
 *
 *   Tier 1 — HIVE-MEMBERS-ONLY (existing admission). The F1 substrate already
 *            federates fact/elite ops hive-scoped through peer-log admission +
 *            epoch crypto; tier 1 is the correct WORKING default, not a stopgap.
 *   Tier 2 — CROSS-HIVE via directory gossip: a random O(log peers) subset of a
 *            hive's elites propagate to other hives (log-cost network coverage).
 *   Tier 3 — OPEN NETWORK behind the REPUTATION GATE (P-009): a stranger hive's
 *            artifacts are admitted only weighted by federationReputationWeight
 *            (unverified ⇒ zero), never flat-trusted.
 *
 * PURE module: no PG, no IO, and it never imports FLAGS — the caller passes the
 * resolved flag state (the p2p/rollout-tiers.ts discipline), so this stays a
 * testable policy pure-function. The egress writers (elite/fact publishers, Lane A
 * P-012/P-014) call {@link federatedShareDecision} before pushing to a cross-hive
 * or open audience; the tier CEILING is owner-steering tunable (the caller resolves
 * `configuredMaxTier`, alongside the existing federated-priming migration-rate key).
 */

export type FederationRolloutTier = 1 | 2 | 3;
/** 0 = FLAGS.FEDERATED_SCOUT_LEARNING OFF (the fleet kill-switch): NOTHING shared. */
export type FederationEffectiveTier = 0 | FederationRolloutTier;

/**
 * Structural prereq switches (the p2p/rollout-tiers.ts TIER_PREREQS_LANDED pattern).
 * Tier 2 needs the cross-hive directory-gossip propagation path; tier 3 needs the
 * P-009 reputation gate wired into the egress admit. Each flips to true only when
 * its machinery genuinely lands, so a DEFAULT-ON flag can never over-share before
 * the code exists — the effective ceiling clamps to 1 until then.
 */
export const CROSS_HIVE_GOSSIP_LANDED = false;
export const REPUTATION_GATE_LANDED = false;

/** The safe default ceiling: hive-members-only (the existing F1 behavior). */
export const DEFAULT_MAX_ROLLOUT_TIER: FederationRolloutTier = 1;

export interface FederationRolloutInputs {
  /** Resolved FLAGS.FEDERATED_SCOUT_LEARNING (the fleet kill-switch). */
  flagEnabled: boolean;
  /** Owner-configured ceiling (owner-steering tunable); default {@link DEFAULT_MAX_ROLLOUT_TIER}. */
  configuredMaxTier?: FederationRolloutTier;
  /** Test override of the structural prereqs; production reads the module constants. */
  crossHiveLanded?: boolean;
  reputationGateLanded?: boolean;
}

function structuralCeiling(inp: FederationRolloutInputs): FederationRolloutTier {
  const crossHive = inp.crossHiveLanded ?? CROSS_HIVE_GOSSIP_LANDED;
  const repGate = inp.reputationGateLanded ?? REPUTATION_GATE_LANDED;
  if (crossHive && repGate) return 3;
  if (crossHive) return 2;
  return 1;
}

/**
 * The EFFECTIVE rollout tier: flag OFF ⇒ 0; else the owner ceiling clamped by the
 * structural prereqs (never advertises a tier whose machinery has not landed).
 */
export function resolveMaxRolloutTier(inp: FederationRolloutInputs): FederationEffectiveTier {
  if (!inp.flagEnabled) return 0;
  const configured = inp.configuredMaxTier ?? DEFAULT_MAX_ROLLOUT_TIER;
  return Math.min(configured, structuralCeiling(inp)) as FederationEffectiveTier;
}

export type ShareAudience = 'hive-member' | 'cross-hive' | 'open-network';

/** Is a share to `audience` permitted at this effective tier? */
export function shareAllowed(tier: FederationEffectiveTier, audience: ShareAudience): boolean {
  switch (audience) {
    case 'hive-member':
      return tier >= 1;
    case 'cross-hive':
      return tier >= 2;
    case 'open-network':
      return tier >= 3;
    default:
      return false;
  }
}

/** The egress writer's one-call decision: resolve the tier, then gate the audience. */
export function federatedShareDecision(
  inp: FederationRolloutInputs & { audience: ShareAudience },
): { tier: FederationEffectiveTier; allowed: boolean } {
  const tier = resolveMaxRolloutTier(inp);
  return { tier, allowed: shareAllowed(tier, inp.audience) };
}

/**
 * Tier-2 gossip fan-out: a random O(log peers) subset for log-cost network
 * coverage (D-004). This returns HOW MANY peers to gossip to (the caller picks
 * WHICH); 0 when no peers, capped so a large directory never floods one tick.
 */
export function gossipFanout(peerCount: number, opts?: { cap?: number }): number {
  if (peerCount <= 0) return 0;
  const cap = opts?.cap ?? 8;
  return Math.min(cap, Math.max(1, Math.ceil(Math.log2(peerCount + 1))));
}

/**
 * Consistency invariant (mirrors p2p rolloutTiersInvariant): the effective tier is
 * 0 iff the flag is off, never exceeds the configured ceiling, and never advertises
 * tier 2/3 without its structural prereq. A guard for callers + tests.
 */
export function federationRolloutInvariant(inp: FederationRolloutInputs): boolean {
  const tier = resolveMaxRolloutTier(inp);
  if (!inp.flagEnabled) return tier === 0;
  if (tier > (inp.configuredMaxTier ?? DEFAULT_MAX_ROLLOUT_TIER)) return false;
  const crossHive = inp.crossHiveLanded ?? CROSS_HIVE_GOSSIP_LANDED;
  const repGate = inp.reputationGateLanded ?? REPUTATION_GATE_LANDED;
  if (tier >= 2 && !crossHive) return false;
  if (tier >= 3 && !repGate) return false;
  return true;
}
