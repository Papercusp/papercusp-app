/**
 * P-005 / D-030 step 5: the UNDER-staff detector, counterpart of leader-brief's
 * over-staff `fleetHeadcountVsExecutableFrontierAlert`.
 *
 * Measured gap it closes: a fleet at target:null read verdict 'disabled' with no
 * alarm while it ran zero workers for hours (the D-008 incident), and a fleet
 * whose target nobody held (supervise never granted) read "under strength" as if
 * something would restore it. This detector fires on the shortfall itself and its
 * reason names WHY nothing is (or is) restoring the fleet: `held`,
 * `notHeldBecause` and the no-top-up rule, all read from the one
 * FleetHeadcountState projection every fleet surface shares.
 *
 * Pure and detector-only: it never launches, resizes or re-grants anything. The
 * caller attaches the falsifier. Lives here rather than in agent-fleets-store for
 * the same reason as top-up-rule.ts: dozens of tests full-vi.mock the store, so
 * anything imported from it as a value is undefined there.
 */
import type { FleetHeadcountState } from '../agent-fleets-store';
import type { FleetHeadcountNotHeldReason, ResolvedFleetTopUpRule } from './top-up-rule';

export interface FleetUnderStaffedEvaluation {
  alert: boolean;
  /** Productive workers, as `headcount.current` measured them. */
  current: number;
  /** The public target; null when none is set (a disabled profile reads null). */
  target: number | null;
  /** target - current when a target is set; null when none is. */
  shortfall: number | null;
  held: boolean | null;
  notHeldBecause: FleetHeadcountNotHeldReason | null;
  topUpRule: ResolvedFleetTopUpRule | null;
  /** The action that clears the alarm, named for this cause. Present when alert. */
  repair?: string;
  reason?: string;
}

const RESTORE = 'fleet:headcount-target { target, supervise:true }';

function isoOrUnknown(epochMs: number | null): string {
  return epochMs != null && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : 'an unknown time';
}

function describeRule(rule: ResolvedFleetTopUpRule): string {
  if (rule.malformed) return 'Its stored no-top-up rule is unreadable, so it does not hold anything.';
  const by =
    rule.inherited === true
      ? `${rule.ratifiedBy} (a previous leader: the current leader has not re-ratified it)`
      : (rule.ratifiedBy ?? 'an unknown ratifier');
  const why = rule.reason ? `: "${rule.reason}"` : '';
  if (rule.status === 'expired') {
    return (
      `Its no-top-up rule, ratified by ${by}${why}, expired at ${isoOrUnknown(rule.until)}. ` +
      'The governor lapses it on its next tick and restores what it suspended; a fleet that ' +
      'never had supervise granted gets nothing back and stays unheld.'
    );
  }
  return `A no-top-up rule ratified by ${by}${why} keeps it unstaffed until ${isoOrUnknown(rule.until)}.`;
}

function explain(
  h: FleetHeadcountState,
  target: number | null,
): { cause: string; repair: string } {
  if (h.held === true) {
    return {
      cause:
        'The headcount governor holds this fleet and relaunches toward the target on its next tick. ' +
        'If the shortfall survives several ticks, the governor is failing: read its last error on ' +
        'the fleet:headcount-target profile.',
      repair: 'none needed while the governor is restoring it',
    };
  }
  if (h.held == null) {
    return {
      cause:
        'Whether the headcount governor holds this fleet could not be read, so nothing confirms it ' +
        'will be restored.',
      repair: `confirm with a fresh fleet:leader-brief; if still unheld, ${RESTORE}`,
    };
  }
  switch (h.notHeldBecause) {
    case 'no-target':
      return {
        cause: 'No headcount target is set, so nothing will add workers.',
        repair: `${RESTORE}, fleet:launch-on-plan, or fleet:wind-down if the fleet's work is finished`,
      };
    case 'supervise-not-granted':
      return {
        cause: `Target ${target ?? '?'} is recorded but supervise was never granted, so the governor does not hold it.`,
        repair: RESTORE,
      };
    case 'governor-flag-off':
      return {
        cause: 'FLEET_HEADCOUNT_GOVERNOR is OFF, so the governor holds no fleet at all.',
        repair: 'fleet:launch-on-plan to staff it by hand (the flag itself is owner-controlled)',
      };
    case 'top-up-rule':
      return {
        cause: h.topUpRule ? describeRule(h.topUpRule) : 'A no-top-up rule holds it unstaffed.',
        repair:
          'if the rule still applies, re-ratify it with fleet:headcount-target { target:null, reason, untilHours }; ' +
          `otherwise ${RESTORE}, or fleet:wind-down if the fleet's work is finished`,
      };
    default:
      return { cause: 'The governor does not hold this fleet.', repair: RESTORE };
  }
}

/**
 * Fires on an active fleet whose productive headcount is known and either below
 * its target, or zero with no target set. `undefined` means unknown or not
 * applicable (unread profile/control state/headcount, a paused or winding-down
 * fleet), never a fabricated all-clear.
 */
export function computeFleetUnderStaffedAlert(input: {
  headcount: FleetHeadcountState | null | undefined;
  /** The fleet's control state; null/undefined when it could not be read. */
  controlState: string | null | undefined;
  fleetPaused?: boolean | null;
}): FleetUnderStaffedEvaluation | undefined {
  const h = input.headcount;
  if (!h || h.enabled == null) return undefined;
  if (input.fleetPaused) return undefined;
  if (input.controlState == null || input.controlState === 'winding-down') return undefined;
  const current = h.current;
  if (current == null || !Number.isSafeInteger(current) || current < 0) return undefined;

  const target = h.target;
  const base = {
    current,
    target,
    shortfall: target != null ? Math.max(0, target - current) : null,
    held: h.held,
    notHeldBecause: h.notHeldBecause,
    topUpRule: h.topUpRule,
  };
  const under = target != null ? current < target : current === 0;
  if (!under) return { alert: false, ...base };

  const { cause, repair } = explain(h, target);
  const measured =
    target != null
      ? `${current} of ${target} target worker(s) are productive (short ${base.shortfall}).`
      : 'The fleet has 0 productive workers and no headcount target.';
  return { alert: true, ...base, repair, reason: `${measured} ${cause} Repair: ${repair}.` };
}
