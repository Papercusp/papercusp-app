/**
 * plan-drain-transition.ts — P-004 of deterministic-plan-state-derivation-2026-08-31.
 *
 * The I/O half of the drained-plan status transition. The DECISION is pure and
 * lives in `@papercusp/plan-parser`'s `derivePlanStatusTransition`; this module
 * only supplies the plan and performs the write.
 *
 * # What problem this closes
 *
 * Nothing recomputed a plan's lifecycle `status` when its last non-terminal
 * item went terminal, so a finished plan kept advertising live work. Measured
 * on this corpus (plan D-004 point 7): **227 live plans** sat at
 * draft/ready/active with every structured item terminal. P-003 made
 * `plans:get` REPORT that contradiction; this makes the stored column stop
 * producing new ones.
 *
 * # Why a reaction rule and not a call inside plans/set-status.ts
 *
 * Same architecture as `plan-items/reconcile-rule.ts` and
 * `plan-items/lane-sync-rule.ts` (read either header for the full rationale):
 * the whole plan-item ⇄ plan lifecycle interplay stays ONE mechanism, visible
 * in `events:graph`, instead of a hardcoded call buried in one tool.
 *
 * # Why the whole decision happens inside the write lock
 *
 * "Is every item terminal?" and "flip the status" must observe the SAME bytes.
 * Reading the plan first and writing second would leave a window in which a
 * concurrent `plans:set-status` reopens an item, and the write would then
 * record `awaiting-acceptance` for a plan that has live work — manufacturing
 * exactly the contradiction this exists to remove. `withPlanLock` already
 * serialises same-plan writers, so doing the read, the derivation and the flip
 * inside its mutator makes the transition atomic for free.
 *
 * # Why it flips the frontmatter directly instead of calling plans:set-plan-status
 *
 * Two reasons, both deliberate. (1) That tool runs the conversation-activation
 * gate on a plan ENTERING `ready` (`entersActivationPlanStatus`), which would
 * demand a fresh `plans:audit` every time an item reopened — but the reverse
 * transition RESTORES a plan that was already activated; it is not a new
 * activation, and forcing an audit there would make reopening an item
 * arbitrarily expensive. (2) `applyPlanStatusBody` additionally stamps the
 * `## Now` block (terminal stamp for shipped/superseded, greenlit stamp for
 * `ready`), and stamping "greenlit" onto a plan greenlit months ago would write
 * a false claim into prose that P-002 derives. The plain status-line flip is
 * exactly the mutation warranted here and nothing more.
 *
 * # Why no acceptance / freshness lookup
 *
 * `derivePlanStatusTransition` needs one bit — is any item non-terminal — which
 * comes from the item graph alone. So this costs a single locked read and no
 * extra queries, and the stored `awaiting-acceptance` deliberately covers BOTH
 * drained verdicts (`implementation-complete`, where no rubric exists yet, and
 * `awaiting-acceptance`, where one is active). Whether the rubric has been
 * authored yet is the next ACTION, not a different state.
 */
import { derivePlanLifecycle, derivePlanStatusTransition, parsePlan } from '@papercusp/plan-parser';
import { flipPlanFrontmatterStatus } from './set-plan-status';
import { withPlanLock } from './with-plan-lock';
import { ensureAcceptanceDrainCarryInTransaction } from './acceptance-drain-filing';

/** Why a transition did not happen — every non-applied outcome is named, so a
 *  caller never has to read "false" and guess which of five reasons it was. */
export type PlanDrainTransitionSkip =
  /** No plan body at that slug/harness. */
  | 'not_found'
  /** The graph does not warrant a move (the overwhelmingly common case). */
  | 'no_transition_warranted'
  /** Frontmatter has no `status:` line to flip (legacy plan). */
  | 'no_status_line'
  /** The status changed under us between parse and flip — impossible while the
   *  lock is held, kept because the flip helper can still report it. */
  | 'unexpected_status'
  /** Already at the target. */
  | 'noop'
  /** Another writer holds the plan lock. Correct to drop rather than retry:
   *  the holder is itself a `plans:*` write, so it will emit its own
   *  `plans:set-status` event and this rule fires again on the far side of it
   *  with fresher bytes. Retrying here would queue behind a write whose result
   *  invalidates the decision we queued to make. */
  | 'busy';

export interface PlanDrainTransitionResult {
  applied: boolean;
  from?: string;
  to?: string;
  /** The evidence sentence from the pure decision, for logs and history. */
  reason?: string;
  skipped?: PlanDrainTransitionSkip;
  acceptanceCarry?: {
    outcome: 'created' | 'already-open';
    id: string | null;
  };
}

export interface PlanDrainTransitionOptions {
  /** Driver to receive the acceptance accountability task in the same tx. */
  accountableOwnerId?: string | null;
}

/** Shared locked-body decision for direct item writes and the reaction/backstop. */
export function planDrainTransitionMutation(current: string | null): {
  newBody: string | null;
  value: PlanDrainTransitionResult;
} {
  if (current === null) {
    return { newBody: null, value: { applied: false, skipped: 'not_found' } };
  }
  const parsed = parsePlan(current);
  const transition = derivePlanStatusTransition(
    parsed.frontmatter.status,
    derivePlanLifecycle(parsed.items),
  );
  if (transition === null) {
    return { newBody: null, value: { applied: false, skipped: 'no_transition_warranted' } };
  }
  const flip = flipPlanFrontmatterStatus(current, transition.to, transition.from);
  if (flip.newBody === null) {
    return {
      newBody: null,
      value: { applied: false, skipped: flip.code ?? 'no_transition_warranted' },
    };
  }
  return {
    newBody: flip.newBody,
    value: {
      applied: true,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
    },
  };
}

/**
 * Move ONE plan's stored lifecycle status if — and only if — its item graph
 * warrants it (see `derivePlanStatusTransition` for the exact, deliberately
 * narrow, jurisdiction: never `draft`, never terminal, never `shipped`).
 *
 * Best-effort and non-throwing by contract: it runs as a reaction to somebody
 * else's already-successful `plans:set-status` call, so a failure here must
 * never surface as a failure of THEIR write. The periodic backstop (P-005)
 * catches anything this misses.
 */
export async function applyPlanDrainTransition(
  planSlug: string,
  harnessSlug: string | null,
  options: PlanDrainTransitionOptions = {},
): Promise<PlanDrainTransitionResult> {
  const locked = await withPlanLock<PlanDrainTransitionResult>(
    null as never,
    {
      slug: planSlug,
      intent: 'plan-drain-transition: reconcile plan status against a drained item graph',
      ...(harnessSlug ? { harnessSlug } : {}),
      inTransaction: async (tx, writtenBody, scope, value) => {
        if (value.applied && value.to === 'awaiting-acceptance' &&
            parsePlan(writtenBody).frontmatter.template !== 'rubric') {
          const carry = await ensureAcceptanceDrainCarryInTransaction(tx, {
            workspaceId: scope.workspaceId,
            harnessSlug: scope.harnessSlug,
            planSlug,
            accountableOwnerId: options.accountableOwnerId,
          });
          value.acceptanceCarry = { outcome: carry.outcome, id: carry.id };
        }
      },
    },
    async (current) => planDrainTransitionMutation(current),
  );

  return locked.kind === 'applied' ? locked.value : { applied: false, skipped: 'busy' };
}
