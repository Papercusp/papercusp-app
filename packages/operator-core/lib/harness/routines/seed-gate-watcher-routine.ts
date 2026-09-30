/**
 * Seed the `gate-watcher-tick` routine (owner-inbox-single-pane-2026-07-17
 * P-002; handler in `attention/gate-watch-action.ts`): tails
 * `~/.claude/projects/**.jsonl` for an unanswered AskUserQuestion/ExitPlanMode
 * tool_use (= blocked on the owner) into `session_pending_gates`. Pure FS+SQL —
 * spawns no agent, makes no network call. Every 2 minutes (tighter than the
 * 10-min interactive-usage-ingest cadence — a blocked session is time-sensitive
 * for the owner Inbox, not a background telemetry rollup).
 *
 * SEEDED INACTIVE by default (mirrors seed-token-telemetry-routines): the
 * routine engine that fires system actions runs on the GREEN `:3070` operator,
 * which won't know this action name until the staging→main deploy carries it —
 * seeding active before that just generates routine-failure watchdog noise.
 * Bring-up after the deploy:  `tsx seed-gate-watcher-routine.ts --active`  (or
 * flip `active` in the routines admin).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.GATE_WATCHER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const ROUTINE = {
  name: 'gate-watcher-tick',
  cron: '0 */2 * * * *',
  triggerConfig: { cron: '0 */2 * * * *' },
};

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron', ${JSON.stringify(ROUTINE.triggerConfig)}::text::jsonb,
            ${`system:${ROUTINE.name}`}, 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(`[seed-gate-watcher] seeded "${ROUTINE.name}" (ws=${ws}, cron="${ROUTINE.cron}", active=${active})`);
  if (!active) {
    console.log('[seed-gate-watcher] INACTIVE — activate after the green deploy carries the handler:');
    console.log(`  UPDATE harness_shared.routines SET active=true WHERE install_slug='${SLUG}' AND name='${ROUTINE.name}';`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gate-watcher] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
