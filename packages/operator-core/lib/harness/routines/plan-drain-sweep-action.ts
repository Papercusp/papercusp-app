/**
 * `system:plan-drain-sweep` — P-005 of deterministic-plan-state-derivation-2026-08-31.
 *
 * The periodic half of P-004's rule-for-immediacy + sweep-for-backstop pairing
 * (the same split as `plan-items/reconcile-rule.ts` + `plan-item-orphan-reconcile`).
 * P-004's reaction fires on a `plans:set-status` call, so it can only fix drift
 * created from now on; the ~205 plans whose graphs drained BEFORE it shipped have
 * no future event to trigger on. This tick re-examines them.
 *
 * Thin registration seam only: all logic — including every exclusion and the
 * reasons for it — lives in `agent-tools/plans/plan-drain-sweep.ts`, and the
 * authoritative decision stays in `@papercusp/plan-parser`'s pure
 * `derivePlanStatusTransition`. No new heal logic here.
 *
 * Config (routine `trigger_config`, optional):
 *   - `cap` — override DEFAULT_PLAN_DRAIN_SWEEP_CAP (25), the per-tick bound on
 *     plans FLIPPED. Bounds the first tick's bulk rewrite of historical rows.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepDrainedPlanStatuses } from '../../agent-tools/plans/plan-drain-sweep';

registerSystemAction('plan-drain-sweep', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const cap = Number(cfg.cap);
  const result = await sweepDrainedPlanStatuses(
    Number.isFinite(cap) && cap > 0 ? { cap } : {},
  );

  const skippedPairs = Object.entries(result.skipped).filter(([, n]) => n > 0);

  // Quiet on a clean no-op tick — the steady state once the backlog drains, and
  // the overwhelming majority of ticks thereafter. Anything that CHANGED a plan,
  // deferred work to the next tick, or was refused gets a line: a permanently
  // nonzero `deferredToNextTick` means the cap is below the arrival rate, which
  // must be visible rather than quietly lossy.
  if (result.applied.length > 0 || result.deferredToNextTick > 0 || skippedPairs.length > 0) {
    console.log(
      `[plan-drain-sweep] ${ctx.installSlug}: scanned ${result.scanned}, ` +
        `${result.warranted} warranted — flipped ${result.applied.length}` +
        (result.deferredToNextTick > 0
          ? `, ${result.deferredToNextTick} deferred to the next tick (cap reached)`
          : '') +
        (skippedPairs.length
          ? ` [not applied: ${skippedPairs.map(([k, n]) => `${k}×${n}`).join(', ')}]`
          : '') +
        (result.applied.length
          ? `: ${result.applied.map((a) => `${a.planSlug} ${a.from}→${a.to}`).join(', ')}`
          : ''),
    );
    // The pure decision's evidence sentence, one line per flip. A status change on
    // a historical plan must never be traceable only to "a sweep did it".
    for (const a of result.applied) {
      console.log(`[plan-drain-sweep]   ${a.harnessSlug}/${a.planSlug}: ${a.reason}`);
    }
  }
});
