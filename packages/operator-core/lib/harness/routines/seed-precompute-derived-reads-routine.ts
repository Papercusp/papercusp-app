/**
 * Seed the `precompute-derived-reads` routine
 * (precompute-derived-sync-reads-2026-07-19 P-002, WI-5460; handler in
 * `precompute-derived-reads-action.ts`).
 *
 *   - `precompute-derived-reads` (every 2 min): run each registered derived-read
 *     producer whose snapshot is past its ttl and write the result to
 *     `harness_shared.derived_read_snapshots`, so the sync resolvers for
 *     `storage.usage` / `plans.lint` / `learning.soakReport` / the `dev.*`
 *     diagnostics are plain SELECTs.
 *
 * The 2-minute cron is the FLOOR on freshness; each producer's own ttl decides
 * whether it actually recomputes on a given fire (storage 30m, plans.lint 6h,
 * soakReport/deployState/gitPipelineHives 5-10m, serviceHealth 90s). So a cheap
 * tick that finds everything fresh costs a handful of SELECTs, while the one
 * liveness-sensitive producer (serviceHealth) refreshes on essentially every
 * tick — the short cadence exists for it.
 *
 * NOT flag-gated at the routine level (the read side carries
 * FLAGS.PRECOMPUTE_DERIVED_READS as its kill-switch). Seeded ACTIVE by default,
 * same class as gc-plan-runs: pure derived-data maintenance that spawns no agent,
 * makes no network call, and writes only to its own snapshot table. Idempotent —
 * every write is an upsert, and a fresh snapshot is skipped.
 *
 *   tsx seed-precompute-derived-reads-routine.ts             # seed + enable (default)
 *   tsx seed-precompute-derived-reads-routine.ts --inactive  # seed but leave disabled
 *   tsx seed-precompute-derived-reads-routine.ts --backfill  # also force one immediate refresh
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PRECOMPUTE_DERIVED_READS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 2 minutes. Per-producer ttl governs the actual recompute rate. */
const CRON = '0 */2 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const backfill = process.argv.includes('--backfill');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'precompute-derived-reads';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };

  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:precompute-derived-reads', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-precompute-derived-reads-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `2-min sweep of registered derived-read producers.`,
  );

  if (backfill) {
    // Populate the snapshots NOW so the first page load after a deploy reads a
    // filled table rather than an empty one waiting on the first cron fire.
    const { refreshDerivedReads } = await import('../../derived-reads/registry');
    await import('../../derived-reads/producers');
    const outcomes = await refreshDerivedReads({ workspaceId: ws, harnessSlug: SLUG, force: true });
    for (const o of outcomes) {
      console.log(
        `[seed-precompute-derived-reads-routine] backfill ${o.key}: ` +
          (o.error ? `FAILED — ${o.error}` : `${o.computeMs}ms`),
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-precompute-derived-reads-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
