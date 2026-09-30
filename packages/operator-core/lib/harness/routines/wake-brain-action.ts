/**
 * system:wake-brain — retired pinned-brain routine tombstone.
 *
 * `psu --brain` was retired 2026-06-21. Keep this action registered so old
 * routine rows do not fail with "unknown action", but make it a no-op.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getBrainSession } from '../../brain-pin';

export const WAKE_BRAIN_ACTION = 'wake-brain';

/**
 * Resolve the pinned brain session's coord owner id (the inbox-wake target) for
 * `workspaceId`: the brain pin holds the brain's NATIVE session uuid
 * (brain-pin.ts), and `adv_sessions.session_id` carries that same uuid (mig 115)
 * joined to the session's `coord_owner_id`.
 *
 * Liveness is NOT gated here (EI-908): the wake-executor is the single
 * liveness-adaptive authority (inject a live session / resume a dead one
 * headless server-side / park an uninjectable one), so we return the owner
 * whenever the pin resolves to a tracked session and let the executor decide
 * how to deliver. Returns null only when no brain is pinned for the workspace
 * or the pinned session isn't tracked yet (no adv row — nothing to wake; the
 * launcher's own resolve handles a never-started pin). Exported for unit testing.
 */
export async function resolveBrainOwner(workspaceId: string): Promise<string | null> {
  const brainSessionId = await getBrainSession(workspaceId);
  if (!brainSessionId) return null;
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT s.coord_owner_id AS coord_owner_id
    FROM harness_shared.adv_sessions s
    WHERE s.session_id = ${brainSessionId} AND s.coord_owner_id IS NOT NULL
    ORDER BY s.started_at DESC
    LIMIT 1
  `;
  const row = rows[0] as { coord_owner_id?: string } | undefined;
  return row?.coord_owner_id ?? null;
}

registerSystemAction(WAKE_BRAIN_ACTION, async (ctx: SystemActionCtx) => {
  void ctx;
});
