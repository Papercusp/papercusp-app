/**
 * Seed the readiness-drift monitor cadence — work-item-dependency-edges-2026-08-02 P-004.
 *
 *   - `readiness-drift-monitor` (hourly): run `reconcileReadiness` over the
 *     trigger-maintained `work_item_blocked` sidecar vs its oracle, log both drift
 *     directions, and repair by re-applying `sync_work_item_blocked` (the same
 *     function the wir_* triggers call) to the drifted keys. SQL-only, no LLM spend.
 *
 * ⚠ SEEDED **ACTIVE**, deliberately inverting the sibling seeds' inactive default.
 * The whole reason this exists is that the detector shipped in June with NO
 * production caller — `reconcileReadiness`'s only invoker in the tree was its own
 * integration test, so sidecar drift (including the direction that HANDS OUT BLOCKED
 * WORK) went unobserved for months. Seeding it inactive would reproduce that failure
 * exactly: a monitor that exists, is registered, and never runs. The repo rule is the
 * same — finished work does not ship dark. Pass `--inactive` to seed it parked.
 *
 * Idempotent (upsert); re-seeding preserves an owner-tuned payload shape.
 *
 *   tsx lib/scheduler/seed-readiness-drift-routine.ts              # seed ACTIVE (default)
 *   tsx lib/scheduler/seed-readiness-drift-routine.ts --inactive   # seed parked
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

const SLUG = process.env.READINESS_DRIFT_HARNESS ?? operatorHomeHarnessSlug(); // allow-scope-default: env-overridable operator-home routine install (no env ⇒ home hive, by design)
// Hourly at :37 — offset from the release rhythm (:00/:15/:30/:45) and from the
// existing learning cadences (gym :10/:40, iq-battery :20, negative-space :25,
// neologism :35, EKG :50) so a full-table reconcile never lands on a deploy minute.
// Hourly rather than per-minute because this is a set-based reconcile over the whole
// feature family, and rather than daily because the MISSING direction means the
// scheduler is actively serving blocked work — that should be caught in minutes, not
// discovered the next morning.
const ROUTINE = { name: 'readiness-drift-monitor', target: 'system:readiness-drift-monitor', cron: '0 37 * * * *' };
// `repair: false` turns the tick into detect-only (see readiness-drift-monitor-action).
const PAYLOAD: Record<string, unknown> = {};

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            ${JSON.stringify(PAYLOAD)}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-readiness-drift-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE hourly — reconciles work_item_blocked against its oracle and repairs drift.'
        : 'Inactive — the detector will NOT run; enable via the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-readiness-drift-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
