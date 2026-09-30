/**
 * Seed the `gc-plan-runs` routine — WI-5273 (root cause: gc-plan-runs.ts's
 * `gcScheduledPlanRuns` existed fully built + tested since scheduled-recurring-
 * plans-2026-06-16 but was NEVER wired to a routine; handler in
 * `gc-plan-runs-action.ts`).
 *
 *   - `gc-plan-runs` (daily): sweep terminal scheduled-plan runs beyond the
 *     last-50-per-template / 90-day retention window, deleting each swept run's
 *     instance plan + transcript + frontier work-items. SQL-only; spawns no
 *     agent, makes no network call. Idempotent (a re-sweep of an already-GC'd
 *     run is a no-op).
 *
 * Confirmed live cost of NOT running this (2026-07-17): one 15-min scheduled
 * plan alone accrued 946 unbounded 'active' harness_plans rows over ~10.5 days.
 *
 * NOT flag-gated (pure retention housekeeping, same class as telemetry-retention
 * — no owner-authority surface, nothing destructive beyond what the plan's own
 * template already re-derives on the next fire). Seeded ACTIVE by default (unlike
 * idle-session-reaper/hetzner-orphan-frame-reaper, which gate on live-process or
 * billed-resource state a human should eyeball first) — this only ever touches
 * rows the *routine's own already-executed, terminal runs* produced, and the
 * defaults (keep last 50, 90 days) are generous. Idempotent upsert either way.
 *
 *   tsx seed-gc-plan-runs-routine.ts                    # seed + enable (default)
 *   tsx seed-gc-plan-runs-routine.ts --inactive          # seed but leave disabled
 *   tsx seed-gc-plan-runs-routine.ts --keep-last-n 100 --max-age-days 30
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - keep_last_n (default 50, gc-plan-runs.ts's KEEP_LAST_N_DEFAULT)
 *   - max_age_days (default 90, gc-plan-runs.ts's MAX_AGE_DAYS_DEFAULT)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.GC_PLAN_RUNS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at :12 past midnight UTC — cheap (a handful of SELECT/DELETEs); terminal
 *  scheduled-plan runs accrue continuously but a daily sweep is ample. */
const CRON = '0 12 0 * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const keepLastN = argNumber('--keep-last-n');
  const maxAgeDays = argNumber('--max-age-days');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gc-plan-runs';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(keepLastN ? { keep_last_n: keepLastN } : {}),
    ...(maxAgeDays ? { max_age_days: maxAgeDays } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:gc-plan-runs', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gc-plan-runs-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily sweep of terminal scheduled-plan runs beyond retention` +
      (keepLastN ? `, keep_last_n=${keepLastN}` : '') +
      (maxAgeDays ? `, max_age_days=${maxAgeDays}` : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gc-plan-runs-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
