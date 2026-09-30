/**
 * Seed the `gate-fire-drill` routine (gate-verdict-liveness P-016) —
 * `system:gate-fire-drill` → `gate-fire-drill-action.ts`, the weekly drill that
 * kills a checkpoint run on purpose and asserts the P-003 verdict-liveness
 * alarms observed it.
 *
 * Weekly, Sunday 04:23:00 UTC-local — a quiet slot offset from green-checkpoint
 * (:15), cargo-test (:45) and sync-batch-delta (:02/5) tick minutes. The action
 * itself skips on a red gate, an in-flight run, a placed hold, or host load, so
 * the cadence is an upper bound; a skipped week records a skip outcome row.
 *
 * DURABLE (a cron `harness_shared.routines` row fired by routinesTick), NOT
 * ephemeral — a weekly period can exceed host uptime and would never fire from
 * an in-process timer (the sync-batch-delta seed's own precedent).
 *
 * Seeded ACTIVE by default (finished work never ships dark — CLAUDE.md): the
 * worst case of a live drill is one killed drill-launched run on a green idle
 * gate (seconds of suite time) plus one pipeline_events row. `--inactive` seeds
 * it off for an explicit dark launch.
 *
 *   tsx seed-gate-fire-drill-routine.ts             # seed ACTIVE
 *   tsx seed-gate-fire-drill-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.GATE_FIRE_DRILL_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** 6-field cron, second-first: weekly, Sunday 04:23:00. */
const CRON = '0 23 4 * * 0';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gate-fire-drill';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:gate-fire-drill', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gate-fire-drill-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `weekly (Sun 04:23) kill-a-run fire drill asserting the P-003 alarm chain. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gate-fire-drill-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
