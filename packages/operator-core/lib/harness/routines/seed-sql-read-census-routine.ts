/**
 * Seed the `sql-read-census` routine (plan `sql-escape-tool-routing-2026-08-12`,
 * P-008) — `system:sql-read-census` → `sql-read-census-action.ts`, the nightly
 * deterministic audit of raw-SQL reads against the tool-routing pair registry.
 *
 * Nightly at 04:17 HOST-LOCAL — which is 08:17 UTC on this box (EDT). Verified
 * rather than assumed: the seeded row came back with next_fire_at 08:17Z, so
 * `computeNextFireAt` evaluates the crontab in the host timezone, NOT in UTC. Say
 * local, mean local. (The census's own `ran_on` grain is a UTC calendar date via
 * utcDate() — a different clock, and deliberately so: the row is keyed by the day
 * it measures, not by the operator's wall time.)
 *
 * Off the hour and off :15/:35/:45 on purpose: the box runs
 * green-checkpoint at :15, gitnexus-reindex at :35 and cargo-test at :45, and a
 * census that reads a 7-day slice of `tool_invocations` has no reason to share a
 * tick minute with any of them.
 *
 * `tier: 'durable'` because the run WRITES durable state that a future night's
 * "did traffic fall after the routing row shipped" check reads back. An ephemeral
 * row is armed per host by the per-host executor, so on a multi-host install the
 * same night would be measured several times; the durable tier is claimed once
 * through `routinesTick`. (The write is idempotent anyway — but relying on the
 * idempotence instead of the tier would be relying on a repair rather than on not
 * needing one.)
 *
 * Seeded ACTIVE by default. Finished work never ships dark (CLAUDE.md), and this
 * is safe from the moment it exists: it is read-only against every table except
 * its own, its escalation leg is debounced through the shared fires ledger, and
 * both alarming legs carry a `<=0` env kill switch.
 *
 *   tsx seed-sql-read-census-routine.ts             # seed ACTIVE
 *   tsx seed-sql-read-census-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DEFAULT_CENSUS_WINDOW_DAYS } from './sql-read-census-action';

const SLUG = process.env.SQL_READ_CENSUS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
export const SQL_READ_CENSUS_ROUTINE_NAME = 'sql-read-census';
/**
 * 04:17 HOST-LOCAL nightly — clear of :15/:35/:45 and of the :00 cluster.
 * NOT UTC: `computeNextFireAt` evaluates the crontab in the host timezone, so on
 * this box (EDT) this fires at 08:17Z. Verified against the seeded row's
 * next_fire_at rather than assumed. Say local, mean local.
 */
const CRON = '0 17 4 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = SQL_READ_CENSUS_ROUTINE_NAME;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    window_days: DEFAULT_CENSUS_WINDOW_DAYS,
    agent_threshold: 10,
    grace_days: 14,
    required_fall_pct: 0.3,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:sql-read-census', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-sql-read-census-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `nightly 04:17 host-local (08:17Z here) census of dev:pg_query reads vs the routing pair registry. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-sql-read-census-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
