/**
 * `system:sync-batch-delta-check` — per-git-sync-batch verification of `staging`
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31, P-012).
 *
 * WIRING ONLY. Every decision — cursor discipline, radius caps, load-skip,
 * confirm-before-file, batch attribution, the finding body — is pure and
 * unit-tested in `../../release/sync-batch-delta-check.ts`; the IO seams live in
 * `../../release/sync-batch-delta-check-deps.ts` (the
 * `frozen-candidate-drift-sweep-action.ts` shape, lazy-imported so a broken leg
 * can never poison engine boot).
 *
 * WHAT IT CLOSES: ~800 commits/day land on `staging` and NOTHING verifies any of
 * them until the hourly green-checkpoint's 55-115 min full suite — by which time
 * 40-226 files are failing and attribution has decayed (plan D-001). This samples
 * the STREAM instead of the endpoint: every 5 min, run the bounded affected
 * radius for the commits since a durable cursor and file ONE deduped, SLA-carrying
 * work-item per confirmed red, attributed to the newest batch that can reach it.
 *
 * BOUNDED BY CONSTRUCTION: skips under host load, skips while a green-checkpoint
 * suite runs (never fight the gate), refuses radii wider than
 * maxWorkspaces=3 / maxPaths=80 / maxCommits=40, and every "could not measure"
 * resolves to holding the cursor — never to a false green. It is an OBSERVER: no
 * auto-revert, no gate firing, no agent spawn (spend: 'none').
 *
 * The desktop-shell precedent for the self-gate: the affected/typecheck runner
 * scripts only exist in the operator-home repo, so a stray per-hive routine row
 * must skip, never try.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Generous ceiling for one tick (probe + one bounded affected run + tsc + up to
 *  3 single-file confirms); the per-leg spawnSync budgets in the deps module are
 *  the real bound. concurrency:'skip' on the routine row means an overrunning
 *  fire simply absorbs the next tick(s). */
export const SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS = 45 * 60_000;

registerSystemAction(
  'sync-batch-delta-check',
  async (ctx: SystemActionCtx) => {
    const home = operatorHomeHarnessSlug();
    if (ctx.installSlug && ctx.installSlug !== home) {
      console.log(`[sync-batch-delta] skip: not the operator-home harness (got "${ctx.installSlug}", home "${home}")`);
      return;
    }
    const [{ runSyncBatchDeltaCheck }, { buildSyncBatchDeltaDeps }, { integrationRoot }, { integrationBranch }] =
      await Promise.all([
        import('../../release/sync-batch-delta-check'),
        import('../../release/sync-batch-delta-check-deps'),
        import('../../release-deploy-launch'),
        import('../../release/judged-sha-containment'),
      ]);
    const deps = buildSyncBatchDeltaDeps({
      installSlug: ctx.installSlug || home,
      workspaceId: ctx.workspaceId,
      root: integrationRoot(),
      branch: integrationBranch(),
    });
    await runSyncBatchDeltaCheck(deps);
  },
  // WI-10005745: spawns node scripts/affected-tests.mjs and test runs from the integration tree.
  { routineTimeoutMs: SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS, executesIntegrationTreeCode: true },
);
