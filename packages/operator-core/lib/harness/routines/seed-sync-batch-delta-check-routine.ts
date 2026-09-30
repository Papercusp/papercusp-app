/**
 * Seed the `sync-batch-delta-check` routine (gate-verdict-liveness P-012) —
 * `system:sync-batch-delta-check` → `sync-batch-delta-check-action.ts`, the
 * per-git-sync-batch affected-tests + typecheck sampler that keeps `staging`
 * near-green between hourly green-checkpoint verdicts.
 *
 * Every 5 minutes, offset to :02/:07/… so it never shares a tick minute with
 * green-checkpoint (:15), cargo-test (:45) or the other bespoke slots. The action
 * itself skips under host load and while a checkpoint suite is running, so the
 * cadence is an upper bound, not a promise of work.
 *
 * DURABLE (a cron `harness_shared.routines` row fired by routinesTick), NOT
 * ephemeral: an ephemeral row armed by a standalone tsx script only arms at
 * bg-host boot, which is exactly how `frozen-candidate-drift-sweep` sat at
 * `last_fired_at IS NULL` indefinitely (this file's own pure-module header, and
 * the corpus-term-df WI-1406487 precedent — a period that can exceed host uptime
 * NEVER fires from an in-process timer).
 *
 * Seeded ACTIVE by default: the action is read-only w.r.t. the repo (it runs
 * tests and files deduped work-items, never mutates source), self-gates to the
 * operator-home installSlug, and every unmeasurable leg resolves to doing LESS
 * work — finished work never ships dark (CLAUDE.md). `--inactive` seeds it off
 * for an explicit dark launch.
 *
 *   tsx seed-sync-batch-delta-check-routine.ts             # seed ACTIVE
 *   tsx seed-sync-batch-delta-check-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SYNC_BATCH_DELTA_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** 6-field cron, second-first: every 5 minutes at :02/:07/:12/… — offset from
 *  green-checkpoint (:15) and cargo-test (:45) tick minutes. */
const CRON = '0 2/5 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'sync-batch-delta-check';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb,
            'system:sync-batch-delta-check', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-sync-batch-delta-check-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `every 5 min (:02/5) sync-batch delta check over staging's new commits. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-sync-batch-delta-check-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
