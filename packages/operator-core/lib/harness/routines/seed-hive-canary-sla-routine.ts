/**
 * Seed the FAST hive-canary SLA sweep (EI-18170 recurrence-guard).
 *
 * One routine, `hive-canary-sla` → `system:hive-canary-sla`, every 15 minutes
 * (6-field cron `0 *\/15 * * * *`). The COMPLEMENT to the daily `hive-canary`
 * routine (seed-hive-canary-routine.ts): the daily check fires once/day with a 6h
 * deadline, so a canary the completion driver never touches was invisible for up
 * to ~24h AND only if the daily routine itself ran. This sweep flags today's
 * canary within ~SLA (default 30min) of creation, INDEPENDENT of any Mug/Queen
 * wake — closing the detector gap that let F-CANARY-20260720 sit open+untouched
 * with no standing alarm.
 *
 * Seeded ACTIVE by default: `system:hive-canary-sla` SELF-GATES on the canary
 * harness being registered (unregistered → clean no-op), so an active routine is
 * safe and goes live the moment the harness exists — finished work never ships
 * dark (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 *
 * The routine's install_slug IS the canary harness (default 'hive-canary';
 * override via POT_CANARY_HARNESS). payload_template tunable: `slaMinutes`
 * (default 30) — the fast completion SLA before an early-warning bug is filed.
 *
 *   tsx seed-hive-canary-sla-routine.ts              # seed ACTIVE
 *   tsx seed-hive-canary-sla-routine.ts --inactive   # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.POT_CANARY_HARNESS ?? process.env.HIVE_CANARY_HARNESS ?? 'hive-canary'; // legacy env name — dual-accept until callers migrate

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_hive_canary_sla`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, 'hive-canary-sla', 'cron',
            ${JSON.stringify({ cron: '0 */15 * * * *' })}::text::jsonb, 'system:hive-canary-sla',
            ${JSON.stringify({ slaMinutes: 30 })}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_config = EXCLUDED.trigger_config,
      target_role = EXCLUDED.target_role,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      updated_at = now()`;
  console.log(`[seed-hive-canary-sla] routine ${id} seeded (harness=${SLUG}, active=${active})`);
  await sql.end({ timeout: 5 });
}

void main();
