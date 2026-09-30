/**
 * Seed the `session-dir-gc` routine — the per-session isolation-dir janitor (the
 * EI-155 follow-on; design in `session-dir-gc.ts`, handler in
 * `session-dir-gc-action.ts`).
 *
 *   - `session-dir-gc` (daily 04:30): sweep `session-claude/`, `session-mcp/`,
 *     the codex homes; remove the dirs of not-live, not-resumable sessions past
 *     the retention window. Pure filesystem maintenance — spawns no agent, makes
 *     no network call.
 *
 * SEEDED INACTIVE by default (mirrors seed-improvement-routines / seed-scan).
 * Bring-up is human-confirmed; idempotent (upsert).
 *
 *   tsx seed-session-dir-gc-routine.ts             # seed INACTIVE
 *   tsx seed-session-dir-gc-routine.ts --active     # seed + enable the daily sweep
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - retention_days (default 7) — collect a dir unmaterialized this long.
 *   - dry_run (default false)     — plan + log but remove nothing.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SESSION_DIR_GC_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 04:30 — off the busy hours; the sweep is cheap (a stat + a few rm). */
const CRON = '0 30 4 * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'session-dir-gc';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // No retention_days knob (session-db-archive-retire-dirs P-012): the action
  // now picks retention by the SESSION_ARCHIVE_AT_END flag (24h lossless /
  // 7d legacy). NOTE the daily cadence is CODE-OWNED in dbos/periodic-workflows
  // (sessionDirGc, 04:35) — this seeded routine is a manual/admin lever only,
  // which is why it stays INACTIVE by default.
  const triggerConfig = { cron: CRON };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:session-dir-gc', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-session-dir-gc-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily sweep of stale per-session isolation dirs (retention 7d). ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-session-dir-gc-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
