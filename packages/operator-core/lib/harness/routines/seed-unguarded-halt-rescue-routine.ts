/**
 * Seed the `unguarded-halt-rescue` routine — the SYSTEM-side leg of the
 * unguarded-halt guard (WI-6054, turn-end-tracking P-016; handler in
 * `unguarded-halt-rescue-action.ts`).
 *
 *   - `unguarded-halt-rescue` (every 5 min): sweep live presence with the
 *     EXISTING `boundedUnguardedHaltSweep` and WAKE agents that ended a turn
 *     under an autonomous mode with no armed loop and no registered await.
 *     Self-throttled to one rescue per agent per hour via its own outbox, and
 *     capped per tick so a mass halt recovers steadily.
 *
 * SEEDED ACTIVE by default (alpha policy: finished, non-destructive work ships
 * live). Unlike the headcount governor this opens NO new sessions — it only
 * re-wakes agents that already exist and would otherwise be stranded forever.
 * Pass `--inactive` to seed dark. Idempotent (upsert).
 *
 *   tsx seed-unguarded-halt-rescue-routine.ts              # seed ACTIVE
 *   tsx seed-unguarded-halt-rescue-routine.ts --inactive   # seed dark
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - throttle_min  (default 60)  — minutes between rescues of the same agent.
 *   - max_per_tick  (default 10)  — cap on wakes fired in one tick.
 *   - idle_min      (default 15)  — LOWER bound: minutes of no tool call before an
 *                                   agent counts as halted rather than mid-turn.
 *                                   Below this a long build/test run looks like a halt.
 *   - max_idle_min  (default 360) — UPPER bound: past this the session is ABANDONED,
 *                                   not halted, and is the reaper's job. Without it the
 *                                   sweep reaches the 6-9-day heartbeating population.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.UNGUARDED_HALT_RESCUE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 5 minutes — a halted agent is doing nothing, so recover it promptly;
 *  the per-agent throttle (not the cadence) is what bounds wake cost. */
const CRON = '0 */5 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'unguarded-halt-rescue';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    throttle_min: 60,
    max_per_tick: 10,
    idle_min: 15,
    max_idle_min: 360,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:unguarded-halt-rescue', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-unguarded-halt-rescue-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every 5 min, 60-min per-agent throttle, max 10 wakes/tick`,
  );
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error('[seed-unguarded-halt-rescue-routine] failed:', e);
  process.exitCode = 1;
});
