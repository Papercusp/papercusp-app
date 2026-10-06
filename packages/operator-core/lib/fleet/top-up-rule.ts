/**
 * P-005 / D-030: a fleet's no-top-up rule, and whether the headcount governor
 * will actually hold the fleet.
 *
 * Pure: no IO, no runtime import of agent-fleets-store. That module is fully
 * `vi.mock`ed by dozens of test files; a constant or helper exported from it is
 * missing under every such mock, and any module that reads it at load time
 * fails collection there (the same reason member-silence-threshold.ts is its
 * own file). The persistence half (set / list-expired / lapse) stays in the
 * store; everything a read surface or tool needs to REASON about a rule is here.
 */
import type { FleetHeadcountState, FleetHeadcountTarget } from '../agent-fleets-store';

/** What a no-top-up rule suspended: the target itself, or the supervise grant. */
export type FleetTopUpRuleKind = 'target-disabled' | 'supervise-revoked';

export interface FleetTopUpRule {
  kind: FleetTopUpRuleKind;
  /** Coord owner id that set (or last re-ratified) the rule. */
  ratifiedBy: string;
  /** Epoch ms of the last ratification. */
  ratifiedAt: number;
  reason: string;
  /** Epoch ms after which the rule no longer holds; re-ratifying moves it. */
  until: number;
  /** The target in force when the rule suspended holding (null: none was). */
  suspendedTarget: number | null;
  /** The supervise grant in force when the rule suspended holding. */
  suspendedSupervise: boolean | null;
}

export const FLEET_TOP_UP_RULE_DEFAULT_HOURS = 24;
export const FLEET_TOP_UP_RULE_MAX_HOURS = 72;

export type FleetTopUpRuleStatus = 'none' | 'in-force' | 'expired';

export interface ResolvedFleetTopUpRule {
  status: FleetTopUpRuleStatus;
  kind: FleetTopUpRuleKind | null;
  /** true when the current leader did not ratify it; null when no leader is known. */
  inherited: boolean | null;
  ratifiedBy: string | null;
  reason: string | null;
  until: number | null;
  /** Set when a stored rule is unreadable; such a rule never holds. */
  malformed?: true;
}

function isFiniteEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Parse a stored rule. Anything short of a complete, attributed rule is null. */
export function parseFleetTopUpRule(raw: unknown): FleetTopUpRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'target-disabled' && r.kind !== 'supervise-revoked') return null;
  if (typeof r.ratifiedBy !== 'string' || !r.ratifiedBy.trim()) return null;
  if (typeof r.reason !== 'string' || !r.reason.trim()) return null;
  if (!isFiniteEpoch(r.ratifiedAt) || !isFiniteEpoch(r.until)) return null;
  const suspendedTarget =
    typeof r.suspendedTarget === 'number' && Number.isSafeInteger(r.suspendedTarget) && r.suspendedTarget > 0
      ? r.suspendedTarget
      : null;
  const suspendedSupervise = typeof r.suspendedSupervise === 'boolean' ? r.suspendedSupervise : null;
  return {
    kind: r.kind,
    ratifiedBy: r.ratifiedBy,
    ratifiedAt: r.ratifiedAt,
    reason: r.reason,
    until: r.until,
    suspendedTarget,
    suspendedSupervise,
  };
}

/**
 * Is a no-top-up rule still suspending this fleet's staffing?
 *
 * A rule holds only until its `until`. That one clock is what makes an INHERITED
 * rule (ratified by someone other than the current leader) expire unless the
 * current leader re-ratifies it: nobody can carry a predecessor's rule past the
 * window that predecessor ratified. `inherited` is reported so the brief can name
 * whose rule a successor is carrying. A stored-but-unreadable rule never holds.
 */
export function resolveFleetTopUpRule(args: {
  rule: unknown;
  leaderOwnerId: string | null | undefined;
  now: number;
}): ResolvedFleetTopUpRule {
  if (args.rule == null) {
    return { status: 'none', kind: null, inherited: null, ratifiedBy: null, reason: null, until: null };
  }
  const rule = parseFleetTopUpRule(args.rule);
  if (!rule) {
    return {
      status: 'expired',
      kind: null,
      inherited: null,
      ratifiedBy: null,
      reason: null,
      until: null,
      malformed: true,
    };
  }
  const inherited = args.leaderOwnerId ? rule.ratifiedBy !== args.leaderOwnerId : null;
  return {
    status: args.now < rule.until ? 'in-force' : 'expired',
    kind: rule.kind,
    inherited,
    ratifiedBy: rule.ratifiedBy,
    reason: rule.reason,
    until: rule.until,
  };
}

/** Why the governor will not restore this fleet's headcount. */
export type FleetHeadcountNotHeldReason =
  | 'no-target'
  | 'supervise-not-granted'
  | 'governor-flag-off'
  | 'winding-down'
  | 'top-up-rule';

/** The governance facts the governor itself checks, read by the caller. */
export interface FleetHeadcountGovernance {
  /** FLEET_HEADCOUNT_GOVERNOR; null when the flag read failed. */
  governorFlagOn: boolean | null;
  controlState: string | null;
  leaderOwnerId: string | null;
  now?: number;
}

/**
 * The governor's own eligibility test, stated once for every read surface.
 * Mirrors runFleetHeadcountGovernor (master flag), grantingHeadcountTargets
 * (supervise grant) and listFleetHeadcountTargets (target set, not winding down).
 * `profile` undefined = the profile read failed; null = no saved profile.
 */
export function resolveFleetHeadcountHeld(
  profile: FleetHeadcountTarget | null | undefined,
  governance: FleetHeadcountGovernance | undefined,
): Pick<FleetHeadcountState, 'held' | 'notHeldBecause' | 'topUpRule'> {
  if (profile === undefined || governance === undefined) {
    return { held: null, notHeldBecause: null, topUpRule: null };
  }
  const topUpRule = resolveFleetTopUpRule({
    rule: profile?.config?.topUpRule,
    leaderOwnerId: governance.leaderOwnerId,
    now: governance.now ?? Date.now(),
  });
  const ruled = topUpRule.status !== 'none';
  if (governance.controlState === 'winding-down') {
    return { held: false, notHeldBecause: 'winding-down', topUpRule };
  }
  if (profile == null || !profile.enabled) {
    return { held: false, notHeldBecause: ruled ? 'top-up-rule' : 'no-target', topUpRule };
  }
  if (profile.config?.supervise !== true) {
    return { held: false, notHeldBecause: ruled ? 'top-up-rule' : 'supervise-not-granted', topUpRule };
  }
  if (governance.governorFlagOn === false) {
    return { held: false, notHeldBecause: 'governor-flag-off', topUpRule };
  }
  if (governance.governorFlagOn == null) {
    return { held: null, notHeldBecause: null, topUpRule };
  }
  return { held: true, notHeldBecause: null, topUpRule };
}
