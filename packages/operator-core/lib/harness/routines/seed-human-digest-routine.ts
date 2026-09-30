/**
 * Seed the `improvement-human-digest` routine — the weekly owner drain ritual
 * over the human review queue (self-improvement-consume-edges-2026-06-12
 * P-022 / B-08; handler in `human-queue-digest-action.ts`).
 *
 *   - `improvement-human-digest` (weekly, Monday 13:30 UTC — offset from the
 *     Monday 13:00 token report so the two owner digests don't interleave):
 *     send the top-5 human-lane items ranked by blocking impact to the owner
 *     via the coord inbox + attention rails.
 *
 * SEEDED ACTIVE by default — the action is READ-ONLY (it ranks and notifies,
 * changes nothing), so there is no arming concern (alpha policy: finished work
 * never ships dark). Idempotent (upsert).
 *
 *   tsx seed-human-digest-routine.ts              # seed ACTIVE
 *   tsx seed-human-digest-routine.ts --inactive   # seed but leave the cron off
 *
 * trigger_config knobs (editable via the routines admin):
 *   - cron (default weekly Mon 13:30) — the drain cadence.
 *   - top_n (default 5) — how many items the digest leads with.
 *   - needs_human_stale_days (default 7) — remind once per work-item state
 *     episode after this many days in needs-human.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.IMPROVEMENT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const CRON = '0 30 13 * * 1'; // weekly, Monday 13:30 UTC

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'improvement-human-digest';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, top_n: 5, needs_human_stale_days: 7 };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:improvement-human-digest', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-human-digest-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `weekly top-5 blocking-impact digest of the human review queue (read-only). ` +
      (active ? 'Cron LIVE.' : 'Inactive — enable via the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-human-digest-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
