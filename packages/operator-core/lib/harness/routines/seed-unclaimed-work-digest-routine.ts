/**
 * Seed the `unclaimed-work-digest` routine — the daily 9am stale-backlog
 * broadcast (platform-ops-batch-2026-07-09 P-001; handler in
 * `unclaimed-work-digest-action.ts`).
 *
 *   - `unclaimed-work-digest` (daily, 09:00 UTC): post a digest of currently
 *     unclaimed `papercusp` work-items (state todo, no assignee) to the
 *     coord feed (`to: ['*']`) so the fleet sees what is going stale.
 *
 * SEEDED ACTIVE by default — the action is READ-ONLY (it lists + broadcasts,
 * changes no state), so there is no arming concern (alpha policy: finished
 * work never ships dark). Idempotent (upsert).
 *
 *   tsx seed-unclaimed-work-digest-routine.ts              # seed ACTIVE
 *   tsx seed-unclaimed-work-digest-routine.ts --inactive   # seed but leave the cron off
 *
 * trigger_config knobs (editable via the routines admin):
 *   - cron (default daily 09:00 UTC) — the digest cadence. NOTE: this is UTC,
 *     not the owner's local time — flag+adjust the cron if a specific local
 *     9am is required (the routines engine has no per-owner timezone today).
 *   - harness (default 'papercusp') — which harness's backlog to digest.
 *   - top_n (default 10) — how many stale items the digest leads with.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

const SLUG = process.env.IMPROVEMENT_ROUTINE_SLUG ?? 'papercusp';
const CRON = '0 0 9 * * *'; // daily, 09:00 UTC

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'unclaimed-work-digest';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, harness: SLUG, top_n: 10 };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:unclaimed-work-digest', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-unclaimed-work-digest-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily 09:00 UTC unclaimed-backlog digest to the coord feed (read-only). ` +
      (active ? 'Cron LIVE.' : 'Inactive — enable via the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-unclaimed-work-digest-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
