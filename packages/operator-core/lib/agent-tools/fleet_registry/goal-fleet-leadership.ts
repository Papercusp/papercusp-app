/**
 * Pure GOAL-holder leadership rule, shared by every fleet entry door.
 * A holder stewards the portfolio and delegates execution fleet leadership.
 */
export type GoalFleetLeadershipResolution =
  | { ok: true; leader: 'caller' | 'spawn'; defaultedToSpawn: boolean }
  | { ok: false; message: string };

export function resolveGoalFleetLeadership(args: {
  /** The caller's own GOAL-mode subject; inherited goal provenance does not count. */
  goalHolderSubject: string | null;
  requested?: 'caller' | 'spawn';
  callerOwnerId: string;
  existingLeaderOwnerId?: string | null;
}): GoalFleetLeadershipResolution {
  if (!args.goalHolderSubject) {
    return { ok: true, leader: args.requested ?? 'caller', defaultedToSpawn: false };
  }
  if (args.existingLeaderOwnerId === args.callerOwnerId) {
    return {
      ok: false,
      message:
        `goal_plan_fleet_self_leadership: GOAL holder ${args.callerOwnerId} already leads this fleet. ` +
        'Delegate leadership to a separate agent before topping it up; a later handoff is remediation, not a valid GOAL launch.',
    };
  }
  if (args.requested === 'caller') {
    return {
      ok: false,
      message:
        `goal_plan_fleet_self_leadership: GOAL holder ${args.callerOwnerId} cannot lead a plan fleet. ` +
        "Omit `leader` or pass `leader:'spawn'` so a separate agent leads while the GOAL holder remains the portfolio steward.",
    };
  }
  return { ok: true, leader: 'spawn', defaultedToSpawn: args.requested === undefined };
}
