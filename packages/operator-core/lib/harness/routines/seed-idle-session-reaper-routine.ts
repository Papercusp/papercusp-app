/**
 * Seed the `idle-session-reaper` routine — P-011 (D-007); design in
 * `idle-session-reaper.ts`, handler in `idle-session-reaper-action.ts`.
 *
 *   - `idle-session-reaper` (hourly): mark DEAD-process open adv_sessions ended
 *     (owner dropped out of the liveness set past the grace window), reclaiming
 *     the live roster + unblocking session-dir-gc. SQL-only; spawns no agent,
 *     makes no network call.
 *
 * DOUBLE-GATED: the action is flag-gated DEFAULT-OFF (papercusp-idle-session-reaper),
 * and this routine is SEEDED INACTIVE. Bring-up is human-confirmed; idempotent
 * (upsert). Recommended bring-up order: `--active` with `dry_run` first to preview
 * the ghost set, then flip the flag, then drop dry_run.
 *
 *   tsx seed-idle-session-reaper-routine.ts            # seed INACTIVE
 *   tsx seed-idle-session-reaper-routine.ts --active   # seed + enable the hourly sweep
 *   tsx seed-idle-session-reaper-routine.ts --active --dry-run  # enable in preview mode
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - dry_run (default false) — plan + log but mark nothing.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.IDLE_SESSION_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :05 — cheap (one SELECT + a few UPDATEs); dead sessions accrue all day. */
const CRON = '0 5 * * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'idle-session-reaper';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, dry_run: dryRun };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:idle-session-reaper', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-idle-session-reaper-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
      `hourly reap of dead-process session rows. ` +
      (active
        ? 'Cadence LIVE (still flag-gated by papercusp-idle-session-reaper).'
        : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-idle-session-reaper-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
