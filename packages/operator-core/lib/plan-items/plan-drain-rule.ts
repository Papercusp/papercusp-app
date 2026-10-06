/**
 * plan-drain-rule.ts — P-004 of deterministic-plan-state-derivation-2026-08-31.
 *
 * When a structured item write crosses the terminal boundary/adds an item, a
 * content writer changes the currently warranted transition, or a lifecycle
 * writer attaches `ready` to an already-drained graph, re-read the plan and move
 * its lifecycle `status` if the graph warrants it. Creation/conversion and
 * draft→ready approval have no prior graph edge to cross, but their item graph
 * can already be drained.
 *
 * # Why matching stays cheap and synchronous
 *
 * The reaction matcher is pure and synchronous, so it cannot re-read the plan.
 * For `plans:set-status` it asks whether the item crossed the terminal boundary;
 * for `plans:add-item` it asks whether an item was successfully added. For
 * `plans:new` and `plans:set-frontmatter`, it asks whether the initial status
 * is non-draft. The
 * shared whole-content evaluator marks the three raw content writers only when
 * the before/after graph changes the transition currently warranted by the
 * stored status. The ACTION performs the authoritative graph check under the
 * plan lock.
 *
 * # The event shape — read this before changing the predicate
 *
 * Both tools are bulk-capable (`runBulk`/`bulkContent`), and the reaction
 * engine FANS a bulk result into one synthetic event PER ITEM without matching
 * the bulk-level carrier. The rules therefore see flat per-item records, never
 * `{ results: [...] }`.
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

/** One fanned per-item `plans:add-item` or `plans:set-status` result. */
interface PlanDrainWriteResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
  oldStatus?: string | null;
  newStatus?: string;
  planDrainTransitionChanged?: boolean;
}

function isTerminalItemStatus(status: string | null | undefined): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * The plan whose lifecycle may have changed, or null.
 *
 * A successful addition may reopen a drained plan; status flips only qualify
 * when they cross the terminal boundary. A `todo → wip` or
 * `done → dropped` flip leaves the drained bit untouched. Exported for tests.
 */
export function planWhoseDrainStateMayHaveChanged(
  e: ToolInvocationEvent,
): { planSlug: string; harnessSlug: string | null } | null {
  const r = e.result?.data as PlanDrainWriteResult | undefined;
  const itemWriteMayChangeDrain =
    typeof r?.itemId === 'string' &&
    (e.tool === 'plans:add-item' ||
      (e.tool === 'plans:set-status' &&
        typeof r.newStatus === 'string' &&
        isTerminalItemStatus(r.oldStatus) !== isTerminalItemStatus(r.newStatus)));
  const contentWriteMayChangeDrain =
    (e.tool === 'plans:set-content' ||
      e.tool === 'plans:edit' ||
      e.tool === 'plans:set-content-chunk') &&
    r?.planDrainTransitionChanged === true;
  // `ToolInvocationEvent.args` is `unknown`: narrow to an object before reading `status`.
  const requestedStatus =
    typeof e.args === 'object' && e.args !== null ? (e.args as { status?: unknown }).status : undefined;
  const initialPlanStatus = typeof requestedStatus === 'string' ? requestedStatus : 'draft';
  const initialLifecycleWriteMayChangeDrain =
    (e.tool === 'plans:new' || e.tool === 'plans:set-frontmatter') && initialPlanStatus !== 'draft';
  const readyLifecycleWriteMayChangeDrain =
    e.tool === 'plans:set-plan-status' && r?.changed === true && r.newStatus === 'ready';
  if (
    r?.ok === true &&
    typeof r.slug === 'string' &&
    (itemWriteMayChangeDrain ||
      contentWriteMayChangeDrain ||
      initialLifecycleWriteMayChangeDrain ||
      readyLifecycleWriteMayChangeDrain)
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

registerReactionRule({
  id: 'plan-drain:item-added',
  on: 'plans:add-item',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:plan-created',
  on: 'plans:new',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:legacy-plan-converted',
  on: 'plans:set-frontmatter',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:plan-readied',
  on: 'plans:set-plan-status',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:content-rewritten',
  on: 'plans:set-content',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:content-edited',
  on: 'plans:edit',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});

registerReactionRule({
  id: 'plan-drain:content-chunk-committed',
  on: 'plans:set-content-chunk',
  when: (e) => planWhoseDrainStateMayHaveChanged(e) !== null,
  fire: PLAN_DRAIN_TRANSITION_ACTION,
  args: (e) => ({ plans: [planWhoseDrainStateMayHaveChanged(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-drain',
});
