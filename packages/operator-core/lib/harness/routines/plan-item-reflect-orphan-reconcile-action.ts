/**
 * `system:plan-item-reflect-orphan-reconcile` — the periodic data-heal for the
 * REFLECT direction (work_item terminal → plan item still `todo`).
 *
 * The mirror of `plan-item-orphan-reconcile-action.ts`. That one heals direction
 * A (a plan item went done, its linked work-items did not); this one heals
 * direction B, which until now had a reaction rule (plan-items/reflect-rules.ts)
 * and NO periodic backstop — so any event the reaction missed (the EI-6960
 * window where the rule silently never fired, an operator restart, a close path
 * that never emitted) left the plan item reading `todo` permanently. That is the
 * phantom-todo agents re-investigate and nearly re-implement
 * (EI-18713141708830049); 30 such items were measured on this install
 * 2026-08-13.
 *
 * This action is the thin registration seam: call the existing strict,
 * fail-closed, idempotent `reflectOrphanedPlanItems` sweep on a cadence. No new
 * heal logic and no new write path — the flip goes through the real
 * `plans:set-status` tool, and the target status through reflect-rules' own
 * exported mapping.
 *
 * Config (routine `trigger_config`, optional):
 *   - `candidate_cap` — override DEFAULT_REFLECT_SWEEP_CAP (500), the per-tick
 *     bound on distinct candidate plan-items enumerated.
 *
 * Homed as a bespoke periodic routine (NOT a bare setInterval —
 * lint:no-raw-setinterval) seeded by
 * seed-plan-item-reflect-orphan-reconcile-routine.ts.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { reflectOrphanedPlanItems } from '../../plan-items/reflect-orphaned-plan-items';

registerSystemAction('plan-item-reflect-orphan-reconcile', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const candidateCap = Number(cfg.candidate_cap);
  const result = await reflectOrphanedPlanItems(
    Number.isFinite(candidateCap) && candidateCap > 0 ? { candidateCap } : {},
  );
  // Quiet on a clean no-op tick (the steady state once the residue is drained);
  // log only when the sweep actually changed something or hit a failure.
  if (result.flipped.length > 0 || result.failed.length > 0) {
    console.log(
      `[plan-item-reflect-orphan-reconcile] ${ctx.installSlug}: candidates=${result.candidatePlanItems} ` +
        `flipped=${result.flipped.length} failed=${result.failed.length}` +
        (result.flipped.length ? ` → ${result.flipped.slice(0, 10).join(', ')}` : '') +
        (result.failed.length ? ` !! ${result.failed.slice(0, 5).join(' | ')}` : ''),
    );
  }
  // SystemAction returns `void | SystemActionResult` (durableSpawns only) — this
  // sweep starts no child workflows, so it returns nothing.
});
