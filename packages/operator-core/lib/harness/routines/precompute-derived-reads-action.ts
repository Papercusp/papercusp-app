/**
 * `system:precompute-derived-reads` — the cadence behind the derived-read
 * substrate (precompute-derived-sync-reads-2026-07-19 P-002, WI-5460).
 *
 * Runs every registered producer whose snapshot is past its ttl and writes the
 * result to `harness_shared.derived_read_snapshots`, so the sync resolvers for
 * `storage.usage` / `plans.lint` / `learning.soakReport` become plain SELECTs
 * instead of 20s/13.8s/27.3s inline computations on a user-facing read path.
 *
 * This is the thin registration seam only — all logic lives in
 * `lib/derived-reads/registry.ts` (reuse-first, mirroring `gc-plan-runs-action`).
 *
 * Replay-safe: `refreshDerivedReads` upserts idempotently and skips producers
 * whose snapshots are still fresh, so a recovery replay costs a few SELECTs
 * rather than re-running the expensive walks.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `force` — recompute regardless of ttl (backfill).
 *   - `only`  — array of producer keys to restrict this fire to.
 */
import { refreshDerivedReads } from '../../derived-reads/registry';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

// Importing the producer modules for side effect is what puts them in the
// registry. Without these the routine would fire and find nothing to do.
import '../../derived-reads/producers';

registerSystemAction('precompute-derived-reads', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const only = Array.isArray(cfg.only) ? (cfg.only as string[]).map(String) : undefined;
  const outcomes = await refreshDerivedReads({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    force: cfg.force === true,
    ...(only ? { only } : {}),
  });

  const refreshed = outcomes.filter((o) => o.refreshed);
  const failed = outcomes.filter((o) => o.error);
  const skipped = outcomes.filter((o) => o.skippedFresh);

  console.log(
    `[precompute-derived-reads] ${ctx.installSlug}: ` +
      `${refreshed.length} refreshed, ${skipped.length} still-fresh, ${failed.length} failed` +
      (refreshed.length
        ? ` — ${refreshed.map((o) => `${o.key} ${o.computeMs}ms`).join(', ')}`
        : ''),
  );
  for (const f of failed) {
    // A failure keeps the last-known-good payload serving; surface it loudly so
    // a permanently-failing producer is visible rather than silently stale.
    console.error(`[precompute-derived-reads] producer "${f.key}" FAILED: ${f.error}`);
  }
});
