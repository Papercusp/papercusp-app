/**
 * decider.ts — the Queen autonomy decider gate (queen-autonomy-policy-2026-06-13
 * B-12 / P-070, P-071; closes queen-autonomous-execution P-013 — the shared
 * decider seam, NOT a fork).
 *
 * This is the KEYSTONE that wires the four landed seams together into the one
 * gating function the dark Queen-decider (frontier P-045 / FB-19) consults per
 * queue item: it answers "may the Queen AUTO-decide this, or does it route to the
 * owner gate?"
 *
 *   - risk vocabulary + the needs-human half of the gate → `@papercusp/plan-parser`
 *     `deriveNeedsHuman` (B-01);
 *   - reversibility (blast-radius hard floor) → `effectiveReversibility` (B-02);
 *   - per-category effective ceiling → `effectiveCeiling` over the policy store (B-03);
 *   - the action → category map → `categoryForAction` (B-04).
 *
 * The unified gating function (D-004):
 *
 *   auto ⟺ risk_tier ≤ min(ceiling, graduated) ∧ reversible ∧ ¬authority_owner ∧ ¬protected
 *   gated ⟺ ¬auto                        (→ the owner Queue)
 *
 * BEHAVIOR-NEUTRAL until armed (D-007): the decider only auto-decides when the
 * policy is ARMED (the owner's P-092 gate, the `papercusp-queen-autonomy-armed`
 * flag). Until then `decideAutonomy` returns `gated` for EVERY item, so wiring it
 * in today changes nothing — exactly the dark-ship contract. And even once armed,
 * every category ships at `never-auto` (D-007) so nothing auto-decides until the
 * owner deliberately lowers a ceiling AND earns graduation within it (D-005).
 *
 * `decideAutonomy` is PURE (no IO) — it takes the already-resolved category /
 * ceiling / armed inputs. `resolveAutonomyDecision` is the async resolver that
 * reads the category map + the policy store + the arming flag and then calls the
 * pure core. Downstream (B-13 ledger via the disposition record, B-16
 * tripwire/graduation via the gate + signals) consume THIS — they do not fork the
 * gate.
 */

import {
  deriveNeedsHuman,
  type Authority,
  type AutonomyCeiling,
  type RiskTier,
  DEFAULT_AUTHORITY,
} from '@papercusp/plan-parser';
import { type AutonomyCategory, isProtectedCategory } from './categories';
import { categoryForAction } from './capability-category-map';
import { type AutonomyCategoryPolicy, effectiveCeiling as computeEffectiveCeiling } from './policy';
import {
  type Reversibility,
  effectiveReversibility,
} from '../harness/improvements/reversibility';

/** The decider's binary verdict: auto → the implement lane; gated → the owner Queue. */
export type AutonomyPosture = 'auto' | 'gated';

/**
 * The frontier economics signals (P-071), carried alongside the gate. They do
 * NOT enter the gate itself (the gate is the three D-002 axes — risk ·
 * reversibility · authority — over the per-category ceiling); they re-weigh
 * RANKING and feed graduation EVIDENCE per the P-071 routing rule:
 *   - calibration trust (P-041) + deferral-interest (P-042) → ranking AND
 *     graduation evidence;
 *   - owner-preference (P-043) → RE-RANKS ONLY (never graduation evidence).
 */
export interface EconomicSignals {
  /** Brier-earned trust weight (P-041), 0..1. */
  calibrationWeight?: number;
  /** Expected accrual rate of continued deferral (P-042). */
  deferralInterest?: number;
  /** Learned owner taste re-rank (P-043) — re-ranks only, never evidence. */
  ownerPreference?: number;
}

/**
 * The P-071 routing rule, in code: the graduation evidence is calibration +
 * deferral-interest — owner-preference re-ranks only and is dropped here, so a
 * caller threading `signals` into the graduation tracker (B-16) can't accidentally
 * let learned owner taste count as earned trust.
 */
export function graduationEvidenceSignals(
  s: EconomicSignals | undefined,
): { calibrationWeight?: number; deferralInterest?: number } {
  return {
    ...(s?.calibrationWeight !== undefined ? { calibrationWeight: s.calibrationWeight } : {}),
    ...(s?.deferralInterest !== undefined ? { deferralInterest: s.deferralInterest } : {}),
  };
}

export interface AutonomyDecisionInput {
  /** The MCP tool/verb the action uses (`group:verb`) — keys the category (B-04). */
  action?: string;
  /** Coarse RBAC capability — last-resort category fallback only (B-04). */
  capability?: string;
  /**
   * Pre-resolved category. When provided it WINS over `action` (the resolver
   * passes it so the map is consulted once); pass `null` to force the unmapped
   * (never-auto) branch explicitly. Omit to derive from `action`.
   */
  category?: AutonomyCategory | null;
  /** The item's graded risk. Missing ⇒ fail-safe `critical` (D-002). */
  riskTier?: RiskTier | null;
  /** Decision authority. `owner` always gates (P-011). Default `system`. */
  authority?: Authority | null;
  /** Reversibility of the action (B-02). Missing/`unknown` ⇒ irreversible (fail-safe). */
  reversibility?: Reversibility | null;
  /**
   * The EFFECTIVE per-category ceiling — `min(ceiling, graduated)`, `never-auto`
   * when locked (B-03 `effectiveCeiling`). Default `never-auto` (the fail-safe
   * for an unseeded / unmapped category). The resolver fills this from the store.
   */
  effectiveCeiling?: AutonomyCeiling | null;
  /**
   * Whether the autonomy policy is ARMED (the owner's P-092 gate). Default
   * `false` ⇒ everything gated ⇒ behavior-neutral (D-007). No caller arms before P-092.
   */
  armed?: boolean;
  /**
   * The OWNER FULL-AUTONOMY grant (queen-autonomy-and-selffeed-fix Phase 2 —
   * `FLAGS.MUG_FULL_AUTONOMY`). When `true` the owner has accepted full autonomy
   * INCLUDING the residue the per-category ceilings can't reach: this lifts EVERY
   * substantive hard gate (owner-authority, protected/never-auto ceiling,
   * irreversible, above-ceiling, unmapped) and graduation:* asks → `auto`, so the
   * Queen never pauses to ask. The would-have-gated reasons are still recorded (for
   * the ledger + the settings "why" surface) alongside `owner-full-autonomy-grant`.
   * Default `false` ⇒ today's gate verbatim. REVERSIBLE: clearing the grant restores
   * the gated residue exactly. Implies armed (the grant is itself an owner arm act).
   */
  ownerFullAutonomy?: boolean;
  /** Optional ranking/evidence signals (P-071) — echoed onto the decision. */
  signals?: EconomicSignals;
}

/**
 * The decider's structured verdict — the disposition record B-13's decision
 * ledger (P-110/P-111) and B-16's tripwire/graduation (P-080..P-082) consume.
 * Maps onto the D-012 ledger row shape (`category · action · risk_tier ·
 * reversibility · authority · posture · why`).
 */
export interface AutonomyDecision {
  posture: AutonomyPosture;
  /** null = the action's category could not be resolved (fail-safe never-auto). */
  category: AutonomyCategory | null;
  action?: string;
  riskTier: RiskTier;
  authority: Authority;
  reversibility: 'reversible' | 'irreversible';
  effectiveCeiling: AutonomyCeiling;
  /** True iff the category is in the never-auto protected set (D-005). */
  protected: boolean;
  /** Whether the policy was armed when this was decided. */
  armed: boolean;
  /**
   * Whether the OWNER FULL-AUTONOMY grant was active when this was decided (Phase 2).
   * When true, `posture` is `auto` regardless of the hard gates (which stay listed in
   * `reasons` as the audit trail of what WOULD have gated), and `owner-full-autonomy-grant`
   * is the decisive reason. The decision ledger records this so the owner can review/revert.
   */
  ownerFullAutonomy: boolean;
  /**
   * Would this auto-decide IF the policy were armed? (Ignores `armed`, applies
   * the substantive gate.) The shadow signal — what the settings surface (B-15)
   * shows as "would auto once armed" and what proves behavior-neutrality.
   */
  wouldAutoIfArmed: boolean;
  /** The decisive reasons, for the ledger + the settings "why" surface. */
  reasons: string[];
  /** Ranking/evidence signals (P-071), echoed for the ledger; never gate inputs. */
  signals?: EconomicSignals;
  /** The P-071 graduation-evidence subset (calibration + deferral; no owner-pref). */
  graduationEvidence?: { calibrationWeight?: number; deferralInterest?: number };
}

/**
 * The PURE gate (D-004). Composes the four landed seams; no IO. Collects EVERY
 * applicable gate reason (not short-circuit) so the ledger row explains the full
 * verdict, then sets the binary posture.
 */
export function decideAutonomy(input: AutonomyDecisionInput): AutonomyDecision {
  const armed = input.armed ?? false;
  const action = input.action;
  const category =
    input.category !== undefined ? input.category : categoryForAction(action ?? '', input.capability);
  const riskTier: RiskTier = input.riskTier ?? 'critical'; // unknown risk ⇒ fail-safe (D-002)
  const authority: Authority = input.authority ?? DEFAULT_AUTHORITY;
  const reversibility = effectiveReversibility(input.reversibility ?? 'unknown'); // unknown ⇒ irreversible
  const effectiveCeiling: AutonomyCeiling = input.effectiveCeiling ?? 'never-auto';
  // Protection is NOT a separate gate (D-005): a protected category is one whose
  // ceiling is LOCKED at never-auto, so its protection flows through
  // `effectiveCeiling` (the resolver passes `never-auto` for a locked category) and
  // surfaces below as the `ceiling-never-auto` reason. Recorded here only as
  // informational metadata for the ledger — adding it as an independent hard gate
  // would wrongly make a deliberate owner UNLOCK (the only widening path, D-005) a
  // no-op, contradicting B-19's "the lock is the load-bearing floor" invariant.
  const isProtected = category != null && isProtectedCategory(category);

  // ── The substantive gate, IGNORING `armed` (so we can also report
  //    wouldAutoIfArmed). Every failing condition is a recorded reason. ──
  const hardGates: string[] = [];
  if (category == null) hardGates.push('unmapped-category'); // D-009 fail-safe never-auto
  if (authority === 'owner') hardGates.push('owner-authority'); // P-011 categorical override
  if (reversibility === 'irreversible') hardGates.push('irreversible-action'); // B-02 hard floor
  // The risk-vs-ceiling half (D-004) — `deriveNeedsHuman` (armed path) folds in
  // never-auto ceiling (incl. a locked/protected category) + risk>ceiling +
  // authority=owner into one comparison.
  if (deriveNeedsHuman({ riskTier, authority, ceiling: effectiveCeiling, armed: true })) {
    hardGates.push(effectiveCeiling === 'never-auto' ? 'ceiling-never-auto' : 'risk-above-ceiling');
  }
  const wouldAutoIfArmed = hardGates.length === 0;
  const ownerFullAutonomy = input.ownerFullAutonomy ?? false;

  const reasons = [...new Set(hardGates)];
  let posture: AutonomyPosture;
  if (ownerFullAutonomy) {
    // The OWNER FULL-AUTONOMY grant (Phase 2): the owner has accepted full autonomy
    // INCLUDING the categorical residue (owner-authority / protected / irreversible /
    // above-ceiling / unmapped) and graduation:* asks. Override the posture to `auto`
    // — but KEEP the would-have-gated reasons above as the audit trail of what the
    // grant lifted, and name the grant as the decisive reason. The grant implies armed
    // (it is itself an owner arm act), so it wins over `!armed` too. REVERSIBLE:
    // clearing the grant drops this branch and restores the gates verbatim. The
    // reversibility safety-net for a granted PROTECTED/IRREVERSIBLE auto is the grant
    // flag itself (flip it off), not a per-action tripwire (armTripwire still refuses
    // to arm a protected/irreversible decision — by design).
    posture = 'auto';
    reasons.push('owner-full-autonomy-grant');
  } else if (!armed) {
    posture = 'gated';
    // Only add the arming reason when nothing else already gates it — otherwise
    // the substantive gates ARE the explanation (and stay correct once armed).
    if (wouldAutoIfArmed) reasons.push('policy-not-armed');
  } else {
    posture = wouldAutoIfArmed ? 'auto' : 'gated';
  }

  return {
    posture,
    category: category ?? null,
    ...(action !== undefined ? { action } : {}),
    riskTier,
    authority,
    reversibility,
    effectiveCeiling,
    protected: isProtected,
    armed,
    ownerFullAutonomy,
    wouldAutoIfArmed,
    reasons,
    ...(input.signals ? { signals: input.signals } : {}),
    ...(input.signals
      ? { graduationEvidence: graduationEvidenceSignals(input.signals) }
      : {}),
  };
}

/** Injectable IO for the async resolver (unit tests inject fakes). */
export interface DeciderDeps {
  /** Read one category's stored policy (B-03). */
  getPolicy: (category: AutonomyCategory) => Promise<AutonomyCategoryPolicy>;
  /** Is the autonomy policy ARMED for this workspace? (the P-092 flag). */
  isArmed: () => Promise<boolean>;
  /**
   * Is the OWNER FULL-AUTONOMY grant active for this workspace? (Phase 2 —
   * `FLAGS.MUG_FULL_AUTONOMY`). When true the resolver lifts the entire residue.
   * Default deps fail-DARK to `false` on a flag-IO error (a hiccup never grants).
   */
  isFullAutonomy: () => Promise<boolean>;
}

/**
 * The async resolver — resolves the category from the action, the effective
 * ceiling from the policy store, and the arming flag, then runs the pure gate.
 * This is the seam the `autonomy:decide` tool + the frontier wiring call.
 *
 * Fail-safe: a category that can't be mapped (`null`) skips the policy read and
 * the gate treats it as never-auto (D-009). A policy-store error is NOT swallowed
 * here — the caller decides; but the default deps degrade an arming-flag IO error
 * to `false` (fail-dark), so a flag hiccup can never arm autonomy.
 */
export async function resolveAutonomyDecision(
  input: AutonomyDecisionInput,
  deps: DeciderDeps,
): Promise<AutonomyDecision> {
  const category =
    input.category !== undefined ? input.category : categoryForAction(input.action ?? '', input.capability);
  const [armed, ownerFullAutonomy] = await Promise.all([deps.isArmed(), deps.isFullAutonomy()]);
  let effectiveCeiling: AutonomyCeiling = 'never-auto';
  if (category != null) {
    const policy = await deps.getPolicy(category);
    effectiveCeiling = computeEffectiveCeiling(policy);
  }
  return decideAutonomy({ ...input, category, effectiveCeiling, armed, ownerFullAutonomy });
}

/**
 * Live PG + flag-backed deps. The arming flag (`papercusp-queen-autonomy-armed`,
 * P-092) defaults OFF and fails DARK on a flag-IO error — autonomy never arms by
 * accident.
 */
export function defaultDeciderDeps(
  sql: import('postgres').Sql,
  workspaceId: string,
): DeciderDeps {
  return {
    async getPolicy(category) {
      const { getAutonomyCategoryPolicy } = await import('./policy-store');
      return getAutonomyCategoryPolicy(sql, workspaceId, category);
    },
    async isArmed() {
      try {
        const [{ FLAGS }, { getFlag }] = await Promise.all([
          import('@papercusp/flags'),
          import('@papercusp/flags/server'),
        ]);
        return await getFlag(FLAGS.MUG_AUTONOMY_ARMED, `autonomy:${workspaceId}`);
      } catch {
        return false; // fail-DARK: a flag hiccup must never arm autonomy
      }
    },
    async isFullAutonomy() {
      try {
        const [{ FLAGS }, { getFlag }] = await Promise.all([
          import('@papercusp/flags'),
          import('@papercusp/flags/server'),
        ]);
        return await getFlag(FLAGS.MUG_FULL_AUTONOMY, `autonomy:${workspaceId}`);
      } catch {
        return false; // fail-DARK: a flag hiccup must never grant full autonomy
      }
    },
  };
}

/**
 * Decide a RANKED frontier/queue row (queen-autonomous-execution P-013 — the
 * shared decider seam; coordinate, don't fork). Reads the row's economics signals
 * off the ONE ranker's `rank.features` (P-071) and folds them into the decision,
 * then runs the gate. This is how the dark Queen-decider consumes
 * `rankPlacements` / `surveyHive` output (B-08): walk the ranked frontier, decide
 * each row, auto-handle the `auto` ones and route the `gated` ones to the owner
 * Queue. `baseInput` carries the per-row action/risk/authority/reversibility the
 * caller resolves (a frontier work-item's placement action + its risk); explicit
 * `baseInput.signals` win over the extracted ones.
 */
export async function decideRankedItem<T extends { rank?: { features?: ReadonlyArray<{ feature: string; value: number }> } }>(
  rankedItem: T,
  baseInput: AutonomyDecisionInput,
  deps: DeciderDeps,
): Promise<AutonomyDecision> {
  const signals = baseInput.signals ?? extractEconomicSignals(rankedItem);
  return resolveAutonomyDecision({ ...baseInput, ...(signals ? { signals } : {}) }, deps);
}

/**
 * Pull the P-071 economics signals out of a ranked item's breakdown — the ONE
 * ranker's `rank.features` already carry calibration (P-041), deferral-interest
 * (P-042), and owner-preference (P-043), so the decider reads them rather than
 * recomputing (D-005: one ranker, never a second). Returns `undefined` when the
 * item carries no rank breakdown.
 */
export function extractEconomicSignals(item: {
  rank?: { features?: ReadonlyArray<{ feature: string; value: number }> };
}): EconomicSignals | undefined {
  const features = item.rank?.features;
  if (!features) return undefined;
  const valueOf = (name: string): number | undefined =>
    features.find((f) => f.feature === name)?.value;
  const calibrationWeight = valueOf('calibration');
  const deferralInterest = valueOf('deferral-interest');
  const ownerPreference = valueOf('owner-preference');
  if (
    calibrationWeight === undefined &&
    deferralInterest === undefined &&
    ownerPreference === undefined
  ) {
    return undefined;
  }
  return {
    ...(calibrationWeight !== undefined ? { calibrationWeight } : {}),
    ...(deferralInterest !== undefined ? { deferralInterest } : {}),
    ...(ownerPreference !== undefined ? { ownerPreference } : {}),
  };
}
