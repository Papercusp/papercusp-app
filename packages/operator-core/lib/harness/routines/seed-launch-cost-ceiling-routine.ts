/**
 * Seed the `launch-cost-ceiling` routine (plan `agent-launch-context-cost-2026-09-18`,
 * P-009(c); decision D-016) — `system:launch-cost-ceiling` →
 * `launch-cost-ceiling-action.ts`, the standing watch on agent launch cost.
 *
 * WHY IT EXISTS. `scripts/measure-launch-cost.ts` was committed, correct, and already
 * exited 1 against a `--target` — and NOTHING RAN IT. Launch cost drifted 107,841 →
 * 305,926 median tokens between 2026-08-13 and 2026-09-17, and the only detector that
 * ever fired was the owner noticing that agents felt slow. The finding was then
 * independently re-derived four times across three epochs. A measurement nobody runs is
 * not a detector; this row is what makes it one.
 *
 * Every 6 hours at :23 HOST-LOCAL, not nightly. Launch cost is a fleet-wide tax paid by
 * every session that starts, so a 24h detection latency is itself expensive — the
 * 2026-09-11 step was live for four days before anyone noticed. Six-hourly bounds that
 * at a quarter-day while still being far cheaper than the thing it watches.
 *
 * Off the hour and off :15/:35/:45 on purpose: this box runs green-checkpoint at :15,
 * gitnexus-reindex at :35 and cargo-test at :45, and a routine that walks a transcript
 * tree has no reason to share a tick minute with any of them.
 *
 * `tier: 'durable'` because this is ONE measurement per period for the whole install. An
 * ephemeral row is armed per host by the per-host executor, so on a multi-host install
 * every host would re-scan the entire transcript tree and raise its own escalation for
 * the same fleet-wide number.
 *
 * Seeded ACTIVE by default. Finished work never ships dark (CLAUDE.md), and this is safe
 * from the moment it exists: it is read-only against every table, it only READS transcript
 * files, its escalation is debounced 24h through the shared fires ledger, and both alarming
 * legs carry a `<= 0` env kill switch (LAUNCH_COST_CEILING_TOKENS / LAUNCH_COST_REGRESSION_PCT).
 * Shipping THIS one dark would be a particularly bad joke: a detector left switched off is
 * the exact defect the plan it belongs to was written to fix.
 *
 *   tsx seed-launch-cost-ceiling-routine.ts             # seed ACTIVE
 *   tsx seed-launch-cost-ceiling-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_BASELINE_DAYS,
  DEFAULT_CEILING_TOKENS,
  DEFAULT_RECENT_DAYS,
  DEFAULT_REGRESSION_PCT,
} from './launch-cost-ceiling-action';

const SLUG = process.env.LAUNCH_COST_CEILING_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
export const LAUNCH_COST_CEILING_ROUTINE_NAME = 'launch-cost-ceiling';

/**
 * Every 6 hours at :23 host-local. NOT UTC: `computeNextFireAt` evaluates the crontab in
 * the host timezone (verified on the sibling census from its seeded row's next_fire_at
 * rather than assumed). Say local, mean local.
 */
const CRON = '0 23 */6 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = LAUNCH_COST_CEILING_ROUTINE_NAME;
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    recent_days: DEFAULT_RECENT_DAYS,
    baseline_days: DEFAULT_BASELINE_DAYS,
    ceiling_tokens: DEFAULT_CEILING_TOKENS,
    regression_pct: DEFAULT_REGRESSION_PCT,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:launch-cost-ceiling', 'skip', 'skip-old', ${active}, 'durable', now())
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
    `[seed-launch-cost-ceiling-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every 6h at :23 host-local; alarms on a >=${(DEFAULT_REGRESSION_PCT * 100).toFixed(0)}% median regression ` +
      `vs a ${DEFAULT_BASELINE_DAYS}d baseline, or a median at/over ${DEFAULT_CEILING_TOKENS.toLocaleString()} tokens. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-launch-cost-ceiling-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
