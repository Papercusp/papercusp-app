/**
 * `system:sweep-orphaned-foreign-harnesses` — the WI-1937 ephemeral-harness
 * ORPHAN-REGISTRY sweep (p2p-work-distribution-2026-07-02 / P-406 item 3).
 *
 * `sweepOrphanedEphemeralForeignHarnesses` (harness-registry.ts) removes an
 * ephemeral foreign-harness registry row whose backing `p2p_foreign_workspaces`
 * row is gone or already `reaped` — a LEAK left behind when the reap path's
 * deregister call was missed (e.g. a crash between the state transition and
 * the deregister). It was built + unit-tested (harness-registry.test.ts) but
 * never wired to a production schedule — this file closes that gap, mirroring
 * `foreign-git-sync-action.ts`'s registered-system-action + upsert-routine
 * pattern exactly (repo rule: no bare setInterval, no new scheduler).
 *
 * Scope note: this is ONLY the registry-row cleanup. It is NOT the same as
 * `superviseForeignSessions` (foreign-supervision.ts, P-104's H12/H13
 * liveness + orphan-ORIGIN wind-down enforcement) — that sweep's own doc
 * comment calls for a SEPARATE tier:ephemeral blueprint trigger
 * (`system:p2p-foreign-supervision`) with production deps (coord
 * cancel-signals, presence-gossip `originLastSeenAt`) that do not exist yet;
 * it is a larger, still-open gap tracked separately, not folded in here.
 *
 * The handler is one durable step (system-actions contract) and safe to
 * re-run from the top: the underlying sweep is idempotent (a clean registry
 * is 'nothing', a re-swept already-removed row is a no-op).
 *
 * SEEDING: `ensureSweepOrphanedForeignHarnessesRoutine` — call from the same
 * foreign-workspace registration path that seeds `foreign-git-sync`
 * (P-104 spawn / `registerEphemeralForeignHarness`'s consumer), so the sweep
 * exists exactly when foreign work exists (P-005: activation gated by the
 * real surface — no ephemeral foreign harnesses ⇒ the tick no-ops).
 */
import { getOrgPg, upsertRoutine, type RoutineRow } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { sweepOrphanedEphemeralForeignHarnesses } from '../../harness-registry';
import { getForeignWorkspaceByOffer } from '../../p2p/foreign-workspaces';
import { computeNextFireAt } from './cron';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const SWEEP_ORPHANED_FOREIGN_HARNESSES_ROUTINE_NAME = 'sweep-orphaned-foreign-harnesses';
export const SWEEP_ORPHANED_FOREIGN_HARNESSES_TARGET = 'system:sweep-orphaned-foreign-harnesses';
/** Same cadence family as foreign-git-sync / canonical git-sync (every 3 minutes) — a
 *  leaked row is cheap to leave around briefly; no need for a tighter cadence. */
export const DEFAULT_SWEEP_ORPHANED_FOREIGN_HARNESSES_CRON = '45 */3 * * * *';

registerSystemAction(SWEEP_ORPHANED_FOREIGN_HARNESSES_ROUTINE_NAME, async (ctx: SystemActionCtx) => {
  const result = await sweepOrphanedEphemeralForeignHarnesses(ctx.workspaceId, (offerId) =>
    getForeignWorkspaceByOffer(offerId),
  );
  if (result.swept) {
    console.log(
      `[sweep-orphaned-foreign-harnesses] ${result.swept} ephemeral foreign harness(es) inspected, ` +
        `${result.removed.length} orphaned row(s) removed` +
        (result.removed.length ? `: ${result.removed.join(', ')}` : ''),
    );
  }
});

/**
 * Idempotent upsert of the workspace's orphan-sweep routine (active). Keyed
 * per install slug like foreign-git-sync; one row drives the whole
 * workspace's ephemeral-foreign-harness registry (the tick lists every
 * ephemeral row itself — no per-offer seeding needed).
 */
export async function ensureSweepOrphanedForeignHarnessesRoutine(
  input: { workspaceId: string; installSlug: string; cron?: string },
  sql: Sql = getOrgPg().sql,
): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: SWEEP_ORPHANED_FOREIGN_HARNESSES_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: { cron: input.cron ?? DEFAULT_SWEEP_ORPHANED_FOREIGN_HARNESSES_CRON },
      targetRole: SWEEP_ORPHANED_FOREIGN_HARNESSES_TARGET,
      active: true,
    },
    computeNextFireAt,
  );
}
