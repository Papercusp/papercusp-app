/**
 * pipeline-tiering — who gets on the list, and in which tier
 * (fundraise-automation-2026-08-23 P-001 / P-002).
 *
 * The plan's list rule is short and load-bearing:
 *
 *   Tier 1 = explicit thesis match AND a warm path (human-approved everything)
 *   Tier 2 = thesis-matched cold (agent-drafted, owner-approved)
 *   Tier 3 does not exist — no spray.
 *
 * A rule stated only in prose drifts the moment a list is 40 names short of a target count and a
 * plausible-looking name is sitting right there. Encoding it makes the drift visible: admitting a
 * weak match requires editing this file and failing its tests, rather than quietly appending a row.
 *
 * ── Why "no tier 3" is the whole design ──────────────────────────────────────
 * Investors are the most spam-calibrated audience there is, so list size is not the goal and is
 * actively harmful past the point where personalization stays real. `classifyTarget` therefore has
 * no way to express "on the list but neither warm nor matched": that combination returns
 * `admitted: false`. Dropping a name is a normal, successful outcome of qualification.
 *
 * This module is pure and DB-free so the rule is unit-testable without a live pipeline.
 */

/** How well the counterparty's stated thesis matches, as judged by the research plan. */
export type ThesisMatch = 'strong' | 'plausible' | 'weak';

/** The intro-graph edge, when a real one exists. */
export interface WarmPath {
  /** Who can make the introduction. */
  connector?: string;
  /** How the connector knows them; used to judge whether the path is real. */
  connectorRelationship?: string;
  /**
   * Whether the connector would actually confirm the relationship. A path the connector would
   * not vouch for is not a warm path — acting on one burns the connector and the target at once.
   */
  connectorConfirmed?: boolean;
}

export interface TargetAssessment {
  counterparty: string;
  thesisMatch: ThesisMatch;
  warmPath?: WarmPath | null;
  /** Set by the research plan; an unresearched target cannot be tiered. */
  researched?: boolean;
}

export type TieringCode =
  | 'tier-1-warm-and-matched'
  | 'tier-2-matched-cold'
  | 'dropped-weak-thesis'
  | 'dropped-unresearched'
  | 'dropped-malformed';

export interface TieringDecision {
  /** Whether this target belongs on the list at all. */
  admitted: boolean;
  /** Only ever 1 or 2. There is deliberately no representation for a third tier. */
  tier: 1 | 2 | null;
  code: TieringCode;
  reason: string;
}

/** A warm path only counts when a named connector would actually confirm it. */
export function isRealWarmPath(warmPath: WarmPath | null | undefined): boolean {
  if (!warmPath || typeof warmPath !== 'object') return false;
  const connector = typeof warmPath.connector === 'string' ? warmPath.connector.trim() : '';
  if (!connector) return false;
  // Unconfirmed is treated as not-warm on purpose: the expensive error is upgrading an
  // acquaintance into a referral, not missing a warm path that can be confirmed later.
  return warmPath.connectorConfirmed === true;
}

/**
 * Decide whether a researched target belongs on the list, and in which tier.
 *
 * Order matters: research first (an unresearched target cannot be judged), then thesis (a weak
 * match is dropped regardless of how good the warm path is — a warm intro to a fund that does not
 * invest in this space wastes the connector), then warmth to split tier 1 from tier 2.
 */
export function classifyTarget(assessment: TargetAssessment | unknown): TieringDecision {
  if (
    typeof assessment !== 'object' ||
    assessment === null ||
    Array.isArray(assessment) ||
    typeof (assessment as TargetAssessment).counterparty !== 'string' ||
    !(assessment as TargetAssessment).counterparty.trim()
  ) {
    return {
      admitted: false,
      tier: null,
      code: 'dropped-malformed',
      reason: 'Target assessment is unreadable or names no counterparty, so it cannot be tiered.',
    };
  }

  const target = assessment as TargetAssessment;

  if (target.researched === false) {
    return {
      admitted: false,
      tier: null,
      code: 'dropped-unresearched',
      reason: `${target.counterparty} has not been researched, so its thesis match is unverified. Research before tiering.`,
    };
  }

  if (target.thesisMatch !== 'strong' && target.thesisMatch !== 'plausible') {
    return {
      admitted: false,
      tier: null,
      code: 'dropped-weak-thesis',
      reason:
        target.thesisMatch === 'weak'
          ? `${target.counterparty} is not a thesis match. Dropping the name is the correct outcome — there is no tier for unmatched targets.`
          : `${target.counterparty} has no recorded thesis verdict, so it cannot be admitted.`,
    };
  }

  if (isRealWarmPath(target.warmPath)) {
    return {
      admitted: true,
      tier: 1,
      code: 'tier-1-warm-and-matched',
      reason: `${target.counterparty} is thesis-matched with a confirmed warm path via ${target.warmPath?.connector}. Tier 1: every touch is human-approved and goes through the intro.`,
    };
  }

  return {
    admitted: true,
    tier: 2,
    code: 'tier-2-matched-cold',
    reason: `${target.counterparty} is thesis-matched with no confirmed warm path. Tier 2: agent-drafted, owner-approved cold outreach.`,
  };
}

export interface ListHealth {
  total: number;
  tier1: number;
  tier2: number;
  dropped: number;
  /** True while the list sits in the size band the plan calls for. */
  withinTargetBand: boolean;
  warnings: string[];
}

/** The plan's stated band: roughly 100–150 considered targets, never a spray list. */
export const TARGET_LIST_MIN = 100;
export const TARGET_LIST_MAX = 150;

/**
 * Summarize an assessed list. The warnings are the useful output: a list that is all tier 2 has no
 * intro graph behind it, and a list over the band has almost certainly stopped qualifying honestly.
 */
export function assessList(assessments: readonly (TargetAssessment | unknown)[]): ListHealth {
  const decisions = assessments.map(classifyTarget);
  const tier1 = decisions.filter((d) => d.tier === 1).length;
  const tier2 = decisions.filter((d) => d.tier === 2).length;
  const dropped = decisions.filter((d) => !d.admitted).length;
  const total = tier1 + tier2;
  const warnings: string[] = [];

  if (total > TARGET_LIST_MAX) {
    warnings.push(
      `List holds ${total} admitted targets, above the ${TARGET_LIST_MAX} band. A list this size is usually a qualification failure rather than a sourcing success.`,
    );
  }
  if (total > 0 && tier1 === 0) {
    warnings.push(
      'No tier-1 targets: nothing on this list has a confirmed warm path. Warm intros dominate venture, so an all-cold list is a mapping gap, not a sourcing outcome.',
    );
  }
  if (total > 0 && dropped === 0 && total >= TARGET_LIST_MIN) {
    warnings.push(
      'Nothing was dropped during qualification. A qualification pass that admits every candidate is not qualifying.',
    );
  }

  return {
    total,
    tier1,
    tier2,
    dropped,
    withinTargetBand: total >= TARGET_LIST_MIN && total <= TARGET_LIST_MAX,
    warnings,
  };
}
