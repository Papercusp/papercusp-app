/**
 * push-volume-guard — the per-class feed VOLUME guard for
 * ambient-semantic-push-2026-07-14 (Phase 4 P-009), built to plan D-004.
 *
 * ambient-push.selectPushes is SUPPOSED to keep every session class within its
 * per-class budget (D-004: a weak-model drone gets ≤ 2 pushes/window, never an
 * info severity, never below its floor). This module is the independent INVARIANT
 * CHECK of that promise: given a selection round's before/after (the candidates
 * considered vs the pushes actually delivered) plus the class policy, it
 * re-counts from scratch and reports any violation — so a regression that lets a
 * class over-deliver, leak a disallowed severity, or ship a below-floor push is
 * caught mechanically instead of silently drowning an agent.
 *
 * It deliberately does NOT trust selectPushes: it counts the delivered set itself
 * and re-applies the budget / severity / floor predicates. Cheap, pure,
 * deterministic — a guard you run in a test or a telemetry pass, never a control
 * path that mutates policy (carry D-001 / D-005: telemetry never steers). The
 * live leg is nothing more than calling this over the live selection output at a
 * hop boundary; that wiring rides later phases DEFAULT-OFF. PURE.
 */

import {
  policyFor,
  type SelectPushesResult,
  type PushSessionClass,
  type ClassPushPolicy,
  type PushSeverity,
} from './ambient-push';

/** One way the delivered feed broke the per-class contract. */
export interface VolumeViolation {
  kind: 'over-budget' | 'severity-not-allowed' | 'below-floor-delivered';
  detail: string;
}

export interface VolumeReport {
  sessionClass: PushSessionClass;
  budget: number;
  /** BEFORE selection: every candidate considered (selected + dropped). */
  candidateVolume: number;
  /** AFTER selection: pushes actually delivered this round. */
  deliveredVolume: number;
  /** Pushes already delivered to this session earlier in the window. */
  alreadyDelivered: number;
  /** deliveredVolume + alreadyDelivered — the total charged against budget. */
  totalAgainstBudget: number;
  /** Budget left for this round before it ran (max(0, budget − alreadyDelivered)). */
  remainingBudget: number;
  withinBudget: boolean;
  /** How far over budget the total is (0 when within). */
  overflow: number;
  violations: VolumeViolation[];
  /** No violations — the delivered feed honored the class contract. */
  ok: boolean;
}

export interface CheckPushVolumeInput {
  selection: SelectPushesResult;
  sessionClass: PushSessionClass;
  /** Pushes already delivered to this session this window (counts against budget). */
  alreadyDelivered?: number;
  /** Override the class policy (else the selection's own policy, else the default). */
  policy?: ClassPushPolicy;
}

/**
 * Check one selection round against its class contract. Re-counts the delivered
 * set independently and re-applies the budget, severity-gate, and floor
 * predicates, returning a report with any violations (never throws — a guard
 * reports, it does not blow up the feed). PURE.
 */
export function checkPushVolume(input: CheckPushVolumeInput): VolumeReport {
  const policy = input.policy ?? input.selection.policy ?? policyFor(input.sessionClass);
  const selected = input.selection.selected;
  const dropped = input.selection.dropped;

  const deliveredVolume = selected.length;
  const candidateVolume = deliveredVolume + dropped.length;
  const alreadyDelivered = Math.max(0, input.alreadyDelivered ?? 0);
  const totalAgainstBudget = deliveredVolume + alreadyDelivered;
  const remainingBudget = Math.max(0, policy.budget - alreadyDelivered);
  const overflow = Math.max(0, totalAgainstBudget - policy.budget);
  const withinBudget = overflow === 0;

  const violations: VolumeViolation[] = [];
  if (!withinBudget) {
    violations.push({
      kind: 'over-budget',
      detail: `delivered ${totalAgainstBudget} vs budget ${policy.budget} for class ${input.sessionClass} (over by ${overflow})`,
    });
  }
  for (const push of selected) {
    if (!policy.allowedSeverities.has(push.severity)) {
      violations.push({
        kind: 'severity-not-allowed',
        detail: `delivered a ${push.severity} push (${push.handle.ref}) to ${input.sessionClass}, which may not receive it`,
      });
    }
    if (push.score < policy.minScore) {
      violations.push({
        kind: 'below-floor-delivered',
        detail: `delivered a below-floor push (${push.handle.ref}, score ${push.score} < ${policy.minScore})`,
      });
    }
  }

  return {
    sessionClass: input.sessionClass,
    budget: policy.budget,
    candidateVolume,
    deliveredVolume,
    alreadyDelivered,
    totalAgainstBudget,
    remainingBudget,
    withinBudget,
    overflow,
    violations,
    ok: violations.length === 0,
  };
}

export interface WindowVolumeReport {
  sessionClass: PushSessionClass;
  budget: number;
  rounds: number;
  /** Cumulative pushes delivered across the whole window. */
  delivered: number;
  withinBudget: boolean;
  overflow: number;
}

/**
 * Aggregate a whole WINDOW of selection rounds for one session class (each round
 * a hop boundary) and check the cumulative delivered volume never exceeds the
 * class budget — the window-level invariant behind the per-round guard. PURE.
 */
export function checkWindowVolume(
  rounds: SelectPushesResult[],
  sessionClass: PushSessionClass,
  policy?: ClassPushPolicy,
): WindowVolumeReport {
  const pol = policy ?? policyFor(sessionClass);
  const delivered = rounds.reduce((n, r) => n + r.selected.length, 0);
  const overflow = Math.max(0, delivered - pol.budget);
  return {
    sessionClass,
    budget: pol.budget,
    rounds: rounds.length,
    delivered,
    withinBudget: overflow === 0,
    overflow,
  };
}

/** Convenience predicate for a telemetry/test assertion: did every delivered
 *  severity in this round belong to the class? (A focused re-statement of the
 *  severity invariant checkPushVolume also folds in.) PURE. */
export function deliveredSeveritiesAllowed(selection: SelectPushesResult, policy: ClassPushPolicy): boolean {
  return selection.selected.every((p: { severity: PushSeverity }) => policy.allowedSeverities.has(p.severity));
}
