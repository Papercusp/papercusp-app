/**
 * Seed the `idle-backend-reaper` routine (plan `on-demand-local-inference-lifecycle-2026-08-17`,
 * P-007) — `system:idle-backend-reaper` → `idle-backend-reaper-action.ts`, the sweep that stops
 * on-demand local inference backends idle past their TTL.
 *
 * EVERY 2 MINUTES, at :07 seconds. The cadence is derived, not picked: the reaper's watermark is
 * SAMPLED, so a request that starts and finishes between two polls is invisible to it. The
 * reaper itself refuses to be judged on fewer than 4 samples per TTL, and the default TTL is
 * 1800s — so the interval must sit at or under 450s. 120s gives 15 samples per default TTL, with
 * room for a caller that sets a much shorter per-backend TTL (down to 480s) before the reaper
 * starts warning. The :07 offset keeps it off the top-of-minute cluster.
 *
 * `tier: 'durable'` because the sweep STOPS PROCESSES and writes a shared watermark. An
 * ephemeral row is armed per host by the per-host executor, so on a multi-host install every
 * host would race to stop the same unit; the durable tier is claimed once through `routinesTick`.
 *
 * Seeded ACTIVE. Finished work never ships dark (CLAUDE.md), and this is safe from the moment it
 * exists for a reason stronger than care: its working set is `enabled AND lifecycle='on-demand'`,
 * and there are currently NO such rows — every live backend is 'always-on', which migration 843
 * made the default precisely so that shipping this could not reap anything by surprise. The
 * first backend it can ever act on is the one P-008 deliberately converts, after start-on-demand
 * works. Until then this sweep is a no-op that logs "nothing to sweep".
 *
 *   tsx seed-idle-backend-reaper-routine.ts             # seed ACTIVE
 *   tsx seed-idle-backend-reaper-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DEFAULT_IDLE_TTL_SEC } from './idle-backend-reaper-action';

const SLUG = process.env.IDLE_BACKEND_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
export const IDLE_BACKEND_REAPER_ROUTINE_NAME = 'idle-backend-reaper';
/** sec min hour dom mon dow — every 2 minutes at :07. See the header for why 2 minutes. */
const CRON = '7 */2 * * * *';
const POLL_INTERVAL_SEC = 120;

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = IDLE_BACKEND_REAPER_ROUTINE_NAME;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    // Handed to the reaper so it can detect its OWN misconfiguration — it warns when a
    // backend's TTL is too short to be judged at this cadence.
    poll_interval_sec: POLL_INTERVAL_SEC,
    default_idle_ttl_sec: DEFAULT_IDLE_TTL_SEC,
    dry_run: false,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:idle-backend-reaper', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a re-seed must
      -- never clobber an operator's runtime pause/resume.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-idle-backend-reaper-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every 2min at :07, default idle TTL ${DEFAULT_IDLE_TTL_SEC}s. ` +
      `Working set is enabled AND lifecycle='on-demand'; with no such rows yet this is a logging no-op. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-idle-backend-reaper-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
