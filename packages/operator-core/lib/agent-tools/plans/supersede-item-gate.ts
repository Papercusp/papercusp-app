/**
 * The supersede-time unfinished-items refusal (EI-19403437795858863).
 *
 * A plan's terminal LABEL is an author-declared frontmatter field with no
 * structural relationship to its child ITEM graph. Measured against live
 * papercusp-workspace data on 2026-09-04: 26 `superseded` plans carried 266
 * non-terminal items, versus 17 `shipped` plans carrying 38 — i.e. the
 * supersede path strands SEVEN TIMES the items the ship path does, because
 * `shouldEvaluateAcceptanceGate` fires only on `shipped`, so the acceptance
 * gate's well-built `plan_items_unfinished` refusal never runs on a deprecate.
 *
 * ## Why this is a separate gate and not `shouldEvaluateAcceptanceGate ||=`
 *
 * Widening the acceptance gate to cover `superseded` is the obvious one-line
 * fix and it is WRONG. That gate requires an acceptance rubric, a code-truth
 * audit, an independent peer grade and a citation-deployment probe — and it
 * LAUNCHES an acceptance grader on an ungraded refusal. Demanding a graded
 * acceptance rubric in order to deprecate a dead draft inverts the point of
 * deprecating it, and would spawn a grader agent per abandoned plan. Only the
 * unfinished-items leg transfers, so only that leg is reused here: the same
 * `UNFINISHED_ITEM_STATUSES` constant and the same remedy the ship refusal
 * already prescribes.
 *
 * ## The judgement this encodes
 *
 * Superseding a plan with open children is LEGITIMATE — a whole plan can be
 * abandoned, and often should be. What this refuses is doing it SILENTLY,
 * which is the identical rule the ship refusal already states in its own
 * message: "Departing from the plan is legitimate; departing from it silently
 * is what this refuses." A deprecate is a wholesale departure, so it gets the
 * same treatment and the same two exits — drop the items with a reason (one
 * bulk `plans:set-status` call, since that tool is bulk-by-default), or
 * `force: { reason }`, which is recorded on the plan as a permanent waiver.
 *
 * Deliberately NOT built (reuse-first): the originating idea's `--fork-debt`
 * escape hatch — an auto-created successor plan inheriting the open items,
 * tagged `plan-debt` with a backlink. That is a whole new durable surface for
 * a problem the existing refusal + waiver already solve at the same choke
 * point.
 */

import {
  UNFINISHED_ITEM_STATUSES,
  getPlanItemStatuses,
  type PlanItemStatus,
} from '../../plan-audits';
import type { ForcedPastRecord } from './forced-past-stamp';

/** Refusal code for a deprecate that would strand non-terminal items.
 *  Distinct from the ship path's `plan_items_unfinished` so the two are
 *  independently greppable in logs, tests and triage. */
export const SUPERSEDE_ITEMS_UNFINISHED = 'supersede_items_unfinished';

/** Max item ids named inline before the message summarises the rest. Matches
 *  the plans:lint sibling warning so the two read the same way. */
const MAX_LISTED = 12;

/**
 * Whether the supersede item gate must run before a lifecycle write.
 *
 * Mirrors `shouldEvaluateAcceptanceGate`'s idempotent-repair carve-out: a
 * caller passing `expectedCurrent:'superseded'` is re-running a repair pass
 * over an ALREADY-superseded plan, not entering the state, and must not be
 * refused for residue it did not create. The CAS guard inside the plan lock
 * still rejects a plan that is not actually superseded.
 */
export function shouldEvaluateSupersedeItemGate(status: string, expectedCurrent?: string): boolean {
  return status === 'superseded' && expectedCurrent !== 'superseded';
}

/** The non-terminal items of a plan — `done` and `dropped` are both terminal,
 *  `dropped` because it is a recorded decision rather than residue. */
export function unfinishedPlanItems(items: readonly PlanItemStatus[]): PlanItemStatus[] {
  return items.filter((i) => (UNFINISHED_ITEM_STATUSES as readonly string[]).includes(i.status));
}

export function supersedeItemRefusalMessage(
  planSlug: string,
  unfinished: readonly PlanItemStatus[],
  totalItems: number,
): string {
  const shown = unfinished.slice(0, MAX_LISTED).map((i) => `${i.itemId} (${i.status})`);
  const more = unfinished.length > shown.length ? `, +${unfinished.length - shown.length} more` : '';
  return (
    `plan '${planSlug}' cannot be superseded: ${unfinished.length} of its ${totalItems} item(s) are still ` +
    `non-terminal — ${shown.join(', ')}${more}. Deprecating a plan is a wholesale departure from it, so the ` +
    `same rule applies as when shipping: departing from a plan is legitimate, departing from it SILENTLY is ` +
    `what this refuses. A terminal plan label with open items corrupts every is-this-done query and hides ` +
    `real work from burn-down. Drop them in ONE call — plans:set-status { slug:'${planSlug}', ` +
    `itemIds:[${unfinished
      .slice(0, MAX_LISTED)
      .map((i) => `'${i.itemId}'`)
      .join(', ')}${more ? ', …' : ''}], status:'dropped', note:'<why this was abandoned>' } — and if some of ` +
    `the work moved to a successor plan, say which in the note. To deprecate anyway, pass force:{ reason }; ` +
    `it is recorded permanently on the plan.`
  );
}

export interface SupersedeItemGateResult {
  satisfied: boolean;
  code?: string;
  message?: string;
  /** Populated only on a forced pass, so the caller stamps the waiver. */
  forcedPast?: ForcedPastRecord;
}

/**
 * Evaluate the gate for one plan.
 *
 * FAILS OPEN on an unreadable item index. `getPlanItemStatuses` returns `[]`
 * both for a plan with no items and for a PG read failure, and its own
 * contract forbids reading empty as "no items" — so an empty list can never
 * produce a refusal here. That is the correct direction for a blocking write:
 * an infra blip must not wedge a deprecate.
 */
export async function evaluateSupersedeItemGate(
  planSlug: string,
  opts: { force?: { reason: string } } = {},
): Promise<SupersedeItemGateResult> {
  const items = await getPlanItemStatuses(planSlug);
  const unfinished = unfinishedPlanItems(items);
  if (unfinished.length === 0) return { satisfied: true };

  if (opts.force) {
    return {
      satisfied: true,
      forcedPast: { reason: opts.force.reason, checks: [SUPERSEDE_ITEMS_UNFINISHED] },
    };
  }

  return {
    satisfied: false,
    code: SUPERSEDE_ITEMS_UNFINISHED,
    message: supersedeItemRefusalMessage(planSlug, unfinished, items.length),
  };
}
