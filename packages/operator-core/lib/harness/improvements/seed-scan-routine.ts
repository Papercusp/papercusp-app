/**
 * RETIRED — the scheduled `scan` cadence is gone (sentinel-herald-2026-06-21 D-018 / P-023).
 *
 * This script used to seed the proactive `scan` launch routine (a 4-hourly
 * `system:blueprint-run { blueprintId: 'scan' }` cadence whose findings landed in the
 * self-improvement triage backlog). The OLD operator workspace-scan is retired: the
 * Queen is now the constant scanner/placer, and the Sentinel reads live workspace state
 * DIRECTLY (curation:state-of-pot / curation:feed / Overwatch compute-brief —
 * packages/operator-core/lib/sentinel/sentinel-context.ts), so a separate scheduled
 * "sweep + capture" surface is no longer run as a competing cadence.
 *
 * What stayed: the `scan` blueprint + its scanner role survive as an ON-DEMAND launch
 * (`system:blueprint-run { blueprintId: 'scan' }`) for a manual one-off sweep, and the
 * `improvements:capture` curation/triage path is UNCHANGED. Only the CLOCK is removed
 * (the blueprint's `triggers.schedule` was dropped, so nothing materializes the routine).
 *
 * Running this script now DEACTIVATES (does not re-create) any lingering `scan` routine —
 * a defensive, idempotent cleanup so an old seeded row can't tick. It NEVER arms a cadence;
 * the `--active` flag is intentionally gone. To bring a manual cadence back, re-add a
 * `triggers.schedule` entry to the scan blueprint (prefer `singleton: true` so it seeds
 * INACTIVE/dark) rather than reviving this seed.
 *
 *   tsx seed-scan-routine.ts            # deactivate any lingering scan routine (no-op if none)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SCAN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'scan';
  // Defensive cleanup: darken any old scan cadence row left behind by a prior seed.
  // No INSERT — the retired surface must never be (re-)created here.
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET active = false, updated_at = now()
     WHERE install_slug = ${SLUG} AND name = ${name} AND active = true
    RETURNING id
  `;
  console.log(
    `[seed-scan-routine] RETIRED (D-018). Scheduled scan cadence removed — the Mug scans ` +
      `and the Sentinel reads live state directly. ` +
      (rows.length
        ? `Deactivated a lingering "${name}" routine for "${SLUG}" (ws=${ws}).`
        : `No active "${name}" routine to deactivate for "${SLUG}" (ws=${ws}) — nothing to do.`),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-scan-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
