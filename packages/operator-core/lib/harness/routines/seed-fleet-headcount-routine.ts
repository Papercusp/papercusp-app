/** Seed the WI-2479 fleet headcount governor cadence. The action is additionally
 * dark-flagged, so a routine row alone can never launch agents. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.FLEET_HEADCOUNT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'fleet-headcount-governor';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron',
            ${JSON.stringify({ cron: '*/1 * * * * *' })}::text::jsonb,
            'system:fleet-headcount-governor', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_config = EXCLUDED.trigger_config,
      target_role = EXCLUDED.target_role,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(`[seed-fleet-headcount-routine] seeded ${name} for ${SLUG} (active=${active})`);
  await sql.end({ timeout: 5 });
}

void main();
