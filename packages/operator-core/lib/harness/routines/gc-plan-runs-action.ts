/**
 * `system:gc-plan-runs` — the periodic janitor wiring up for `gcScheduledPlanRuns`
 * (gc-plan-runs.ts, P-027/D-015). That function has existed since
 * scheduled-recurring-plans-2026-06-16 fully implemented AND tested
 * (gc-plan-runs.integration.test.ts) but was NEVER actually invoked outside its
 * own test — no routine, no registered system action, nothing on any cadence.
 *
 * Confirmed live-caught (WI-5271/WI-5273, 2026-07-17): a 15-min scheduled plan
 * (`critical-severity-alert-2026-07-06`) accrued 946 terminal ('done') runs over
 * ~10.5 days, every one of them WELL past both this janitor's default retention
 * (`KEEP_LAST_N_DEFAULT=50`, `MAX_AGE_DAYS_DEFAULT=90` — 946 >> 50, though none
 * were 90+ days old yet) — every single one still sitting as a permanent
 * status='active' `harness_plans` row because nothing ever called the sweep. Any
 * OTHER 15-min-or-faster scheduled plan hits the identical unbounded-growth class.
 *
 * This action is the thin registration seam: call the existing, already-tested
 * `gcScheduledPlanRuns` on a cadence. No new sweep logic — reuse-first.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `keep_last_n` — override KEEP_LAST_N_DEFAULT (50).
 *   - `max_age_days` — override MAX_AGE_DAYS_DEFAULT (90).
 *
 * Runs harness-scoped (ctx.installSlug) — each harness's routine sweeps only its
 * own scheduled-plan runs, matching gcScheduledPlanRuns's own `harnessSlug` scoping
 * and this repo's per-harness routine convention (one row per install_slug/name).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcScheduledPlanRuns } from './gc-plan-runs';

registerSystemAction('gc-plan-runs', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const keepLastN = Number(cfg.keep_last_n);
  const maxAgeDays = Number(cfg.max_age_days);
  const result = await gcScheduledPlanRuns({
    harnessSlug: ctx.installSlug,
    ...(Number.isFinite(keepLastN) && keepLastN > 0 ? { keepLastN } : {}),
    ...(Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? { maxAgeDays } : {}),
  });
  console.log(
    `[gc-plan-runs] ${ctx.installSlug}: swept ${result.gcRuns} run(s) — ` +
      `${result.instancePlans} instance plan(s), ${result.workItems} work item(s), ` +
      `${result.transcriptTurns} transcript turn(s) removed`,
  );
});
