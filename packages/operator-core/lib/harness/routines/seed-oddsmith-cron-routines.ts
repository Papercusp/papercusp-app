/**
 * Seed the three oddsmith cron→routine migrations
 * (scheduling-and-liveness-source-of-truth-2026-08-31 P-005):
 *
 *   - `oddsmith-paper-cycle`          → `system:oddsmith-paper-cycle`          (every 15 min)
 *   - `oddsmith-error-triage-ingest`  → `system:oddsmith-error-triage-ingest`  (every 14 min)
 *   - `oddsmith-error-triage-autofix` → `system:oddsmith-error-triage-autofix` (every 3h at :17)
 *
 * Same cadences as the crontab lines they replace
 * (`apps/desktop/scripts/{paper,error-triage}-cron.sh` in the oddsmith repo).
 * Seeded ACTIVE by default — this migration is a strict improvement (the
 * routines engine's own liveness/error tracking replaces a hand-rolled
 * streak-file alarm), so shipping it dark would leave the crontab lines as the
 * only real schedule. `--inactive` seeds all three off for an explicit dark
 * launch/review window.
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every
 * routine in this dir) — active is intentionally NOT re-applied on conflict,
 * so a re-run never clobbers an operator's runtime pause/resume.
 *
 *   tsx seed-oddsmith-cron-routines.ts              # seed all three ACTIVE
 *   tsx seed-oddsmith-cron-routines.ts --inactive   # seed all three dark
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { ODDSMITH_HARNESS_SLUG } from './oddsmith-cron-shared';

interface Seed {
  name: string;
  targetRole: string;
  cron: string; // 6-field: sec min hour dom mon dow
}

const SEEDS: Seed[] = [
  { name: 'oddsmith-paper-cycle', targetRole: 'system:oddsmith-paper-cycle', cron: '0 */15 * * * *' },
  { name: 'oddsmith-error-triage-ingest', targetRole: 'system:oddsmith-error-triage-ingest', cron: '0 */14 * * * *' },
  { name: 'oddsmith-error-triage-autofix', targetRole: 'system:oddsmith-error-triage-autofix', cron: '0 17 */3 * * *' },
];

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  for (const seed of SEEDS) {
    const id = `rt_${ODDSMITH_HARNESS_SLUG}_${seed.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const triggerConfig = JSON.stringify({ cron: seed.cron });
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (
        ${id}, ${ODDSMITH_HARNESS_SLUG}, ${ws}, ${seed.name}, 'cron',
        ${triggerConfig}::text::jsonb, ${seed.targetRole},
        'skip', 'skip-old', ${active}, now()
      )
      ON CONFLICT (install_slug, name) DO UPDATE SET
        trigger_kind   = EXCLUDED.trigger_kind,
        trigger_config = EXCLUDED.trigger_config,
        target_role    = EXCLUDED.target_role,
        -- active intentionally NOT re-applied on conflict: a re-seed must never
        -- clobber an operator's runtime pause/resume of this routine.
        workspace_id   = EXCLUDED.workspace_id,
        updated_at     = now()
    `;
    console.log(`[seed-oddsmith-cron-routines] seeded "${seed.name}" (id=${id}, cron="${seed.cron}", active=${active})`);
  }
  console.log(
    active
      ? '[seed-oddsmith-cron-routines] all three seeded ACTIVE — restart papercup-bg-host to live-arm on a host that was already up.'
      : '[seed-oddsmith-cron-routines] all three seeded inactive — enable via the routines admin or re-run without --inactive.',
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-oddsmith-cron-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
