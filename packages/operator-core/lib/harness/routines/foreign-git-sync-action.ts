/**
 * `system:foreign-git-sync` — the P-109 leg-(ii) COMMIT LANE routine
 * (p2p-work-distribution-2026-07-02; design doc §3, ratified Q3: a SEPARATE
 * routine, never a phase of the canonical git-sync tick — a wedged foreign
 * clone must never stall canonical sync, and pausing p2p (the P-002
 * kill-switch) pauses exactly this one routine).
 *
 * The handler is one durable step (system-actions contract) and safe to re-run
 * from the top: the underlying pass is idempotent — a clean foreign clone is
 * 'nothing', a replayed commit finds nothing staged, parking is a state upsert.
 *
 * SEEDING: `ensureForeignGitSyncRoutine` — called from the foreign-workspace
 * registration path (registerForeignWorkspace's consumer, P-104 spawn), so the
 * lane exists exactly when foreign work exists (P-005: activation is gated by
 * the real surface — no foreign workspaces ⇒ the tick no-ops).
 */
import { getOrgPg, upsertRoutine, type RoutineRow } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { runForeignGitSyncTick } from '../../p2p/foreign-git-sync';
import { computeNextFireAt } from './cron';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const FOREIGN_GIT_SYNC_ROUTINE_NAME = 'foreign-git-sync';
export const FOREIGN_GIT_SYNC_TARGET = 'system:foreign-git-sync';
/** Same cadence family as canonical git-sync (every 3 minutes). */
export const DEFAULT_FOREIGN_GIT_SYNC_CRON = '30 */3 * * * *';

registerSystemAction(FOREIGN_GIT_SYNC_ROUTINE_NAME, async (ctx: SystemActionCtx) => {
  const result = await runForeignGitSyncTick(ctx.workspaceId);
  if (result.workspaces.length) {
    const committed = result.workspaces.filter((w) => w.outcome.status === 'committed').length;
    const parked = result.workspaces.filter((w) => w.outcome.status === 'parked').length;
    const errored = result.workspaces.filter((w) => w.outcome.status === 'error').length;
    console.log(
      `[foreign-git-sync] ${result.workspaces.length} active workspace(s): ` +
        `${committed} committed, ${parked} parked, ${errored} errored`,
    );
  }
});

/**
 * Idempotent upsert of the workspace's foreign-git-sync routine (active).
 * Keyed per install slug like git-sync; one row drives the whole workspace's
 * foreign lane (the tick lists every active foreign workspace itself).
 */
export async function ensureForeignGitSyncRoutine(
  input: { workspaceId: string; installSlug: string; cron?: string },
  sql: Sql = getOrgPg().sql,
): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: FOREIGN_GIT_SYNC_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: { cron: input.cron ?? DEFAULT_FOREIGN_GIT_SYNC_CRON },
      targetRole: FOREIGN_GIT_SYNC_TARGET,
      active: true,
    },
    computeNextFireAt,
  );
}
