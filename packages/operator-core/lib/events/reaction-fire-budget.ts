/**
 * The per-contributor fire budget (P-030 clause c).
 *
 * `event_reactions.depth` + `cause_root_run_id` already bound cascades globally,
 * but that consumer was designed when every rule was first-party. `guardReaction`
 * caps ONE chain at `MAX_REACTION_DEPTH` and detects cycles — so N *shallow*
 * rules from one contributor, each firing depth-1, are entirely unbounded by it.
 * Once a third party can install rules, that is the gap: not a runaway cascade,
 * but a steady, individually-legal stream nobody is counting.
 *
 * This is the HOST half. The generic engine owns only the port
 * (`FireBudget`); the policy, the ledger and the window live here.
 *
 * Three properties worth stating, because each is a decision and not an accident:
 *
 *   - It is checked BEFORE the durable-vs-in-process split in `scheduleReaction`.
 *     `mode:'durable'` is the DEFAULT, so a budget applied around `fireInProcess`
 *     would leave the default route unbudgeted while passing an in-process test.
 *   - It FAILS OPEN. A budget is a fairness/cost control, not a safety
 *     kill-switch — the depth cap already bounds the catastrophic case — so a
 *     broken ledger must not silently stop every reaction in the system.
 *   - First-party rules are EXEMPT by construction. They write
 *     `contributor = null`, which is also precisely the population 1169's partial
 *     index excludes, so the index and the semantics agree.
 */

import type { FireBudgetDecision, FireBudgetRequest } from '@papercusp/event-reaction';
import { countRecentContributorFires } from './reaction-dedup';
import type { ToolInvocationEvent } from './types';

/**
 * Fires allowed per contributor per window.
 *
 * Sized to be invisible to any plausible legitimate rule and obvious for a
 * runaway one: a contributor reacting to a busy tool a couple of times a minute
 * sits far under it, while a rule firing on every tool call on this box crosses
 * it within minutes. It is a backstop, not a quota to tune against.
 */
export const DEFAULT_CONTRIBUTOR_FIRE_BUDGET = 500;

/** The window the budget counts over — mirrors `REACTION_FAILURE_ALERT_WINDOW_MINUTES`. */
export const CONTRIBUTOR_FIRE_BUDGET_WINDOW_MINUTES = 60;

/**
 * Decide whether one contributor's reaction may fire.
 *
 * `deps` is injectable in exactly the shape `surfaceReactionFailure` uses, which
 * is what makes the policy unit-testable without a database.
 */
export async function checkContributorFireBudget(
  req: FireBudgetRequest<ToolInvocationEvent, string>,
  deps?: {
    count?: typeof countRecentContributorFires;
    log?: (msg: string) => void;
    budget?: number;
    windowMinutes?: number;
  },
): Promise<FireBudgetDecision> {
  // First-party rules are out of scope: the clause bounds contributors, and a
  // built-in has no contributor to bound. Budgeting `null` would lump every
  // built-in into one shared bucket and let the system throttle itself.
  const contributor = req.contributor;
  if (!contributor) return { allow: true };

  const workspaceId = req.event.ctx.workspaceId ?? req.event.ctx.principal?.workspaceId ?? null;
  // No workspace means no ledger to count against — allow rather than invent a
  // denial from a measurement that was never taken.
  if (!workspaceId) return { allow: true };

  const log = deps?.log ?? ((msg: string) => console.warn(`[events] ${msg}`));
  const count = deps?.count ?? countRecentContributorFires;
  const budget = deps?.budget ?? DEFAULT_CONTRIBUTOR_FIRE_BUDGET;
  const windowMinutes = deps?.windowMinutes ?? CONTRIBUTOR_FIRE_BUDGET_WINDOW_MINUTES;

  let recent: number;
  try {
    recent = await count({ workspaceId, contributor, windowMinutes });
  } catch (e) {
    // FAIL OPEN — see the header. An unreachable ledger must not become a
    // system-wide reaction outage.
    log(
      `fire budget count for contributor ${contributor} failed; allowing the reaction: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return { allow: true };
  }

  if (recent < budget) return { allow: true };
  return {
    allow: false,
    reason:
      `contributor "${contributor}" has fired ${recent} reactions in the last ${windowMinutes}m, ` +
      `at or over its budget of ${budget}`,
  };
}
