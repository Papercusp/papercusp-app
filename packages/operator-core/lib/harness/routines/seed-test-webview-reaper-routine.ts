/**
 * Seed the `test-webview-reaper` routine — WI-345 (F12),
 * infra-perf-reliability-audit-round3-2026-06-19 P-013.
 * Handler: `test-webview-reaper-action.ts`.
 * Core logic: `test-desktop-reaper.ts`.
 *
 * What it does (every 5 minutes):
 *   1. DETECTION: scan /proc for Playwright/headless-flagged runaway browsers +
 *      zombie pile; emit a toast on alarm. Always runs when the routine is active.
 *   2. KILL: find papercusp-desktop processes whose PAPERCUSP_ADV_SESSION_ID
 *      adv_session is ENDED (≥2 min old), SIGTERM→SIGKILL them and their
 *      WebKitWebProcess children. Gated by the TEST_WEBVIEW_REAPER flag (default ON).
 *
 * DOUBLE-GATED: this routine is SEEDED INACTIVE. Bring-up flow:
 *   1. tsx seed-test-webview-reaper-routine.ts             # seed INACTIVE
 *   2. tsx seed-test-webview-reaper-routine.ts --dry-run --active  # preview kills
 *   3. Review logs for any unexpected targets.
 *   4. tsx seed-test-webview-reaper-routine.ts --active   # arm the live reaper
 *
 * Idempotent (upsert). --active and --dry-run are independent flags.
 *
 *   tsx seed-test-webview-reaper-routine.ts                   # seed INACTIVE
 *   tsx seed-test-webview-reaper-routine.ts --active           # seed + enable
 *   tsx seed-test-webview-reaper-routine.ts --active --dry-run # enable in preview mode
 *
 * trigger_config knobs (editable via the routines admin):
 *   - dry_run (default false) — detect + log but kill nothing.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.TEST_WEBVIEW_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 5 minutes — frequent enough to catch leaked desktops quickly, cheap
 *  (a /proc scan + at most a few PG lookups + targeted SIGTERMs). */
const CRON = '0 */5 * * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const dryRun = process.argv.includes('--dry-run');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'test-webview-reaper';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, dry_run: dryRun };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:test-webview-reaper', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role    = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active         = EXCLUDED.active,
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-test-webview-reaper-routine] seeded "${name}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
      `every-5-min scan + kill of leaked agent-spawned Tauri/WebKit desktops. ` +
      (active
        ? `Cadence LIVE${dryRun ? ' (dry-run — detection only)' : ' (KILL ARMED — will SIGKILL leaked desktops)'}. ` +
          'See test-webview-reaper-action.ts + test-desktop-reaper.ts for the safety model.'
        : 'Inactive — enable with --active (preview first with --dry-run).'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      '[seed-test-webview-reaper-routine] FAILED:',
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  });
