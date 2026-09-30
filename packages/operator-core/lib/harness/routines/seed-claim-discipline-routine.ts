/**
 * Seed the `claim-discipline-watch` routine — the claim-before-work backstop
 * (claim-discipline-enforcement-2026-06-10; handler in
 * `claim-discipline-action.ts`).
 *
 *   - `claim-discipline-watch` (every 10 min): sweep fleet assignments for
 *     alive agents declared on a plan with no claim backing it; inject a coord
 *     nudge (never wake) teaching claim-on-wip / declare-intent items.
 *     Self-throttled to one nudge per agent per hour via its own outbox.
 *
 * SEEDED ACTIVE by default (alpha policy: finished, non-destructive work ships
 * live — a nudge spawns no agent, mutates no state, costs no wake). Pass
 * `--inactive` to seed dark. Idempotent (upsert).
 *
 *   tsx seed-claim-discipline-routine.ts              # seed ACTIVE
 *   tsx seed-claim-discipline-routine.ts --inactive   # seed dark
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - throttle_min (default 60) — minutes between nudges to the same agent.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.CLAIM_DISCIPLINE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 10 minutes — the cadence IS the grace period before a first nudge. */
const CRON = '0 */10 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'claim-discipline-watch';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, throttle_min: 60 };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:claim-discipline-watch', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-claim-discipline-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every 10 min, 60-min per-agent throttle`,
  );
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error('[seed-claim-discipline-routine] failed:', e);
  process.exitCode = 1;
});
