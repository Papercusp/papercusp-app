/**
 * Seed the daily hive-canary routine (hive-loop-e2e-testing-2026-06-10 P-009).
 *
 * One routine, `hive-canary` → `system:hive-canary`, daily at 09:00 (6-field
 * cron). Seeded ACTIVE by default: the action SELF-GATES on the canary harness
 * being registered (unregistered → clean no-op), so an active routine is safe
 * and goes live the moment the harness exists — finished work never ships dark
 * (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 *
 * The routine's install_slug IS the canary harness (default 'hive-canary';
 * override via POT_CANARY_HARNESS). payload_template tunables:
 * `deadlineHours` (default 6), `title` (the trivial feature's title).
 *
 *   tsx seed-hive-canary-routine.ts              # seed ACTIVE
 *   tsx seed-hive-canary-routine.ts --inactive   # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.POT_CANARY_HARNESS ?? process.env.HIVE_CANARY_HARNESS ?? 'hive-canary'; // legacy env name — dual-accept until callers migrate

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_hive_canary`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, 'hive-canary', 'cron',
            ${JSON.stringify({ cron: '0 0 9 * * *' })}::text::jsonb, 'system:hive-canary',
            ${JSON.stringify({ deadlineHours: 6 })}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_config = EXCLUDED.trigger_config,
      target_role = EXCLUDED.target_role,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      updated_at = now()`;
  console.log(`[seed-hive-canary] routine ${id} seeded (harness=${SLUG}, active=${active})`);
  await sql.end({ timeout: 5 });
}

void main();
