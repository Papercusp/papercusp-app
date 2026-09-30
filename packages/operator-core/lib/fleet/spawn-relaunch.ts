/**
 * fleet/spawn-relaunch — the default RE-LAUNCH seam for the boot reconcile
 * (queen-bee-spawn-reclaim-relaunch-2026-06-22, EI-85 restart-kills).
 *
 * `reconcileSpawnAdmissionOnBoot` (spawn-reclaim.ts) settles every in-flight
 * queen/bee row left by a dead prior incarnation to `failed` (freeing the
 * concurrency-ceiling debit) — but reclaiming-to-`failed` LOSES the work: a queen
 * mid-orchestration and every bee it placed vanish on a host restart, doing zero
 * work until the next routine cadence re-fires the queen. This module supplies the
 * INJECTED `relaunch` fn that re-fires a reclaimed spawn whose durable work-item is
 * still non-terminal, so a queen/bee survives ANY host restart:
 *
 *   • a `queen` → re-fire the `coding` hive blueprint for its workspace
 *     (`fireLaunchBlueprint`), the same root Queen-wake the `system:blueprint-run`
 *     routine fires — only sooner, closing the restart→next-tick gap.
 *   • a `bee`  → re-place it onto its work-item (`spawnAgentInHarness role:'bee'`),
 *     carrying its parent lineage / brief / model so the new bee is equivalent.
 *
 * Kept OUT of spawn-reclaim.ts on purpose: that module is a pure-sql unit with no
 * heavy imports, and the reconcile takes this as an opts.relaunch seam so the
 * integration test drives the branch logic without a live operator. Flag-gated
 * (SPAWN_RECLAIM_RELAUNCH) by the caller (host-bootstrap) — flag OFF ⇒ no seam is
 * passed ⇒ the legacy reclaim-only behaviour, byte-identical.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { FEATURE_NON_REQUEUE_STATES } from '../work-item-dispatch-states';
import { runWithWorkspace } from '../workspace-als';
import type { RelaunchableSpawn } from './spawn-reclaim';

/** The hive (Queen) launch blueprint id — what `system:blueprint-run` fires for a
 *  kind:'hive' home (the queen `run_id` is `blueprint-run:<ws>:coding:<ts>`). */
const HIVE_BLUEPRINT_ID = 'coding';

async function releaseReclaimedSpawnClaim(spawn: RelaunchableSpawn & { workItemId: string }): Promise<void> {
  const { sql } = getOrgPg();
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET taken_by = NULL,
           taken_at = NULL,
           last_progress_at = NULL,
           status = CASE WHEN status <> ALL(${nonRequeue}::text[]) THEN 'todo' ELSE status END,
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${spawn.workspaceId}
       AND harness_slug = ${spawn.harnessSlug}
       AND feature_id = ${spawn.workItemId}
       AND taken_by = ${spawn.spawnId}`;
}

/**
 * Re-launch a single reclaimed queen/bee. Returns `true` when the re-fire was
 * accepted (a fresh `running` row now holds the work), `false` when it declined /
 * could not be placed (the reconcile then leaves the row reclaimed-`failed`; the
 * next cadence tick / Queen wake re-places it). Best-effort by contract — never
 * throws past the reconcile's own try/catch, but the reconcile also guards.
 */
export interface RelaunchReclaimedSpawnOptions {
  kickoff?: string;
  idempotencyKeyPrefix?: string;
}

export async function relaunchReclaimedSpawn(
  spawn: RelaunchableSpawn,
  opts: RelaunchReclaimedSpawnOptions = {},
): Promise<boolean> {
  // Resolve under the spawn's workspace so the queen-brief / agent-config / tier
  // reads (which read the workspace ALS) target the right hive.
  return runWithWorkspace(spawn.workspaceId, async () => {
    if (spawn.childRole === 'mug') {
      const { fireLaunchBlueprint } = await import('../blueprint/launch-blueprint');
      const { spawn: info } = await fireLaunchBlueprint(HIVE_BLUEPRINT_ID, {
        installSlug: spawn.harnessSlug,
        workspaceId: spawn.workspaceId,
        kickoff:
          opts.kickoff ??
          `Re-launched by the boot spawn-reclaim reconcile after a host restart killed the prior Mug ` +
            `(EI-85) — resume hive orchestration for '${spawn.harnessSlug}'.`,
      });
      // A root Queen launch returns a spawn correlation (durable workflow id or a
      // fire-and-forget spawnId); a null spawn means the fire seam surfaced nothing
      // but still dispatched — treat a resolved fire as accepted.
      return info != null;
    }
    if (spawn.childRole === 'cup') {
      // A bee with no work-item never reaches here (shouldRelaunchReclaimedSpawn
      // filters it), but guard so a null can never spawn a featureless bee.
      if (!spawn.workItemId) return false;
      const { claimWorkItem, releaseWorkItem } = await import('../work-items');
      const { spawnAgentInHarness } = await import('./operator-spawn');
      const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await releaseReclaimedSpawnClaim({ ...spawn, workItemId: spawn.workItemId });
      const claim = await claimWorkItem(spawn.workItemId, spawnId, { harness: spawn.harnessSlug });
      if (!claim) return false;
      const res = await spawnAgentInHarness({
        // Descriptive attribution for the observe-only governor receipt (D-011).
        // Recovery machinery — P-009 onward; a blocking admit here would delay a
        // relaunch, so this caller's live share is load-bearing for Phase 3.
        spawnCaller: 'fleet/spawn-relaunch',
        workspaceId: spawn.workspaceId,
        harness: spawn.harnessSlug,
        role: 'cup',
        spawnId,
        featureId: spawn.workItemId,
        itemId: spawn.workItemId,
        planSlug: spawn.planSlug,
        brief: spawn.brief,
        modelSpec: spawn.modelSpec,
        parentSpawnId: spawn.parentSpawnId,
        parentRole: spawn.parentRole ?? 'mug',
        turnTrigger: 'coord-wake',
        // Idempotency: a re-run of the boot reconcile (it is safe to re-run) must
        // not place a SECOND bee on the same item — key the placement on the dead
        // spawn id so a duplicate re-fire dedups to the first relaunch.
        idempotencyKey: `${opts.idempotencyKeyPrefix ?? 'boot-relaunch'}:${spawn.spawnId}`,
      });
      if (!res.ok) {
        await releaseWorkItem(spawn.workItemId, { harness: spawn.harnessSlug }).catch(() => {});
      }
      return res.ok === true;
    }
    return false;
  });
}
