/**
 * `system:plan-item-orphan-reconcile` — the periodic data-heal for EI-14693's
 * transition-gap. The reverse reconciler (`reconcileLinkedWorkItemsForPlanItem`)
 * only ever fires on a plan item's done *transition* (plan-items/reconcile-rule.ts),
 * so a work-item that reaches a NON-terminal state AFTER its plan item is already
 * terminal — a reset (EI-13337), a complete-without-state (D-004: EI-13318/13346/
 * 14676), or a late create — is never re-healed. It then pollutes every surface
 * that reads raw work-item `state`: the claim path (now separately guarded by
 * scheduler/plan-item-lane-guard.ts), pot:survey placement (spurious Mug wakes),
 * backlog counts, and drain-fleet re-work of already-done plan-lane items.
 *
 * This action is the thin registration seam: call the existing, terminal-aware,
 * fail-closed, idempotent `reconcileOrphanedPlanItemWorkItems` sweep on a cadence.
 * No new heal logic — it reuses the exact per-item reconciler (and its safety
 * rails: skip already-terminal, skip independent in-flight `lastProgressAt`
 * progress, never throw) and extends coverage to `dropped` plan items too.
 *
 * Config (routine `trigger_config`, optional):
 *   - `candidate_cap` — override DEFAULT_ORPHAN_SWEEP_CAP (500), the per-tick bound
 *     on distinct candidate plan-items enumerated.
 *
 * Homed as a bespoke periodic routine (NOT a bare setInterval — lint:no-raw-setinterval)
 * seeded by seed-plan-item-orphan-reconcile-routine.ts, mirroring system:gc-plan-runs.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { reconcileOrphanedPlanItemWorkItems } from '../../plan-items/reconcile-linked-work-items';

registerSystemAction('plan-item-orphan-reconcile', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const candidateCap = Number(cfg.candidate_cap);
  const result = await reconcileOrphanedPlanItemWorkItems(
    Number.isFinite(candidateCap) && candidateCap > 0 ? { candidateCap } : {},
  );
  // Quiet on a clean no-op tick (the common steady state); log only when the sweep
  // actually found terminal plan-items or healed something (terminalized, or the
  // EI-14699 lane park/un-park).
  if (
    result.terminalPlanItems > 0 ||
    result.reconciled.length > 0 ||
    result.gated.length > 0 ||
    result.ungated.length > 0 ||
    // EI-19460536530145188: a tick that DECLINED to close something is worth a
    // line even when it healed nothing else — that is the case an operator most
    // needs to see, and the one the old condition was silent about.
    result.skippedUnprovenLink.length > 0 ||
    // WI-39498: the plan-says-done contradiction census — a nonzero population of
    // open rows whose DONE plan item names them completed must never tick silently
    // (77 such rows burned agent after agent unreported). -1 = census read failed,
    // logged too: an unmeasured population must not render as a quiet zero.
    result.planSaysDoneOpen !== 0
  ) {
    console.log(
      `[plan-item-orphan-reconcile] ${ctx.installSlug}: ${result.candidatePlanItems}` +
        `${result.candidateWindowSaturated ? '+ (window saturated at cap — a floor)' : ''} candidate plan-item(s), ` +
        `${result.terminalPlanItems} terminal — reconciled ${result.reconciled.length} work-item(s), ` +
        `lane-parked ${result.gated.length}, lane-restored ${result.ungated.length} ` +
        `(${result.skippedInFlight.length} in-flight, ${result.skippedAlreadyTerminal.length} already-terminal skipped)` +
        (result.reconciled.length ? `: ${result.reconciled.join(', ')}` : '') +
        (result.gated.length ? ` [parked: ${result.gated.join(', ')}]` : '') +
        (result.ungated.length ? ` [restored: ${result.ungated.join(', ')}]` : '') +
        (result.skippedUnprovenLink.length
          ? ` [left OPEN — stamp-only link, no implements edge: ${result.skippedUnprovenLink.join(', ')}]`
          : '') +
        (result.planSaysDoneOpen !== 0
          ? result.planSaysDoneOpen > 0
            ? ` [WI-39498 census: ${result.planSaysDoneOpen} open row(s) whose DONE plan item names them completed — claim-time warning covers each]`
            : ' [WI-39498 census: FAILED — population unmeasured this tick]'
          : ''),
    );
  }
});
