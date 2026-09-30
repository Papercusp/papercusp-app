/**
 * Seed the retired `wake-brain` routine tombstone.
 *
 * `psu --brain` was retired 2026-06-21. The action remains registered as a
 * no-op so old rows are harmless until a routine cleanup removes them.
 *
 *   tsx seed-wake-brain-routine.ts              # seed ACTIVE (flag still gates)
 *   tsx seed-wake-brain-routine.ts --inactive   # seed but leave the cron off
 *
 * trigger_config knobs (editable via the routines admin):
 *   - cron (default every 30 min) — the cadence; cost scales linearly with it
 *     (each fired wake = one billable Queen turn while the flag is on).
 *   - kickoff — override the wake's summary text (the Queen's tick prompt).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.WAKE_BRAIN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 30 minutes — a conservative default: ~48 Queen turns/day at most,
 *  and only while POT_AGENT_TABS is on AND a brain session is live. */
const CRON = '0 */30 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'wake-brain';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:wake-brain', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-wake-brain-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `the autonomous-Mug cadence (every 30 min; the wake fires only under POT_AGENT_TABS ` +
      `with a live pinned brain). ` +
      (active ? 'Cron LIVE (flag still gates the action).' : 'Inactive — enable via the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-wake-brain-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
