/**
 * p2p/rollout-tiers.ts — the P2P ROLLOUT-TIER policy
 * (p2p-work-distribution-2026-07-02 P-005, H15/X15).
 *
 * The P2P flag (FLAGS.P2P) is the fleet-wide KILL-SWITCH, NOT the activation
 * surface (the landed GITHUB_BRIDGE pattern): default-ON, but activation is the
 * REAL surface — explicit grants (P-001) + host opt-in (P-002), zero/empty by
 * default (M11). So inertness is STRUCTURAL and no dark-allowlist entry is
 * needed. This module is the orthogonal ROLLOUT dimension: HOW FAR a granted +
 * opted-in host may share work, staged in three tiers.
 *
 *   Tier 1 — SAME-OWNER machines only (the owner's tower + iMac rig). The owner
 *            and their own attested devices all announce under ONE numeric
 *            github user id, so scope-roster.ts ALREADY enforces this
 *            structurally (owner-only roster, no FleetDirectory) — tier 1 is
 *            not a stopgap, it is the correct enforcement for everything allowed
 *            to replicate today.
 *   Tier 2 — CROSS-USER, capability-capped at Delegate (+work-offer, wake; NO
 *            spawn). FS-D5 HARD GATE: cross-user membership requires §5.4
 *            per-scope crypto AND the X1 loopback boundary (P-105) — NOT merely
 *            an egress-policy decision. NEITHER is built, so tier 2 is
 *            structurally unreachable today.
 *   Tier 3 — CROSS-USER Operator grants (+spawn). Layers on the tier-2 prereqs
 *            plus the operator-grant surface.
 *
 * FS-D5 (recorded, D-015-adjacent): §5.4 PER-SCOPE CRYPTO is the HARD GATE for
 * tier 2, alongside the X1 loopback boundary landing in P-105. `TIER2_PREREQS_
 * LANDED` is the SINGLE structural switch P-105 flips when BOTH land; until then
 * `resolveMaxRolloutTier` can never exceed 1, and `rolloutTiersInvariant()`
 * guards that the ceiling model stays consistent.
 *
 * PURE module: no PG, no IO, and it never imports FLAGS — the caller passes the
 * resolved flag state, so this stays a testable policy pure-function (the flag
 * key lives in libs/flags; reading it is a server/client concern, not this
 * module's).
 */
import { P2P_PRESETS, type P2pCapability, type P2pPresetName } from './capabilities';

export type P2pRolloutTier = 1 | 2 | 3;
/** 0 = P2P disabled (FLAGS.P2P OFF = the fleet kill-switch): NOTHING shared. */
export type P2pEffectiveTier = 0 | P2pRolloutTier;

/**
 * FS-D5 HARD GATE. Tier 2 (cross-user) requires BOTH §5.4 per-scope crypto AND
 * the X1 loopback boundary — both land in P-105. Flip to `true` in P-105 (and
 * only then). This is the ONE structural switch; scope-roster.ts enforces the
 * same tier-1 boundary at the membership level (owner-only roster).
 */
export const TIER2_PREREQS_LANDED = false;
/** Tier 3 (cross-user Operator/spawn) layers on top of the tier-2 prereqs. */
export const TIER3_PREREQS_LANDED = false;

/**
 * The per-tier capability CEILING as a cumulative preset (capabilities.ts).
 * The ceiling constrains CROSS-USER grants; a same-owner host authorizes its
 * OWN machines fully (tier 1 → operator), so the ceiling only bites at tier ≥ 2.
 */
export const TIER_CAPABILITY_CEILING: Record<P2pRolloutTier, P2pPresetName> = {
  1: 'operator', // same-owner: full reach over the owner's own rig
  2: 'delegate', // cross-user capped at Delegate (+work-offer, wake) — NO spawn
  3: 'operator', // cross-user Operator grants (+spawn)
};

export interface RolloutTierInputs {
  /** FLAGS.P2P — the fleet kill-switch. OFF ⇒ effective tier 0 (nothing). */
  flagEnabled: boolean;
  /** Defaults to the built-in FS-D5 constants; injectable for tests / P-105
   *  forward-simulation without editing the module. */
  tier2PrereqsLanded?: boolean;
  tier3PrereqsLanded?: boolean;
}

/**
 * The MAX rollout tier permitted right now — the SINGLE source of truth every
 * gate reads. Flag OFF ⇒ 0. Else tier 1, widened to 2/3 ONLY when their
 * prereqs land. Tier 3 implies tier 2 (spawn is a superset of delegate reach),
 * so tier-3 prereqs without tier-2 prereqs can never yield 3.
 */
export function resolveMaxRolloutTier(inp: RolloutTierInputs): P2pEffectiveTier {
  if (!inp.flagEnabled) return 0;
  const t2 = inp.tier2PrereqsLanded ?? TIER2_PREREQS_LANDED;
  const t3 = inp.tier3PrereqsLanded ?? TIER3_PREREQS_LANDED;
  if (t2 && t3) return 3;
  if (t2) return 2;
  return 1;
}

/** May the current max tier reach CROSS-USER peers at all? (tier ≥ 2) */
export function tierAllowsCrossUser(tier: P2pEffectiveTier): boolean {
  return tier >= 2;
}

/**
 * The capabilities a CROSS-USER grant may carry at `tier`. Empty at tier ≤ 1
 * (same-owner-only: no cross-user grant is enforceable — the roster admits only
 * the owner), Delegate's set at tier 2, Operator's at tier 3.
 */
export function crossUserCapabilityCeiling(tier: P2pEffectiveTier): P2pCapability[] {
  if (tier < 2) return [];
  return [...P2P_PRESETS[TIER_CAPABILITY_CEILING[tier as P2pRolloutTier]]];
}

/** One-line description for the settings/visibility surface. */
export function describeRolloutTier(tier: P2pEffectiveTier): string {
  switch (tier) {
    case 0:
      return 'P2P disabled (kill-switch) — no work is shared.';
    case 1:
      return 'Tier 1 — same-owner machines only (your own attested devices).';
    case 2:
      return 'Tier 2 — cross-user sharing, capped at Delegate.';
    case 3:
      return 'Tier 3 — cross-user Operator grants (spawn).';
  }
}

/**
 * Recurrence guard for the FS-D5 invariants (called by the test; cheap enough
 * to assert at boot if ever wanted). Returns the list of VIOLATED invariants
 * (empty = healthy):
 *   - tier 2 must be capped at exactly Delegate (never carry spawn);
 *   - tier 3's ceiling is Operator (the only spawn-carrying tier);
 *   - tier 3 cannot be reachable unless tier 2 is (spawn ⊇ delegate reach).
 */
export function rolloutTiersInvariant(
  t2 = TIER2_PREREQS_LANDED,
  t3 = TIER3_PREREQS_LANDED,
): string[] {
  const violations: string[] = [];
  const tier2Caps = new Set(P2P_PRESETS[TIER_CAPABILITY_CEILING[2]]);
  if (tier2Caps.has('spawn')) violations.push('tier 2 ceiling must not carry spawn (Delegate cap)');
  const tier3Caps = new Set(P2P_PRESETS[TIER_CAPABILITY_CEILING[3]]);
  if (!tier3Caps.has('spawn')) violations.push('tier 3 ceiling must carry spawn (Operator)');
  if (t3 && !t2) violations.push('tier 3 prereqs cannot be landed without tier 2 prereqs');
  return violations;
}
