/**
 * `system:gc-dead-loops` — the registration seam for {@link gcDeadLoops}
 * (agents-system-pane-split-2026-07-26 P-007).
 *
 * Thin by design, matching `gc-plan-runs-action.ts`: the sweep logic and its safety
 * conditions live in `gc-dead-loops.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `retention_days` — override DEAD_LOOP_RETENTION_DAYS_DEFAULT (14).
 *   - `max_per_run`    — override DEAD_LOOP_MAX_PER_RUN_DEFAULT (500).
 *   - `dry_run`        — report matches without deleting.
 *
 * Workspace-scoped, not harness-scoped: `loop-<ownerId>` rows are keyed by the
 * SESSION that armed them, and a session's loop can carry any install_slug (the pot
 * it was working in), so sweeping per-install would leave rows stranded under pots
 * that no longer run a routine tick.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcDeadLoops } from './gc-dead-loops';

registerSystemAction('gc-dead-loops', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const retentionDays = Number(cfg.retention_days);
  const maxPerRun = Number(cfg.max_per_run);
  const result = await gcDeadLoops({
    workspaceId: ctx.workspaceId,
    dryRun: cfg.dry_run === true,
    ...(Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : {}),
    ...(Number.isFinite(maxPerRun) && maxPerRun > 0 ? { maxPerRun } : {}),
  });
  if (result.reaped > 0) {
    console.log(
      `[gc-dead-loops] ${result.dryRun ? 'would reap' : 'reaped'} ${result.reaped} dead loop routine(s) ` +
        `(owner silent > ${result.retentionDays}d), e.g. ${result.sample.join(', ')}`,
    );
  }
});
