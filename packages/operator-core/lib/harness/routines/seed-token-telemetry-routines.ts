/**
 * Seed the token-telemetry routines (token-usage-reduction-audit-2026-06-09
 * P-001/P-003; handlers in `interactive-usage/interactive-usage-action.ts` +
 * `token-report-action.ts`):
 *
 *   - `interactive-usage-ingest` (every 10 min): tail `~/.claude/projects/**.jsonl`
 *     assistant usage into `agent_usage_samples` (source='interactive'). Pure
 *     FS+SQL — spawns no agent, makes no network call.
 *   - `token-weekly-report` (Mondays 13:00 UTC ≈ 9am ET): broadcast the
 *     week-over-week token/spend rollup to coord. Pure SQL.
 *
 * SEEDED INACTIVE by default (mirrors seed-session-dir-gc-routine): the routine
 * engine that fires system actions runs on the GREEN `:3070` operator, which won't
 * know these action names until the staging→main deploy carries them — seeding
 * active before that just generates routine-failure watchdog noise. Bring-up after
 * the deploy:  `tsx seed-token-telemetry-routines.ts --active`  (or flip `active`
 * in the routines admin).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.TOKEN_TELEMETRY_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const ROUTINES = [
  {
    name: 'interactive-usage-ingest',
    cron: '0 */10 * * * *',
    triggerConfig: { cron: '0 */10 * * * *' },
  },
  {
    name: 'token-weekly-report',
    cron: '0 0 13 * * 1',
    triggerConfig: { cron: '0 0 13 * * 1', window_days: 7 },
  },
];

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  for (const r of ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify(r.triggerConfig)}::text::jsonb,
              ${`system:${r.name}`}, 'skip', 'skip-old', ${active}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
        -- re-seed must never clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
    console.log(`[seed-token-telemetry] seeded "${r.name}" (ws=${ws}, cron="${r.cron}", active=${active})`);
  }
  if (!active) {
    console.log('[seed-token-telemetry] INACTIVE — activate after the green deploy carries the handlers:');
    console.log(`  UPDATE harness_shared.routines SET active=true WHERE install_slug='${SLUG}' AND name IN ('interactive-usage-ingest','token-weekly-report');`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-token-telemetry] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
