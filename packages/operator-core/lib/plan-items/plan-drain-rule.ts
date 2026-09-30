/**
 * plan-drain-rule.ts — P-004 of deterministic-plan-state-derivation-2026-08-31.
 *
 * When a `plans:set-status` flip moves an item ACROSS the terminal boundary,
 * re-read the plan and move its lifecycle `status` if the graph now warrants a
 * different one — `ready`/`active` → `awaiting-acceptance` once the last live
 * item goes terminal, and back to `ready` if one reopens.
 *
 * # Why the matcher only asks about the BOUNDARY
 *
 * The interesting question — "was that the last non-terminal item?" — cannot be
 * asked here. A reaction matcher is pure and synchronous; answering it requires
 * re-reading the plan, which is I/O. So the matcher asks the cheap pure
 * question it CAN answer (did this flip change whether the item is terminal?)
 * and the ACTION, which may do I/O, asks the real one. A `todo → wip` flip
 * cannot change whether a plan is drained, so it is filtered out here and never
 * costs a read.
 *
 * # The event shape — read this before changing the predicate
 *
 * `plans:set-status` is bulk-capable (`runBulk`/`bulkContent`), and the
 * reaction engine FANS a bulk result into one synthetic event PER ITEM without
 * matching the bulk-level carrier. So this rule sees the flat per-item record
 * `{ ok, slug, itemId, oldStatus, newStatus }`, never `{ results: [...] }`.
 * Reading the bulk shape is precisely the bug that made `reconcile-rule.ts`
 * silently never fire (EI-6960; the same caveat is restated in
 * `lane-sync-rule.ts` for EI-6980). A bulk flip of N items therefore produces N
 * reactions on the SAME plan; the action is idempotent — whichever one runs
 * first performs the transition and the rest find none warranted — so the fan
 * needs no dedup to be correct, only to be tidy.
 */
import { registerReactionRule } from '../events';
import { PLAN_DRAIN_TRANSITION_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

/** One fanned per-item `plans:set-status` result. */
interface SetStatusItemResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
  oldStatus?: string | null;
  newStatus?: string;
}

function isTerminalItemStatus(status: string | null | undefined): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * The plan whose drained-ness this flip may have changed, or null.
 *
 * Gated on the terminal BOUNDARY rather than on any status change: a
 * `todo → wip` or `done → dropped` flip leaves the drained bit untouched, so
 * reacting to it would re-read the plan to learn nothing. Exported for the
 * unit test.
 */
export function planWhoseDrainStateMayHaveChanged(
  e: ToolInvocationEvent,
): { planSlug: string; harnessSlug: string | null } | null {
  const r = e.result?.data as SetStatusItemResult | undefined;
  if (
    r?.ok === true &&
    typeof r.slug === 'string' &&
    typeof r.itemId === 'string' &&
    typeof r.newStatus === 'string' &&
    isTerminalItemStatus(r.oldStatus) !== isTerminalItemStatus(r.newStatus)
  ) {
    // Thread the triggering call's harness through, exactly as reconcile-rule
    // does (EI-8970): re-reading under the operator-home harness would resolve
    // a DIFFERENT plan row for a plan that lives elsewhere.
    const harnessSlug = typeof e.ctx?.harnessSlug === 'string' ? e.ctx.harnessSlug : null;
    return { planSlug: r.slug, harnessSlug };
  }
  return null;
}

registerReactionRule({
  id: 'plan-drain:terminality-changed',
  on: 'plans:set-status',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});
